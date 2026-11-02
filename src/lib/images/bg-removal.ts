// Optional background removal in the browser (D-034). @imgly/background-removal
// (AGPL-3.0) runs a segmentation model on the CPU through onnxruntime-web. The
// wasm runtime and its loader are served by this app (they run as code in its
// origin, D-081); the model, which is data, comes from IMG.LY's CDN
// (staticimgly.com). Both are fetched on first use and come from the browser's
// HTTP cache afterwards, except the small resources.json manifest, which is
// revalidated on each use (D-101); the photo itself never leaves the device
// for this step. Client components import this module and
// server code never does. The library is imported only inside
// removeBackgroundFromUrl, so it stays out of every page's initial JavaScript,
// and module scope touches no browser API, so an importing client component
// still renders on the server.
//
// The second half saves a cut-out: a client token from /api/blob/upload, a
// direct put() to Blob (the shared blob-upload-client), then POST
// /api/items/[id]/nobg.

import type { Config } from "@imgly/background-removal";

import { BG_REMOVAL_ASSET_PATH, BG_REMOVAL_FILE_BYTES } from "@/lib/images/bg-removal-assets";
import {
  blobErrorMessage,
  postJson,
  progressUntilSettled,
  requestClientToken,
  unexpectedResponse,
  type FetchLike,
  type PutBlobLike,
} from "@/lib/images/blob-upload-client";
import {
  ITEM_API,
  NobgDataSchema,
  nobgUploadPathname,
  resultSchema,
  UPLOAD_LIMITS,
  type BlobClientPayload,
  type NobgBody,
  type NobgData,
} from "@/lib/items/contracts";
import { AppError, err, type Result } from "@/lib/result";

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Uncompressed sizes of the files a CPU run fetches, as the served
 * resources.json lists them and the library's fetch progress reports them:
 * the isnet_quint8 model, ort-wasm-simd-threaded.wasm and its .mjs loader.
 */
export const BG_DOWNLOAD_BYTES = BG_REMOVAL_FILE_BYTES.model + BG_REMOVAL_FILE_BYTES.wasm + BG_REMOVAL_FILE_BYTES.mjs;

/**
 * What a cold first run transfers at most, for the confirmation copy: the
 * uncompressed total (57 MB). A compressed wasm transfer is somewhat smaller.
 */
export const BG_MODEL_DOWNLOAD_MB = Math.round(BG_DOWNLOAD_BYTES / 1_000_000);

export const COMPUTE_STEPS = ["decode", "inference", "mask", "encode"] as const;
export type ComputeStep = (typeof COMPUTE_STEPS)[number];

export type BgRemovalProgress =
  /** Model and runtime files: from the CDN on first use, from the HTTP cache later. */
  | { stage: "download"; percent: number }
  | { stage: "process"; step: ComputeStep; percent: number };

export type RemoveBackgroundOptions = {
  onProgress?: (progress: BgRemovalProgress) => void;
  /** Stops waiting and rejects with the signal's reason; see removeBackgroundFromUrl. */
  signal?: AbortSignal;
};

type ProgressSink = (key: string, current: number, total: number) => void;

function isComputeStep(value: string): value is ComputeStep {
  return (COMPUTE_STEPS as readonly string[]).includes(value);
}

function toPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/**
 * Turns the library's progress callbacks into stages. Downloads arrive per
 * file ("fetch:/models/isnet_quint8", then the wasm and its loader, one after
 * the other), so their bytes are summed against the known total rather than
 * restarting at 0% for each file. Compute steps arrive as
 * "compute:<step>" with current/total out of 4.
 */
export function createProgressTracker(onProgress: (progress: BgRemovalProgress) => void): ProgressSink {
  const downloads = new Map<string, { current: number; total: number }>();
  return (key, current, total) => {
    if (key.startsWith("fetch:")) {
      downloads.set(key, { current, total });
      let done = 0;
      let known = 0;
      for (const entry of downloads.values()) {
        done += entry.current;
        known += entry.total;
      }
      onProgress({ stage: "download", percent: toPercent(done / Math.max(known, BG_DOWNLOAD_BYTES)) });
      return;
    }
    const step = key.startsWith("compute:") ? key.slice("compute:".length) : "";
    if (isComputeStep(step)) {
      onProgress({ stage: "process", step, percent: toPercent(total > 0 ? current / total : 0) });
    }
  };
}

// The library memoizes its model session by JSON.stringify(config), and the
// memoized config keeps the progress function of the first call, so a callback
// passed per call would only ever reach the first caller. One stable function
// is passed instead, and it forwards to whichever run is active.
let activeSink: ProgressSink | null = null;

function forwardProgress(key: string, current: number, total: number): void {
  activeSink?.(key, current, total);
}

/**
 * device "cpu" without COOP/COEP headers, so onnxruntime runs single-threaded
 * on the main thread (D-034); "isnet_quint8" is the small model the spike
 * recommends. publicPath is added per run (bgRemovalConfig), because it must
 * be an absolute URL and module scope must not touch `location`.
 */
export const BG_REMOVAL_CONFIG = {
  device: "cpu",
  model: "isnet_quint8",
  output: { format: "image/png", quality: 0.8 },
  progress: forwardProgress,
} satisfies Config;

