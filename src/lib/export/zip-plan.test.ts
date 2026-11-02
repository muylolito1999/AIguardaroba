import { makeZip, predictLength } from "client-zip";
import { describe, expect, it } from "vitest";

import { readAll, readZipEntries } from "./zip-reader.testing";
import {
  ZIP_MANIFEST_NAME,
  ZIP_PART_MAX_ITEMS,
  extensionFor,
  fileNameFor,
  manifestBytes,
  planZipParts,
  slugify,
  zipFileName,
  zipPartHref,
  type ZipManifest,
  type ZipPlanItem,
} from "./zip-plan";

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function planItem(n: number, overrides: Partial<ZipPlanItem> = {}): ZipPlanItem {
  const id = uuid(n);
  return {
    id,
    name: `Coat ${n}`,
    subcategory: "coat",
    category: "outerwear",
    images: {
      processed: {
        url: `https://store.public.blob.vercel-storage.com/items/${id}/processed.webp`,
        contentType: "image/webp",
        bytes: 1_000 + n,
        createdAt: "2026-11-01T10:00:00.000Z",
      },
    },
    ...overrides,
  };
}

describe("slugify", () => {
  it("folds accents, lowercases and joins words with hyphens", () => {
    expect(slugify("Cappotto Blu Élégant")).toBe("cappotto-blu-elegant");
    expect(slugify("  Wool / cashmere, 2024!  ")).toBe("wool-cashmere-2024");
  });

  it("keeps ASCII only and falls back to 'item'", () => {
    expect(slugify("Straße")).toBe("stra-e");
    expect(slugify("雨衣")).toBe("item");
    expect(slugify("")).toBe("item");
  });

  it("cuts at 40 characters without a trailing hyphen", () => {
    const slug = slugify("a very long name for a coat that goes on and on forever");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("a-very-long-name-for-a-coat-that-goes-on");
  });
});

describe("fileNameFor", () => {
  const source = { id: uuid(0xabcdef12), name: "Navy wool coat", subcategory: "coat", category: "outerwear" as const };

  it("is '<category>/<slug>-<id8>-<kind>.<ext>'", () => {
    expect(fileNameFor({ ...source, contentType: "image/webp" }, "processed")).toBe(
      "outerwear/navy-wool-coat-abcdef12-processed.webp",
    );
    expect(fileNameFor({ ...source, contentType: "image/jpeg" }, "original")).toBe(
      "outerwear/navy-wool-coat-abcdef12-original.jpg",
    );
  });

  it("uses 'untagged' and the display-name fallbacks for items without tags", () => {
    expect(
      fileNameFor({ id: source.id, name: null, subcategory: null, category: null, contentType: "image/png" }, "nobg"),
    ).toBe("untagged/untagged-item-abcdef12-nobg.png");
    expect(fileNameFor({ ...source, name: " ", contentType: "image/webp" }, "processed")).toBe(
      "outerwear/coat-abcdef12-processed.webp",
    );
  });

  it("maps content types to extensions", () => {
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("IMAGE/PNG; charset=binary")).toBe("png");
    expect(extensionFor("application/octet-stream")).toBe("bin");
  });
});

