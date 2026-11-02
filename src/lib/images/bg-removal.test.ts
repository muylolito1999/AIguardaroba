import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ITEM_API, nobgUploadPathname, UPLOAD_LIMITS, type ItemCardDto } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

import { BG_REMOVAL_FILE_BYTES } from "./bg-removal-assets";
import {
  BG_DOWNLOAD_BYTES,
  BG_MODEL_DOWNLOAD_MB,
  BG_REMOVAL_CONFIG,
  bgRemovalConfig,
  createProgressTracker,
  removeBackgroundFromUrl,
  saveCutout,
  type BgRemovalProgress,
  type FetchLike,
  type PutBlobLike,
} from "./bg-removal";

// The library is faked: it records each call and lets the test decide when
// it finishes. Like the real one, it keeps the progress callback of the FIRST
// config it saw (its session is memoized by JSON.stringify(config)).
const lib = vi.hoisted(() => {
  type Progress = (key: string, current: number, total: number) => void;
  type Call = { image: unknown; resolve: (blob: Blob) => void; reject: (error: unknown) => void };
  const state = { calls: [] as Call[], firstProgress: null as Progress | null, configs: [] as unknown[] };
  return {
    state,
    removeBackground: (image: unknown, config: { progress?: Progress }) => {
      state.configs.push(config);
      state.firstProgress ??= config.progress ?? null;
      return new Promise<Blob>((resolve, reject) => {
        state.calls.push({ image, resolve, reject });
      });
    },
    /** Reports progress the way the library does: through the memoized config. */
    progress(key: string, current: number, total: number) {
      state.firstProgress?.(key, current, total);
    },
  };
});
vi.mock("@imgly/background-removal", () => ({ removeBackground: lib.removeBackground }));

const PHOTO_URL = "https://fakestore.public.blob.vercel-storage.com/items/abc/processed-x.webp";
const APP_ORIGIN = "https://wardrobe.example";
const ITEM_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

function png(): Blob {
  return new Blob(["png bytes"], { type: "image/png" });
}

