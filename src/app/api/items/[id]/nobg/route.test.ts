import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NobgDataSchema, nobgUploadPathname, resultSchema } from "@/lib/items/contracts";

import { makeTestDb, type TestDb } from "../../../../../../test/db";
import { makeImage, makeItem } from "../../../../../../test/factories";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../../../../test/fakes/blob";

// Wiring only: the service has its own tests. Blob and fetch are the in-memory fakes.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
  storage: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));
vi.mock("@/lib/images/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/images/blob")>()),
  getBlobStorage: () => mocks.storage.current,
}));

const route = await import("./route");

let testDb: TestDb;
let fake: FakeBlobStorage;
let cutout: Buffer;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
  cutout = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 0.5 } } })
    .png()
    .toBuffer();
});

beforeEach(async () => {
  await testDb.truncateAll();
  fake = createFakeBlobStorage();
  mocks.storage.current = fake;
  vi.stubGlobal("fetch", fake.fetch);
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await testDb.close();
});

function call(id: string, body: unknown) {
  const request = new Request(`${ORIGIN}/api/items/${id}/nobg`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
  return route.POST(request, { params: Promise.resolve({ id }) });
}

describe("POST /api/items/[id]/nobg", () => {
  it("allows a minute for fetching, encoding and storing", () => {
    expect(route.maxDuration).toBe(60);
  });

  it("attaches the cut-out and answers a Result the client schema accepts", async () => {
    const item = await makeItem(testDb.db);
    await makeImage(testDb.db, item.id, { kind: "processed" });
    const upload = fake.upload(nobgUploadPathname(item.id), cutout, "image/png");

    const response = await call(item.id, { url: upload.url, pathname: upload.pathname });

    expect(response.status).toBe(200);
    const parsed = resultSchema(NobgDataSchema).parse(await response.json());
    expect(parsed).toMatchObject({ ok: true, data: { item: { id: item.id, images: { nobg: { width: 64, height: 64 } } } } });
    expect(fake.fetched).toEqual([upload.url]);
  });

  it("answers 404 for an unknown item", async () => {
    const id = randomUUID();
    const upload = fake.upload(nobgUploadPathname(id), cutout, "image/png");

    const response = await call(id, { url: upload.url, pathname: upload.pathname });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("rejects a non-https URL before calling the service", async () => {
    const id = randomUUID();
    const response = await call(id, {
      url: `http://fakestore.public.blob.vercel-storage.com/${nobgUploadPathname(id)}`,
      pathname: nobgUploadPathname(id),
    });

    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a cross-origin request", async () => {
    const id = randomUUID();
    const request = new Request(`${ORIGIN}/api/items/${id}/nobg`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ url: "https://fakestore.public.blob.vercel-storage.com/x.png", pathname: "x.png" }),
    });

    const response = await route.POST(request, { params: Promise.resolve({ id }) });

    expect(response.status).toBe(403);
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });
});