describe("planZipParts", () => {
  it("splits into parts of at most 100 items, in input order", () => {
    const items = Array.from({ length: 250 }, (_, index) => planItem(index + 1));
    const plan = planZipParts(items, { kind: "processed" });

    expect(ZIP_PART_MAX_ITEMS).toBe(100);
    expect(plan.itemCount).toBe(250);
    expect(plan.parts.map((part) => part.entries.length)).toEqual([100, 100, 50]);
    expect(plan.parts.map((part) => [part.part, part.parts])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(plan.parts.flatMap((part) => part.entries.map((entry) => entry.itemId))).toEqual(items.map((item) => item.id));
    expect(plan.parts[2]?.fileName).toBe("wardrobe-images-processed-part-3-of-3.zip");
  });

  it("honours a smaller maxItems and rejects a nonsensical one", () => {
    const items = [1, 2, 3].map((n) => planItem(n));
    expect(planZipParts(items, { kind: "processed", maxItems: 2 }).parts.map((part) => part.entries.length)).toEqual([
      2, 1,
    ]);
    expect(() => planZipParts(items, { kind: "processed", maxItems: 0 })).toThrow(RangeError);
    expect(() => planZipParts(items, { kind: "processed", maxItems: 1.5 })).toThrow(RangeError);
  });

  it("skips items without an image of the kind and plans no part when none has one", () => {
    const withNobg = planItem(1, {
      images: {
        ...planItem(1).images,
        nobg: { url: "https://store.public.blob.vercel-storage.com/n.png", contentType: "image/png", bytes: 5, createdAt: null },
      },
    });
    const plan = planZipParts([withNobg, planItem(2), planItem(3)], { kind: "nobg" });
    expect(plan.itemCount).toBe(1);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]?.entries.map((entry) => entry.itemId)).toEqual([withNobg.id]);

    expect(planZipParts([planItem(2)], { kind: "original" })).toEqual({ kind: "original", itemCount: 0, parts: [] });
  });

  it("gives same-named items different names, and de-duplicates even a shared id prefix", () => {
    const a = planItem(1, { name: "Black boots", category: "shoes" });
    const b = planItem(2, { name: "Black boots", category: "shoes" });
    // Same first 8 characters of the id as a, and the same name: only the suffix can tell them apart.
    const c = planItem(1, { id: `${uuid(1).slice(0, 8)}-ffff-4000-8000-000000000003`, name: "BLACK BOOTS", category: "shoes" });
    const names = planZipParts([a, b, c], { kind: "processed" }).parts[0]?.entries.map((entry) => entry.fileName);

    expect(names).toEqual([
      "shoes/black-boots-00000001-processed.webp",
      "shoes/black-boots-00000002-processed.webp",
      "shoes/black-boots-00000001-processed-2.webp",
    ]);
    expect(new Set(names?.map((name) => name.toLowerCase())).size).toBe(3);
  });

  it("keeps names unique across parts, so all parts can be extracted into one folder", () => {
    const items = Array.from({ length: 5 }, (_, index) => planItem(index + 1, { id: `${uuid(9).slice(0, 8)}-${index}`, name: "Same" }));
    const plan = planZipParts(items, { kind: "processed", maxItems: 2 });
    const all = plan.parts.flatMap((part) => part.entries.map((entry) => entry.fileName.toLowerCase()));
    expect(new Set(all).size).toBe(5);
    expect(all).not.toContain(ZIP_MANIFEST_NAME);
  });

  it("writes a manifest listing item id, file name, source URL and size", () => {
    const items = [planItem(1), planItem(2)];
    const part = planZipParts(items, { kind: "processed" }).parts[0];
    const manifest = JSON.parse(part?.manifest ?? "") as ZipManifest;

    expect(manifest).toEqual({
      version: 1,
      kind: "processed",
      part: 1,
      parts: 1,
      files: items.map((item) => ({
        itemId: item.id,
        fileName: expect.stringMatching(/^outerwear\/coat-\d+-0000000\d-processed\.webp$/),
        sourceUrl: item.images.processed?.url,
        bytes: item.images.processed?.bytes,
        contentType: "image/webp",
      })),
    });
  });

  it("predicts the archive length exactly as client-zip does when every size is known", () => {
    const part = planZipParts([planItem(1), planItem(2), planItem(3)], { kind: "processed" }).parts[0];
    if (part === undefined) throw new Error("expected a part");

    const expected = predictLength([
      { name: ZIP_MANIFEST_NAME, size: manifestBytes(part.manifest).byteLength },
      ...part.entries.map((entry) => ({ name: entry.fileName, size: entry.bytes ?? 0 })),
    ]);
    expect(part.predictedLength).toBe(Number(expected));
    expect(part.knownBytes).toBe(1_001 + 1_002 + 1_003);
  });

  it("matches the bytes client-zip actually writes for the planned entries", async () => {
    const part = planZipParts([planItem(1), planItem(2)], { kind: "processed" }).parts[0];
    if (part === undefined) throw new Error("expected a part");

    const files = [
      { name: ZIP_MANIFEST_NAME, input: manifestBytes(part.manifest) },
      ...part.entries.map((entry) => ({ name: entry.fileName, input: new Uint8Array(entry.bytes ?? 0).fill(7) })),
    ];
    const zip = await readAll(makeZip(files));

    expect(zip.byteLength).toBe(part.predictedLength);
    expect(readZipEntries(zip).map((entry) => entry.name)).toEqual(files.map((file) => file.name));
  });

  it("predicts no length when a size is unknown, but still sums the known ones", () => {
    const unknown = planItem(2, {
      images: { processed: { url: "https://s.public.blob.vercel-storage.com/x.webp", contentType: "image/webp", bytes: null, createdAt: null } },
    });
    const part = planZipParts([planItem(1), unknown], { kind: "processed" }).parts[0];
    expect(part?.predictedLength).toBeNull();
    expect(part?.knownBytes).toBe(1_001);
  });
});

describe("names and links", () => {
  it("names the archive and links the part", () => {
    expect(zipFileName("original", 2, 5)).toBe("wardrobe-images-original-part-2-of-5.zip");
    expect(zipPartHref("nobg", 3)).toBe("/api/export/images?kind=nobg&part=3");
  });
});