/**
 * The config for one run: the files come from this app's resources.json
 * (D-081), never from the library's default CDN path, whose runtime loader
 * would run as script in this origin. The value is the same on every call
 * for an origin, so the library's memoisation by JSON.stringify(config) still
 * reuses its session.
 */
export function bgRemovalConfig(origin: string): Config {
  return { ...BG_REMOVAL_CONFIG, publicPath: new URL(BG_REMOVAL_ASSET_PATH, origin).href };
}

// Runs one at a time: inference occupies the main thread, and the progress
// forwarding above assumes a single active run.
let queue: Promise<unknown> = Promise.resolve();

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function loadFailed(cause: unknown): AppError {
  return new AppError("UPSTREAM", "Could not load the photo. Check your connection and try again.", undefined, {
    cause,
  });
}

async function fetchSource(url: string, signal: AbortSignal | undefined): Promise<Blob> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError("UPSTREAM", `Could not load the photo (HTTP ${response.status}). Try again.`);
    }
    return await response.blob();
  } catch (error) {
    if (error instanceof AppError || isAbortError(error)) throw error;
    throw loadFailed(error);
  }
}

async function loadLibrary() {
  try {
    return await import("@imgly/background-removal");
  } catch (error) {
    throw new AppError(
      "UPSTREAM",
      "Background removal could not be loaded. Check your connection and reload the page.",
      undefined,
      { cause: error },
    );
  }
}

async function runOnce(url: string, options: RemoveBackgroundOptions): Promise<Blob> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();

  const sink = createProgressTracker((progress) => {
    if (!signal?.aborted) onProgress?.(progress);
  });
  activeSink = sink;
  try {
    const source = await fetchSource(url, signal);
    const { removeBackground } = await loadLibrary();
    try {
      return await removeBackground(source, bgRemovalConfig(location.origin));
    } catch (error) {
      // The library also memoizes a failed model download, so only a reload
      // starts a fresh one.
      throw new AppError("UPSTREAM", "Background removal failed. Reload the page and try again.", undefined, {
        cause: error,
      });
    }
  } finally {
    if (activeSink === sink) activeSink = null;
  }
}

/** Settles with `promise`, or rejects with the signal's reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Removes the background of the image at `url` (a public Blob URL, which
 * answers CORS GETs) and resolves to a PNG Blob with real alpha. Runs queue
 * behind each other. Failures reject with an AppError.
 *
 * Aborting rejects at once with the signal's reason and stops all further
 * progress callbacks. The library cannot be interrupted, so a run already
 * inside the model finishes in the background and the next run waits for it.
 */
export function removeBackgroundFromUrl(url: string, options: RemoveBackgroundOptions = {}): Promise<Blob> {
  const run = queue.then(() => runOnce(url, options));
  queue = run.catch(() => undefined);
  return untilAborted(run, options.signal);
}

// ---------------------------------------------------------------------------
// Saving a cut-out
// ---------------------------------------------------------------------------

export { NETWORK_ERROR_MESSAGE, type FetchLike, type PutBlobLike } from "@/lib/images/blob-upload-client";

export type SaveCutoutDeps = { fetch: FetchLike; putBlob: PutBlobLike };

export type SaveCutoutInput = {
  itemId: string;
  cutout: Blob;
  /** Cancels the token request and the upload. The final save is not cancelled, so its result is never lost. */
  signal?: AbortSignal;
  onUploadProgress?: (percent: number) => void;
  /** Called once the upload finished and the server starts saving. */
  onUploaded?: () => void;
};

const NobgResultSchema = resultSchema(NobgDataSchema);

/**
 * Uploads a cut-out to items/<id>/nobg.png and asks the server to attach it.
 * Resolves to a Result in every case, never throws. After an abort the result
 * is an error the caller should ignore.
 */
export async function saveCutout(deps: SaveCutoutDeps, input: SaveCutoutInput): Promise<Result<NobgData>> {
  const { itemId, cutout, signal } = input;
  if (cutout.size > UPLOAD_LIMITS.nobgMaxBytes) {
    return err("VALIDATION", "The cut-out is too large to upload.", { reason: "too_large" });
  }

  const payload: BlobClientPayload = { kind: "nobg", itemId };
  const token = await requestClientToken(deps.fetch, nobgUploadPathname(itemId), payload, signal);
  if (!token.ok) return token;

  const progress = progressUntilSettled(
    input.onUploadProgress ? (event) => input.onUploadProgress?.(toPercent(event.percentage / 100)) : undefined,
  );
  let stored: { url: string; pathname: string };
  try {
    stored = await deps.putBlob(nobgUploadPathname(itemId), cutout, {
      access: "public",
      token: token.data,
      contentType: "image/png",
      abortSignal: signal,
      onUploadProgress: progress.onUploadProgress,
    });
  } catch (error) {
    return err("UPSTREAM", `Upload to storage failed: ${blobErrorMessage(error)}`);
  } finally {
    // A late throttled event would otherwise put the button back to "Uploading" while it saves.
    progress.settle();
  }
  input.onUploaded?.();

  const body: NobgBody = { url: stored.url, pathname: stored.pathname };
  const answer = await postJson(deps.fetch, ITEM_API.nobg(itemId), body);
  if (!answer.ok) return answer;
  const parsed = NobgResultSchema.safeParse(answer.data.json);
  return parsed.success ? parsed.data : unexpectedResponse(answer.data.response.status);
}