/** Lets queued promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function waitForCalls(count: number): Promise<void> {
  await vi.waitFor(() => expect(lib.state.calls.length).toBe(count));
}

const sourceFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  lib.state.calls.length = 0;
  lib.state.configs.length = 0;
  sourceFetch.mockReset();
  sourceFetch.mockImplementation(async () => new Response(new Blob(["webp bytes"], { type: "image/webp" })));
  vi.stubGlobal("fetch", sourceFetch);
  vi.stubGlobal("location", new URL(`${APP_ORIGIN}/add/review`));
});

afterEach(async () => {
  // Every run must have ended, or the next test would queue behind it.
  for (const call of lib.state.calls) call.resolve(png());
  await flush();
  vi.unstubAllGlobals();
});

describe("createProgressTracker", () => {
  it("sums download progress across files against the known total", () => {
    const seen: BgRemovalProgress[] = [];
    const track = createProgressTracker((progress) => seen.push(progress));

    track("fetch:/models/isnet_quint8", 22_174_470, 44_348_940);
    track("fetch:/models/isnet_quint8", 44_348_940, 44_348_940);
    track("fetch:/onnxruntime-web/ort-wasm-simd-threaded.wasm", BG_REMOVAL_FILE_BYTES.wasm, BG_REMOVAL_FILE_BYTES.wasm);
    track("fetch:/onnxruntime-web/ort-wasm-simd-threaded.mjs", BG_REMOVAL_FILE_BYTES.mjs, BG_REMOVAL_FILE_BYTES.mjs);

    expect(seen).toEqual([
      { stage: "download", percent: Math.round((22_174_470 / BG_DOWNLOAD_BYTES) * 100) },
      { stage: "download", percent: Math.round((44_348_940 / BG_DOWNLOAD_BYTES) * 100) },
      { stage: "download", percent: 100 },
      { stage: "download", percent: 100 },
    ]);
  });

  it("maps compute steps and ignores unknown keys", () => {
    const seen: BgRemovalProgress[] = [];
    const track = createProgressTracker((progress) => seen.push(progress));

    track("compute:decode", 0, 4);
    track("compute:inference", 1, 4);
    track("compute:mask", 2, 4);
    track("compute:encode", 4, 4);
    track("compute:unknown", 1, 4);
    track("something:else", 1, 1);

    expect(seen).toEqual([
      { stage: "process", step: "decode", percent: 0 },
      { stage: "process", step: "inference", percent: 25 },
      { stage: "process", step: "mask", percent: 50 },
      { stage: "process", step: "encode", percent: 100 },
    ]);
  });
});

describe("removeBackgroundFromUrl", () => {
  it("uses the small CPU model with PNG output", () => {
    expect(BG_REMOVAL_CONFIG).toMatchObject({
      device: "cpu",
      model: "isnet_quint8",
      output: { format: "image/png" },
    });
    expect(BG_REMOVAL_CONFIG).not.toHaveProperty("publicPath");
  });

  it("loads the runtime from this app, never from the library's default CDN path", () => {
    const config = bgRemovalConfig(APP_ORIGIN);
    expect(config.publicPath).toBe(`${APP_ORIGIN}/vendor/bg-removal/imgly-1.7.0-ort-1.21.0/`);
    // Equal configs keep the library's memoised session (it keys on JSON.stringify).
    expect(JSON.stringify(bgRemovalConfig(APP_ORIGIN))).toBe(JSON.stringify(config));
    expect(BG_MODEL_DOWNLOAD_MB).toBe(57);
  });

  it("loads the photo, runs the library on it and resolves to its PNG", async () => {
    const result = removeBackgroundFromUrl(PHOTO_URL);
    await waitForCalls(1);

    expect(sourceFetch).toHaveBeenCalledWith(PHOTO_URL, expect.objectContaining({}));
    const image = lib.state.calls[0]?.image;
    expect(image).toBeInstanceOf(Blob);
    expect(await (image as Blob).text()).toBe("webp bytes");
    expect(lib.state.configs[0]).toEqual(bgRemovalConfig(APP_ORIGIN));

    const output = png();
    lib.state.calls[0]?.resolve(output);
    await expect(result).resolves.toBe(output);
  });

  it("reports each run's progress to its own caller although the library keeps the first callback", async () => {
    const first: BgRemovalProgress[] = [];
    const second: BgRemovalProgress[] = [];

    const one = removeBackgroundFromUrl(PHOTO_URL, { onProgress: (progress) => first.push(progress) });
    await waitForCalls(1);
    lib.progress("compute:inference", 1, 4);
    lib.state.calls[0]?.resolve(png());
    await one;

    const two = removeBackgroundFromUrl(PHOTO_URL, { onProgress: (progress) => second.push(progress) });
    await waitForCalls(2);
    lib.progress("compute:mask", 2, 4);
    lib.state.calls[1]?.resolve(png());
    await two;

    expect(first).toEqual([{ stage: "process", step: "inference", percent: 25 }]);
    expect(second).toEqual([{ stage: "process", step: "mask", percent: 50 }]);
  });

  it("runs one removal at a time", async () => {
    const one = removeBackgroundFromUrl(PHOTO_URL);
    const two = removeBackgroundFromUrl(PHOTO_URL);
    await waitForCalls(1);
    await flush();
    expect(lib.state.calls).toHaveLength(1);

    lib.state.calls[0]?.resolve(png());
    await one;
    await waitForCalls(2);
    lib.state.calls[1]?.resolve(png());
    await expect(two).resolves.toBeInstanceOf(Blob);
  });

  it("rejects at once when aborted, stops progress, and the next run waits for the abandoned one", async () => {
    const controller = new AbortController();
    const seen: BgRemovalProgress[] = [];
    const abandoned = removeBackgroundFromUrl(PHOTO_URL, {
      signal: controller.signal,
      onProgress: (progress) => seen.push(progress),
    });
    await waitForCalls(1);

    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    lib.progress("compute:mask", 2, 4);
    expect(seen).toEqual([]);

    const next = removeBackgroundFromUrl(PHOTO_URL);
    await flush();
    expect(lib.state.calls).toHaveLength(1);

    lib.state.calls[0]?.resolve(png());
    await waitForCalls(2);
    lib.state.calls[1]?.resolve(png());
    await expect(next).resolves.toBeInstanceOf(Blob);
  });

  it("never starts a run that was aborted while it waited", async () => {
    const first = removeBackgroundFromUrl(PHOTO_URL);
    const controller = new AbortController();
    const queued = removeBackgroundFromUrl(PHOTO_URL, { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    await waitForCalls(1);
    lib.state.calls[0]?.resolve(png());
    await first;
    await flush();

    expect(lib.state.calls).toHaveLength(1);
    expect(sourceFetch).toHaveBeenCalledTimes(1);
  });

  it("fails with UPSTREAM when the photo cannot be loaded, without running the model", async () => {
    sourceFetch.mockResolvedValueOnce(new Response("gone", { status: 404 }));

    const error = await removeBackgroundFromUrl(PHOTO_URL).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "UPSTREAM", message: expect.stringContaining("HTTP 404") });
    expect(lib.state.calls).toEqual([]);
  });

  it("fails with UPSTREAM when the network is down", async () => {
    sourceFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(removeBackgroundFromUrl(PHOTO_URL)).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("tells the user to reload when the library fails", async () => {
    const result = removeBackgroundFromUrl(PHOTO_URL);
    await waitForCalls(1);
    lib.state.calls[0]?.reject(new Error("Failed to fetch /models/isnet_quint8"));
    lib.state.calls.length = 0;

    await expect(result).rejects.toMatchObject({ code: "UPSTREAM", message: expect.stringContaining("Reload") });
  });
});

// ---------------------------------------------------------------------------

function cardWithNobg(): ItemCardDto {
  return {
    id: ITEM_ID,
    status: "tagged",
    createdAt: "2026-11-02T10:00:00.000Z",
    name: "Red jacket",
    category: "outerwear",
    subcategory: "jacket",
    colors: ["red"],
    colorHex: ["#cc2222"],
    materialGuess: null,
    materials: [],
    warmthLevel: 3,
    waterproof: false,
    windproof: true,
    insulated: false,
    breathable: null,
    seasons: ["autumn"],
    formality: "casual",
    pattern: "solid",
    fit: null,
    condition: "good",
    brand: null,
    size: null,
    description: "A red jacket.",
    notes: "",
    purchasePrice: null,
    currency: "EUR",
    purchaseDate: null,
    location: "hamburg",
    decision: "undecided",
    aiConfidence: null,
    multipleItemsDetected: false,
    userEditedFields: [],
    taggingError: null,
    taggingBatchId: null,
    aiModel: null,
    images: {
      thumb: null,
      processed: { url: PHOTO_URL, width: 768, height: 1024 },
      nobg: { url: "https://fakestore.public.blob.vercel-storage.com/items/x/nobg-a.webp", width: 768, height: 1024 },
    },
  };
}

type Recorded = { url: string; body: unknown };

function fakeServer(answers: { token?: Response; nobg?: Response } = {}) {
  const requests: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    if (url === ITEM_API.blobUpload) {
      return (
        answers.token ?? Response.json({ type: "blob.generate-client-token", clientToken: "vercel_blob_client_fake" })
      );
    }
    if (url === ITEM_API.nobg(ITEM_ID)) return answers.nobg ?? Response.json({ ok: true, data: { item: cardWithNobg() } });
    throw new Error(`unexpected request to ${url}`);
  };
  const puts: Array<{ pathname: string; options: Parameters<PutBlobLike>[2] }> = [];
  const lateProgress: Array<() => void> = [];
  const putBlob: PutBlobLike = async (pathname, _body, options) => {
    puts.push({ pathname, options });
    options.onUploadProgress?.({ loaded: 5, total: 10, percentage: 50 });
    // put() throttles progress and can deliver its trailing call after it resolved.
    lateProgress.push(() => options.onUploadProgress?.({ loaded: 10, total: 10, percentage: 100 }));
    return { url: "https://fakestore.public.blob.vercel-storage.com/items/x/nobg-q1.png", pathname: `${pathname}-q1` };
  };
  return { requests, puts, lateProgress, deps: { fetch: fetchImpl, putBlob } };
}

describe("saveCutout", () => {
  it("gets a nobg token, uploads the PNG and asks the server to attach it", async () => {
    const server = fakeServer();
    const uploadProgress: number[] = [];
    const onUploaded = vi.fn();

    const result = await saveCutout(server.deps, {
      itemId: ITEM_ID,
      cutout: png(),
      onUploadProgress: (percent) => uploadProgress.push(percent),
      onUploaded,
    });

    expect(result).toEqual({ ok: true, data: { item: cardWithNobg() } });
    for (const late of server.lateProgress) late();
    expect(uploadProgress).toEqual([50]);
    expect(server.requests[0]).toEqual({
      url: ITEM_API.blobUpload,
      body: {
        type: "blob.generate-client-token",
        payload: {
          pathname: nobgUploadPathname(ITEM_ID),
          clientPayload: JSON.stringify({ kind: "nobg", itemId: ITEM_ID }),
          multipart: false,
        },
      },
    });
    expect(server.puts).toEqual([
      {
        pathname: nobgUploadPathname(ITEM_ID),
        options: expect.objectContaining({
          access: "public",
          token: "vercel_blob_client_fake",
          contentType: "image/png",
        }),
      },
    ]);
    expect(uploadProgress).toEqual([50]);
    expect(onUploaded).toHaveBeenCalledOnce();
    expect(server.requests[1]).toEqual({
      url: ITEM_API.nobg(ITEM_ID),
      body: {
        url: "https://fakestore.public.blob.vercel-storage.com/items/x/nobg-q1.png",
        pathname: `${nobgUploadPathname(ITEM_ID)}-q1`,
      },
    });
  });

  it("passes the token route's refusal through with its code", async () => {
    const server = fakeServer({
      token: Response.json(
        { ok: false, error: { code: "NOT_FOUND", message: "That item no longer exists." } },
        { status: 404 },
      ),
    });

    const result = await saveCutout(server.deps, { itemId: ITEM_ID, cutout: png() });

    expect(result).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "That item no longer exists." } });
    expect(server.puts).toEqual([]);
  });

  it("passes the attach route's refusal through", async () => {
    const server = fakeServer({
      nobg: Response.json(
        { ok: false, error: { code: "VALIDATION", message: "That image has no transparent background." } },
        { status: 400 },
      ),
    });

    const result = await saveCutout(server.deps, { itemId: ITEM_ID, cutout: png() });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("reports a failed upload as UPSTREAM without the SDK's prefix", async () => {
    const server = fakeServer();
    const putBlob: PutBlobLike = async () => {
      throw new Error("Vercel Blob: The request was aborted.");
    };

    const result = await saveCutout({ ...server.deps, putBlob }, { itemId: ITEM_ID, cutout: png() });

    expect(result).toEqual({
      ok: false,
      error: { code: "UPSTREAM", message: "Upload to storage failed: The request was aborted." },
    });
    expect(server.requests).toHaveLength(1);
  });

  it("reports a non-JSON answer and a network failure as UPSTREAM", async () => {
    const html = fakeServer({ nobg: new Response("<html>timeout</html>", { status: 504 }) });
    expect(await saveCutout(html.deps, { itemId: ITEM_ID, cutout: png() })).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM", message: expect.stringContaining("HTTP 504") },
    });

    const offline: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await saveCutout({ ...html.deps, fetch: offline }, { itemId: ITEM_ID, cutout: png() })).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM" },
    });
  });

  it("refuses a cut-out above the upload limit before any request", async () => {
    const server = fakeServer();
    const huge = new Blob([new Uint8Array(UPLOAD_LIMITS.nobgMaxBytes + 1)], { type: "image/png" });

    const result = await saveCutout(server.deps, { itemId: ITEM_ID, cutout: huge });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(server.requests).toEqual([]);
  });
});
