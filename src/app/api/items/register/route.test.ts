import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { appSettings, items } from "@/lib/db/schema";
import { originalUploadPathname, RegisterDataSchema, resultSchema } from "@/lib/items/contracts";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../../../test/fakes/blob";
import { solidJpeg } from "../../../../../test/fixtures/images";

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

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  await testDb.db.insert(appSettings).values({ id: 1 });
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

function call(body: unknown) {
  const request = new Request(`${ORIGIN}/api/items/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
  return route.POST(request, { params: Promise.resolve({}) });
}

describe("POST /api/items/register", () => {
  it("allows a minute for fetching, processing and storing", () => {
    expect(route.maxDuration).toBe(60);
  });

  it("registers an upload and answers a Result the client schema accepts", async () => {
    const itemId = randomUUID();
    const blob = fake.upload(originalUploadPathname(itemId), await solidJpeg(900, 600), "image/jpeg");

    const response = await call({
      itemId,
      url: blob.url,
      pathname: blob.pathname,
      sourceHash: "e".repeat(64),
      originalFilename: "coat.jpg",
    });

    expect(response.status).toBe(200);
    const parsed = resultSchema(RegisterDataSchema).parse(await response.json());
    expect(parsed).toMatchObject({ ok: true, data: { duplicate: false, item: { id: itemId, status: "pending_tagging" } } });
    expect(fake.fetched).toEqual([blob.url]);
  });

  describe("the collection stamped on /add (D-252)", () => {
    async function uploadedBody(fileName: string) {
      const itemId = randomUUID();
      const blob = fake.upload(originalUploadPathname(itemId), await solidJpeg(900, 600), "image/jpeg");
      return {
        itemId,
        body: { itemId, url: blob.url, pathname: blob.pathname, sourceHash: "f".repeat(64), originalFilename: fileName },
      };
    }

    async function storedCollections() {
      return (await testDb.db.select({ id: items.id, collection: items.collection }).from(items)).map((row) => [
        row.id,
        row.collection,
      ]);
    }

    it("registers a body without the field, from a tab older than it, as clothing", async () => {
      const { itemId, body } = await uploadedBody("coat.jpg");

      const response = await call(body);

      expect(response.status).toBe(200);
      // The raw answer, not parsed with the client schema's default.
      expect(await response.json()).toMatchObject({ ok: true, data: { item: { id: itemId, collection: "clothing" } } });
      expect(await storedCollections()).toEqual([[itemId, "clothing"]]);
    });

    it("registers running gear when the body says so", async () => {
      const { itemId, body } = await uploadedBody("shoes.jpg");

      const response = await call({ ...body, collection: "running" });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, data: { item: { id: itemId, collection: "running" } } });
      expect(await storedCollections()).toEqual([[itemId, "running"]]);
    });

    it("rejects an unknown collection before calling the service", async () => {
      const { body } = await uploadedBody("bike.jpg");

      const response = await call({ ...body, collection: "cycling" });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(fake.fetched).toEqual([]);
      expect(await storedCollections()).toEqual([]);
    });
  });

  it("rejects a non-https URL before calling the service", async () => {
    const itemId = randomUUID();
    const response = await call({
      itemId,
      url: `http://fakestore.public.blob.vercel-storage.com/${originalUploadPathname(itemId)}`,
      pathname: originalUploadPathname(itemId),
      sourceHash: "e".repeat(64),
      originalFilename: "coat.jpg",
    });
    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});
