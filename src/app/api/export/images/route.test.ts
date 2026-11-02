import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readAll, readZipEntries } from "@/lib/export/zip-reader.testing";
import { ZIP_MANIFEST_NAME } from "@/lib/export/zip-plan";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { makeImage, makeTaggedItem } from "../../../../../test/factories";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../../../test/fakes/blob";

// Wiring of GET /api/export/images: the session check, query validation, the
// download headers and the streamed archive. The service has its own tests.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const route = await import("./route");

let testDb: TestDb;
let fake: FakeBlobStorage;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  fake = createFakeBlobStorage();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

async function seedPhotos(count: number) {
  const stored = [];
  for (let index = 0; index < count; index += 1) {
    const item = await makeTaggedItem(testDb.db, {
      name: `Coat ${index}`,
      createdAt: new Date(Date.UTC(2026, 10, 1, 8, 0, index)),
    });
    const body = Buffer.from(`photo-${index}`);
    const blob = fake.upload(`items/${item.id}/processed.webp`, body, "image/webp");
    await makeImage(testDb.db, item.id, {
      kind: "processed",
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      bytes: body.length,
    });
    stored.push({ item, blob });
  }
  return stored;
}

function get(query: string, init: RequestInit = {}) {
  const request = new Request(`${ORIGIN}/api/export/images${query}`, init);
  return route.GET(request, { params: Promise.resolve({}) });
}

function bodyOf(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new Error("expected a body");
  return response.body;
}

describe("GET /api/export/images", () => {
  it("allows the Hobby maximum of 300 s", () => {
    expect(route.maxDuration).toBe(300);
  });

  it("streams the part as an uncached attachment with an exact Content-Length", async () => {
    const stored = await seedPhotos(2);

    const response = await get("?kind=processed&part=1", { headers: { "sec-fetch-site": "same-origin" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="wardrobe-images-processed-part-1-of-1.zip"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const zip = await readAll(bodyOf(response));
    expect(Number(response.headers.get("content-length"))).toBe(zip.byteLength);

    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual([
      ZIP_MANIFEST_NAME,
      ...stored.map(({ item }, index) => `outerwear/coat-${index}-${item.id.slice(0, 8)}-processed.webp`),
    ]);
    expect(entries.slice(1).map((entry) => Buffer.from(entry.data).toString())).toEqual(["photo-0", "photo-1"]);
    expect(fake.fetched).toEqual(stored.map(({ blob }) => blob.url));
  });

  it("answers 401 without a session and fetches nothing", async () => {
    await seedPhotos(1);
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again."));

    const response = await get("?kind=processed&part=1");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown kind", "?kind=thumb&part=1"],
    ["no kind", "?part=1"],
    ["no part", "?kind=processed"],
    ["part 0", "?kind=processed&part=0"],
    ["a fractional part", "?kind=processed&part=1.5"],
    ["a padded part", "?kind=processed&part=01"],
    ["a repeated part", "?kind=processed&part=1&part=2"],
  ])("answers 400 for %s", async (_label, query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("answers 404 for a part beyond the plan", async () => {
    await seedPhotos(1);
    const response = await get("?kind=processed&part=2");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND", details: { parts: 1 } } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a part whose stored URL is on a foreign host, before any fetch", async () => {
    await seedPhotos(1);
    const stray = await makeTaggedItem(testDb.db, { createdAt: new Date(Date.UTC(2026, 10, 2)) });
    await makeImage(testDb.db, stray.id, { kind: "processed", blobUrl: "https://attacker.example/steal" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await get("?kind=processed&part=1");

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INTERNAL", details: { itemId: stray.id } },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("stops fetching photos when the browser goes away", async () => {
    const stored = await seedPhotos(3);
    const controller = new AbortController();
    const leaving = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The browser goes away while the second photo downloads.
      if (String(input) === stored[1]?.blob.url) controller.abort();
      init?.signal?.throwIfAborted();
      return fake.fetch(input, init);
    });
    vi.stubGlobal("fetch", leaving);

    const response = await get("?kind=processed&part=1", { signal: controller.signal });
    expect(response.status).toBe(200);
    await expect(readAll(bodyOf(response))).rejects.toThrow();
    expect(leaving.mock.calls.map(([input]) => String(input))).toEqual([stored[0]?.blob.url, stored[1]?.blob.url]);
  });

  it("refuses a download another site started", async () => {
    await seedPhotos(1);
    const response = await get("?kind=processed&part=1", { headers: { "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
