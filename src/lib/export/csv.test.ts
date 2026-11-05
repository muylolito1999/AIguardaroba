import { describe, expect, it } from "vitest";

import {
  CSV_BOM,
  CSV_EOL,
  ITEM_CSV_HEADERS,
  csvField,
  csvRow,
  guardFormula,
  itemCsvHeaderRow,
  itemCsvRow,
  quoteCsvField,
  type ItemCsvSource,
} from "./csv";

const ITEM: ItemCsvSource = {
  id: "0b6f1c1e-2d5a-4f0e-9f53-7a1f3c2b9d10",
  name: "Navy wool coat",
  category: "outerwear",
  subcategory: "coat",
  status: "confirmed",
  location: "bologna",
  decision: "bring",
  colors: ["navy", "black"],
  colorHex: ["#1f2a44", "#000000"],
  materials: ["wool"],
  materialGuess: "wool",
  warmthLevel: 4,
  waterproof: false,
  windproof: true,
  insulated: true,
  breathable: null,
  seasons: ["winter", "autumn"],
  formality: "smart_casual",
  pattern: null,
  fit: null,
  condition: "good",
  brand: null,
  size: "M",
  description: "Knee-length, two buttons",
  notes: "",
  purchasePrice: 129.5,
  currency: "EUR",
  purchaseDate: "2024-10-01",
  wearCount: 3,
  lastWornAt: new Date("2026-10-30T08:00:00.000Z"),
  createdAt: new Date("2026-11-01T10:00:00.000Z"),
  updatedAt: new Date("2026-11-02T11:30:00.000Z"),
  collection: "clothing",
  imageUrls: {
    processed: "https://store.public.blob.vercel-storage.com/items/x/processed.webp",
    original: "https://store.public.blob.vercel-storage.com/items/x/original.jpg",
  },
};

/** Splits one record into fields, honouring RFC 4180 quotes (test helper only). */
function parseRecord(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      fields.push(field);
      field = "";
    } else field += char;
  }
  fields.push(field);
  return fields;
}

describe("csvField", () => {
  it("leaves plain text alone", () => {
    expect(csvField("navy coat")).toBe("navy coat");
  });

  it("quotes fields with a comma, a quote, CR or LF and doubles the quotes", () => {
    expect(csvField("wool, cashmere")).toBe('"wool, cashmere"');
    expect(csvField('the "good" coat')).toBe('"the ""good"" coat"');
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("line one\r\nline two")).toBe('"line one\r\nline two"');
    expect(csvField("a\rb")).toBe('"a\rb"');
  });

  it("puts an apostrophe before text starting with = + - @ tab or CR", () => {
    expect(csvField("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvField("+1 555")).toBe("'+1 555");
    expect(csvField("-cheap")).toBe("'-cheap");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    // The tab is a cell boundary for a tab-splitting reader, so the "=" after it is guarded too, and the field is quoted.
    expect(csvField("\t=1+1")).toBe(`"'\t'=1+1"`);
    // The apostrophe comes first, then quoting for the CR.
    expect(csvField("\r=1")).toBe(`"'\r=1"`);
    expect(csvField("=1,2")).toBe(`"'=1,2"`);
  });

  it("guards only the start of the text and the places after a ';' or a tab", () => {
    expect(csvField("a=b")).toBe("a=b");
    expect(csvField(" =1")).toBe(" =1");
    expect(csvField("a=b;c")).toBe(`"a=b;c"`);
  });

  it("guards a formula after a ';' or a tab, for readers that split on them (D-244)", () => {
    expect(csvField("x;=1+1;y")).toBe(`"x;'=1+1;y"`);
    expect(csvField("x; =1+1")).toBe(`"x; '=1+1"`);
    expect(csvField("x;  @SUM(A1)")).toBe(`"x;  '@SUM(A1)"`);
    expect(csvField("a\t-2+3")).toBe(`"a\t'-2+3"`);
    expect(csvField(["cotton", "=1+1"])).toBe(`"cotton; '=1+1"`);
    // Every cell a ';'-splitting reader would see starts safely.
    for (const cell of guardFormula("x;=1;+2; -3;@4\t=5").split(/[;\t]/)) expect(cell.trimStart(), cell).not.toMatch(/^[=+\-@]/);
  });

  it("writes null and undefined as empty, booleans as true/false, dates as ISO", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(true)).toBe("true");
    expect(csvField(false)).toBe("false");
    expect(csvField(new Date("2026-11-02T08:05:00Z"))).toBe("2026-11-02T08:05:00.000Z");
  });

  it("writes numbers as they are, without the formula guard", () => {
    expect(csvField(4)).toBe("4");
    expect(csvField(129.5)).toBe("129.5");
    expect(csvField(-3)).toBe("-3");
    expect(csvField(Number.NaN)).toBe("");
  });

  it("joins lists with '; ' and quotes the joined text, guarding each entry", () => {
    expect(csvField(["navy", "black"])).toBe('"navy; black"');
    expect(csvField(["navy"])).toBe("navy");
    expect(csvField([])).toBe("");
    expect(csvField(["wool, merino", "silk"])).toBe('"wool, merino; silk"');
    expect(csvField(["=evil", "ok"])).toBe(`"'=evil; ok"`);
  });

  it("exposes the guard and the quoting on their own", () => {
    expect(guardFormula("=1")).toBe("'=1");
    expect(guardFormula("1")).toBe("1");
    expect(guardFormula("a;=1")).toBe("a;'=1");
    expect(quoteCsvField('"')).toBe('""""');
    expect(quoteCsvField("a;b")).toBe('"a;b"');
    expect(quoteCsvField("a\tb")).toBe('"a\tb"');
  });
});

