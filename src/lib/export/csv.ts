// The item CSV export (spec Phase 4: portable data). Pure and free of
// `server-only`, so the export page and the Playwright spec can read the
// header list too.
//
// Format: RFC 4180 (fields with a comma, quote, CR or LF are quoted and their
// quotes doubled, and so are fields with ";" or a tab; records end with CRLF),
// UTF-8 with a byte-order mark so Excel opens accents correctly, lists joined
// with "; ", booleans as true/false and null as an empty field. Text that a
// spreadsheet would run as a formula gets an apostrophe (OWASP CSV injection
// guidance) at the start of the field and after any ";" or tab in it, because
// notes, names and brands are free text, and some were written by Claude from
// a photo (D-114, D-244).

import type { Item } from "@/lib/db/schema";

export const CSV_BOM = "﻿";
export const CSV_EOL = "\r\n";
export const CSV_LIST_SEPARATOR = "; ";

/** What one CSV field can be built from. Dates become ISO 8601 UTC. */
export type CsvValue = string | number | boolean | Date | null | undefined | readonly string[];

// = + - @ start a formula in Excel, LibreOffice and Google Sheets; a leading
// tab or carriage return can hide one of them from a quick look.
const FORMULA_START = /^[=+\-@\t\r]/;
// A spreadsheet that splits this comma file on ";" (Excel under a locale whose
// list separator is ";", such as Italian) or on a tab starts a new cell there,
// so the same characters after a ";" or a tab, spaces allowed, are guarded too
// (D-244).
const FORMULA_AFTER_SEPARATOR = /([;\t] *)([=+\-@])/g;
// ";" and tab are quoted as well, so a reader that splits on them but honours
// quotes keeps the field in one cell (D-244).
const NEEDS_QUOTES = /[",;\t\r\n]/;

/**
 * Puts an apostrophe before every place a spreadsheet could start a formula:
 * the start of the text, and right after a ";" or a tab inside it.
 */
export function guardFormula(text: string): string {
  const inner = text.replace(FORMULA_AFTER_SEPARATOR, "$1'$2");
  return FORMULA_START.test(inner) ? `'${inner}` : inner;
}

/** RFC 4180 quoting: fields with a comma, quote, CR or LF are quoted, and also ";" and tab (D-244). */
export function quoteCsvField(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One field. Only text goes through the formula guard: numbers, booleans and
 * dates are written by this code, never typed by a person, and a guarded
 * negative number would turn into text in the spreadsheet.
 */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === "string" ? value : value.join(CSV_LIST_SEPARATOR);
  return quoteCsvField(guardFormula(text));
}

/** One record, CRLF included. */
export function csvRow(values: readonly CsvValue[]): string {
  return `${values.map(csvField).join(",")}${CSV_EOL}`;
}

/** The photo kinds the CSV links to; thumbnails are left out as derived copies. */
export const CSV_IMAGE_KINDS = ["processed", "original", "nobg"] as const;
export type CsvImageKind = (typeof CSV_IMAGE_KINDS)[number];

/** An item row plus the URLs of its photos by kind. */
export type ItemCsvSource = Pick<
  Item,
  | "id"
  | "name"
  | "category"
  | "subcategory"
  | "status"
  | "location"
  | "decision"
  | "colors"
  | "colorHex"
  | "materials"
  | "materialGuess"
  | "warmthLevel"
  | "waterproof"
  | "windproof"
  | "insulated"
  | "breathable"
  | "seasons"
  | "formality"
  | "pattern"
  | "fit"
  | "condition"
  | "brand"
  | "size"
  | "description"
  | "notes"
  | "purchasePrice"
  | "currency"
  | "purchaseDate"
  | "wearCount"
  | "lastWornAt"
  | "createdAt"
  | "updatedAt"
> & { imageUrls: Partial<Record<CsvImageKind, string>> };

type ItemCsvColumn = { header: string; value: (item: ItemCsvSource) => CsvValue };

/**
 * The column order is part of the export format: new columns go at the end,
 * so spreadsheets and scripts built on an earlier export keep working.
 * AI bookkeeping (raw output, confidences, model) stays in the JSON export.
 */
const ITEM_CSV_COLUMNS: readonly ItemCsvColumn[] = [
  { header: "id", value: (item) => item.id },
  { header: "name", value: (item) => item.name },
  { header: "category", value: (item) => item.category },
  { header: "subcategory", value: (item) => item.subcategory },
  { header: "status", value: (item) => item.status },
  { header: "location", value: (item) => item.location },
  { header: "decision", value: (item) => item.decision },
  { header: "colors", value: (item) => item.colors },
  { header: "color_hex", value: (item) => item.colorHex },
  { header: "materials", value: (item) => item.materials },
  { header: "material_guess", value: (item) => item.materialGuess },
  { header: "warmth_level", value: (item) => item.warmthLevel },
  { header: "waterproof", value: (item) => item.waterproof },
  { header: "windproof", value: (item) => item.windproof },
  { header: "insulated", value: (item) => item.insulated },
  { header: "breathable", value: (item) => item.breathable },
  { header: "seasons", value: (item) => item.seasons },
  { header: "formality", value: (item) => item.formality },
  { header: "pattern", value: (item) => item.pattern },
  { header: "fit", value: (item) => item.fit },
  { header: "condition", value: (item) => item.condition },
  { header: "brand", value: (item) => item.brand },
  { header: "size", value: (item) => item.size },
  { header: "description", value: (item) => item.description },
  { header: "notes", value: (item) => item.notes },
  { header: "purchase_price", value: (item) => item.purchasePrice },
  { header: "currency", value: (item) => item.currency },
  { header: "purchase_date", value: (item) => item.purchaseDate },
  { header: "wear_count", value: (item) => item.wearCount },
  { header: "last_worn_at", value: (item) => item.lastWornAt },
  { header: "created_at", value: (item) => item.createdAt },
  { header: "updated_at", value: (item) => item.updatedAt },
  { header: "processed_image_url", value: (item) => item.imageUrls.processed },
  { header: "original_image_url", value: (item) => item.imageUrls.original },
  { header: "nobg_image_url", value: (item) => item.imageUrls.nobg },
];

export const ITEM_CSV_HEADERS: readonly string[] = ITEM_CSV_COLUMNS.map((column) => column.header);

/** The header record, CRLF included (the BOM is written separately, once). */
export function itemCsvHeaderRow(): string {
  return csvRow(ITEM_CSV_HEADERS);
}

/** One item's record, CRLF included. */
export function itemCsvRow(item: ItemCsvSource): string {
  return csvRow(ITEM_CSV_COLUMNS.map((column) => column.value(item)));
}
