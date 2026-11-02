import { randomUUID } from "node:crypto";

import { getPayloadFromClientToken } from "@vercel/blob/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { nobgUploadPathname, originalUploadPathname, UPLOAD_LIMITS } from "@/lib/items/contracts";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { makeItem } from "../../../../../test/factories";

// The real handleUpload runs: it signs the client token locally with the
// (fake) read-write token, so the test can decode exactly what the browser
// would be allowed to upload, with no network.

const FAKE_TOKEN = "vercel_blob_rw_fakestore_notarealsecret";
const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  blobEnv: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/env", () => ({ blobEnv: mocks.blobEnv }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const { POST } = await import("./route");

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  mocks.blobEnv.mockReset();
  mocks.blobEnv.mockReturnValue({ BLOB_READ_WRITE_TOKEN: FAKE_TOKEN });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

const SOURCE_HASH = "d".repeat(64);

function tokenEvent(pathname: string, clientPayload: unknown, multipart = false) {
  return {
    type: "blob.generate-client-token",
    payload: {
      pathname,
      clientPayload: typeof clientPayload === "string" || clientPayload === null ? clientPayload : JSON.stringify(clientPayload),
      multipart,
    },
  };
}

function call(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  const request = new Request(`${ORIGIN}/api/blob/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({}) });
}

async function errorOf(response: Response) {
  const body = (await response.json()) as { ok: boolean; error: { code: string; message: string; details?: unknown } };
  expect(body.ok).toBe(false);
  return body.error;
}

async function decodedToken(response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { type: string; clientToken: string };
  expect(body.type).toBe("blob.generate-client-token");
  expect(body.clientToken.startsWith("vercel_blob_client_fakestore_")).toBe(true);
  return getPayloadFromClientToken(body.clientToken);
}

describe("POST /api/blob/upload", () => {
  it("issues a 10-minute token for exactly this item's original, with type and size limits", async () => {
    const itemId = randomUUID();
    const before = Date.now();

    const response = await call(
      tokenEvent(originalUploadPathname(itemId), { kind: "original", itemId, sourceHash: SOURCE_HASH }),
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await decodedToken(response);
    expect(payload).toMatchObject({
      pathname: originalUploadPathname(itemId),
      allowedContentTypes: [...UPLOAD_LIMITS.originalContentTypes],
      maximumSizeInBytes: UPLOAD_LIMITS.originalMaxBytes,
      addRandomSuffix: true,
      allowOverwrite: false,
      cacheControlMaxAge: 365 * 24 * 60 * 60,
    });
    expect(payload.validUntil).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(payload.validUntil).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    // No completion callback is ever registered.
    expect(payload.onUploadCompleted).toBeUndefined();
  });

  it("checks the session again inside the token callback", async () => {
    // The wrapper's check passes; the callback's own check fails.
    mocks.requireSession
      .mockResolvedValueOnce({ sub: "owner", iat: 0, exp: 0 })
      .mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again."));
    const itemId = randomUUID();

    const response = await call(
      tokenEvent(originalUploadPathname(itemId), { kind: "original", itemId, sourceHash: SOURCE_HASH }),
    );

    expect(response.status).toBe(401);
    expect(mocks.requireSession).toHaveBeenCalledTimes(2);
  });

  it("issues a PNG-only token for a background-removed image of an existing item", async () => {
    const item = await makeItem(testDb.db);

    const payload = await decodedToken(
      await call(tokenEvent(nobgUploadPathname(item.id), { kind: "nobg", itemId: item.id })),
    );

    expect(payload).toMatchObject({
      pathname: nobgUploadPathname(item.id),
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: UPLOAD_LIMITS.nobgMaxBytes,
      addRandomSuffix: true,
    });
  });

  it("requires a session", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again."));
    const itemId = randomUUID();

    const response = await call(
      tokenEvent(originalUploadPathname(itemId), { kind: "original", itemId, sourceHash: SOURCE_HASH }),
    );

    expect(response.status).toBe(401);
    expect(await errorOf(response)).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("refuses a request from another origin", async () => {
    const itemId = randomUUID();
    const response = await call(
      tokenEvent(originalUploadPathname(itemId), { kind: "original", itemId, sourceHash: SOURCE_HASH }),
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["no client payload", null, "missing_payload"],
    ["a payload that is not JSON", "{not json", "payload_not_json"],
    ["an unknown kind", { kind: "avatar", itemId: randomUUID() }, "payload_invalid"],
    ["a malformed source hash", { kind: "original", itemId: randomUUID(), sourceHash: "ABC" }, "payload_invalid"],
    ["a non-uuid item id", { kind: "nobg", itemId: "../../etc" }, "payload_invalid"],
  ])("rejects %s", async (_label, clientPayload, reason) => {
    const response = await call(tokenEvent(originalUploadPathname(randomUUID()), clientPayload));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "VALIDATION", details: { reason } });
  });

  it("rejects a pathname that is not the contract's pathname for that item and kind", async () => {
    const itemId = randomUUID();
    const original = { kind: "original", itemId, sourceHash: SOURCE_HASH };
    for (const pathname of [
      originalUploadPathname(randomUUID()),
      nobgUploadPathname(itemId),
      `${originalUploadPathname(itemId)}.png`,
      `items/${itemId}/original-x.jpg`,
    ]) {
      const response = await call(tokenEvent(pathname, original));
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: "VALIDATION", details: { reason: "pathname" } });
    }

    const item = await makeItem(testDb.db);
    const nobg = await call(tokenEvent(originalUploadPathname(item.id), { kind: "nobg", itemId: item.id }));
    expect(nobg.status).toBe(400);
  });

  it("answers DUPLICATE with the existing item when the source hash is known", async () => {
    const existing = await makeItem(testDb.db, { sourceHash: SOURCE_HASH });
    const itemId = randomUUID();

    const response = await call(
      tokenEvent(originalUploadPathname(itemId), { kind: "original", itemId, sourceHash: SOURCE_HASH }),
    );

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({ code: "DUPLICATE", details: { existingItemId: existing.id } });
  });

  it("answers NOT_FOUND for a background-removed image of an unknown item", async () => {
    const itemId = randomUUID();
    const response = await call(tokenEvent(nobgUploadPathname(itemId), { kind: "nobg", itemId }));
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({ code: "NOT_FOUND", details: { itemId } });
  });

  it("refuses upload-completed callbacks, since none is ever registered", async () => {
    const response = await call({
      type: "blob.upload-completed",
      payload: { blob: { url: "https://x.example/a.jpg" }, tokenPayload: null },
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "VALIDATION" });
  });

  it("hides a missing Blob token behind the generic CONFIG message and logs it", async () => {
    mocks.blobEnv.mockImplementation(() => {
      throw new AppError("CONFIG", "Invalid server configuration (blob): BLOB_READ_WRITE_TOKEN is not set.");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const itemId = randomUUID();

    const response = await call(
      tokenEvent(originalUploadPathname(itemId), { kind: "original", itemId, sourceHash: SOURCE_HASH }),
    );

    expect(response.status).toBe(500);
    expect(await errorOf(response)).toEqual({ code: "CONFIG", message: CONFIG_ERROR_MESSAGE });
    expect(log).toHaveBeenCalled();
  });
});