describe("csvRow", () => {
  it("joins fields with commas and ends with CRLF", () => {
    expect(csvRow(["a", 1, true, null, ["x", "y"]])).toBe(`a,1,true,,"x; y"${CSV_EOL}`);
  });

  it("round-trips through an RFC 4180 reader", () => {
    const values = ['he said "hi", then left', "plain", "=2+2"];
    const line = csvRow(values);
    expect(parseRecord(line.slice(0, -CSV_EOL.length))).toEqual([values[0], "plain", "'=2+2"]);
  });
});

describe("item rows", () => {
  it("keeps a stable header order", () => {
    expect(ITEM_CSV_HEADERS).toEqual([
      "id",
      "name",
      "category",
      "subcategory",
      "status",
      "location",
      "decision",
      "colors",
      "color_hex",
      "materials",
      "material_guess",
      "warmth_level",
      "waterproof",
      "windproof",
      "insulated",
      "breathable",
      "seasons",
      "formality",
      "pattern",
      "fit",
      "condition",
      "brand",
      "size",
      "description",
      "notes",
      "purchase_price",
      "currency",
      "purchase_date",
      "wear_count",
      "last_worn_at",
      "created_at",
      "updated_at",
      "processed_image_url",
      "original_image_url",
      "nobg_image_url",
      // Added with running gear (D-252): new columns go at the end.
      "collection",
    ]);
    expect(ITEM_CSV_HEADERS).toHaveLength(36);
    expect(itemCsvHeaderRow()).toBe(`${ITEM_CSV_HEADERS.join(",")}${CSV_EOL}`);
  });

  it("writes the item's collection in the last column (D-252)", () => {
    const fields = (item: ItemCsvSource) => parseRecord(itemCsvRow(item).slice(0, -CSV_EOL.length));
    const running = fields({ ...ITEM, name: "Trail shoes", category: "shoes", collection: "running" });
    expect(running).toHaveLength(ITEM_CSV_HEADERS.length);
    expect(running.at(-1)).toBe("running");
    expect(fields(ITEM).at(-1)).toBe("clothing");
  });

  it("writes one item under the headers, with lists, booleans, nulls and photo URLs", () => {
    const line = itemCsvRow(ITEM);
    expect(line.endsWith(CSV_EOL)).toBe(true);
    const fields = parseRecord(line.slice(0, -CSV_EOL.length));
    expect(fields).toHaveLength(ITEM_CSV_HEADERS.length);
    const record = Object.fromEntries(ITEM_CSV_HEADERS.map((header, index) => [header, fields[index]]));
    expect(record).toMatchObject({
      id: ITEM.id,
      name: "Navy wool coat",
      colors: "navy; black",
      color_hex: "#1f2a44; #000000",
      warmth_level: "4",
      waterproof: "false",
      windproof: "true",
      breathable: "",
      seasons: "winter; autumn",
      pattern: "",
      description: "Knee-length, two buttons",
      notes: "",
      purchase_price: "129.5",
      purchase_date: "2024-10-01",
      wear_count: "3",
      last_worn_at: "2026-10-30T08:00:00.000Z",
      created_at: "2026-11-01T10:00:00.000Z",
      processed_image_url: ITEM.imageUrls.processed,
      original_image_url: ITEM.imageUrls.original,
      nobg_image_url: "",
      collection: "clothing",
    });
  });

  it("guards formulas in free text such as notes and brand", () => {
    const fields = parseRecord(
      itemCsvRow({ ...ITEM, notes: "=cmd|' /C calc'!A0", brand: "@brand" }).slice(0, -CSV_EOL.length),
    );
    expect(fields[ITEM_CSV_HEADERS.indexOf("notes")]).toBe("'=cmd|' /C calc'!A0");
    expect(fields[ITEM_CSV_HEADERS.indexOf("brand")]).toBe("'@brand");
  });

  it("keeps a multi-line description inside one quoted field", () => {
    const line = itemCsvRow({ ...ITEM, description: "Line one\r\nLine two" });
    expect(line).toContain('"Line one\r\nLine two"');
    expect(line.endsWith(`${CSV_EOL}`)).toBe(true);
  });

  it("starts files with a UTF-8 byte-order mark", () => {
    expect(CSV_BOM).toBe("﻿");
    expect([...new TextEncoder().encode(CSV_BOM)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
