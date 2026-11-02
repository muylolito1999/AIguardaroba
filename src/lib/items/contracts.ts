// Item contracts shared by client components, route handlers, actions and
// services: zod schemas for request bodies and edits, the item card DTO, Blob
// upload payloads and paths. Client bundles import this module, so it must stay
// free of `server-only`, env access, Node APIs and the database client. The
// `@/lib/db/schema` import below is type-only and erased at build time.

import { z } from "zod";

import {
  FORMALITIES,
  ITEM_CATEGORIES,
  ITEM_CONDITIONS,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  ITEM_STATUSES,
  SEASONS,
  type Formality,
  type ItemCategory,
  type ItemCondition,
  type ItemDecision,
  type ItemLocation,
  type ItemStatus,
  type Season,
} from "@/lib/db/enums";
import type { NewItem } from "@/lib/db/schema";
import { ERROR_CODES, type Result } from "@/lib/result";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A lowercase sha256 hex digest. */
export const HEX64 = /^[0-9a-f]{64}$/;
/** sha256 of the original file bytes, computed in the browser before upload. */
export const SourceHashSchema = z.string().regex(HEX64, "Expected a lowercase sha256 hex digest.");

/** True for a string the database will accept as a uuid; lets callers answer NOT_FOUND instead of a SQL error. */
export function isUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

// ---------------------------------------------------------------------------
// Tag fields
// ---------------------------------------------------------------------------

export const WARMTH_LEVELS = [1, 2, 3, 4, 5] as const;
export type WarmthLevel = (typeof WARMTH_LEVELS)[number];

/**
 * Length limits shared by the tagging schema, the edit form and the patch
 * schema, so Claude's output and a user's edit pass the same checks.
 */
export const TAG_LIMITS = {
  nameMax: 60,
  /** subcategory, pattern, material_guess and fit. */
  shortTextMax: 40,
  descriptionMax: 200,
  brandMax: 60,
  colorsMin: 1,
  colorsMax: 4,
  materialsMax: 5,
  /** One colour name or material. */
  listEntryMax: 40,
} as const;

export const COLOR_HEX = /^#[0-9a-f]{6}$/;

/** The tag fields a user can edit; items.user_edited_fields stores these snake_case names. */
export const EDITABLE_TAG_FIELDS = [
  "name",
  "category",
  "subcategory",
  "colors",
  "color_hex",
  "material_guess",
  "materials",
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
  "description",
] as const;
export type EditableTagField = (typeof EDITABLE_TAG_FIELDS)[number];

function hasDuplicates(values: readonly string[], normalize: (value: string) => string = (value) => value): boolean {
  return new Set(values.map(normalize)).size !== values.length;
}

const listEntry = z.string().trim().min(1).max(TAG_LIMITS.listEntryMax);
const shortText = z.string().trim().max(TAG_LIMITS.shortTextMax);

/**
 * Field-level validators in their strict form, shared by ItemTagsSchema (keyed
 * by the wire names) and ItemPatchSchema (keyed by the editable names). Forms
 * can compose their own object from these. Cross-field rules (colors and
 * color_hex of equal length) live on the object schemas.
 */
export const ITEM_FIELD_SCHEMAS = {
  name: z.string().trim().min(1).max(TAG_LIMITS.nameMax),
  category: z.enum(ITEM_CATEGORIES),
  subcategory: shortText,
  colors: z
    .array(listEntry)
    .min(TAG_LIMITS.colorsMin)
    .max(TAG_LIMITS.colorsMax)
    // "Navy" and "navy" are the same colour.
    .refine((colors) => !hasDuplicates(colors, (color) => color.toLowerCase()), "Colours must be unique."),
  color_hex: z
    // Lowercased before the check: "#1A2B3C" from Claude or a pasted value is
    // the same colour, and rejecting it would cost a paid retry of the reply.
    .array(z.string().trim().toLowerCase().regex(COLOR_HEX, "Use a #rrggbb colour."))
    .max(TAG_LIMITS.colorsMax),
  material_guess: shortText,
  materials: z.array(listEntry).max(TAG_LIMITS.materialsMax),
  warmth_level: z.literal(WARMTH_LEVELS),
  waterproof: z.boolean(),
  windproof: z.boolean(),
  insulated: z.boolean(),
  /** null when the photo cannot tell. */
  breathable: z.boolean().nullable(),
  seasons: z
    .array(z.enum(SEASONS))
    .min(1, "Pick at least one season.")
    .refine((seasons) => !hasDuplicates(seasons), "Seasons must be unique."),
  formality: z.enum(FORMALITIES),
  pattern: shortText,
  fit: shortText.nullable(),
  condition: z.enum(ITEM_CONDITIONS),
  brand: z.string().trim().max(TAG_LIMITS.brandMax).nullable(),
  description: z.string().trim().max(TAG_LIMITS.descriptionMax),
} as const;

/** Adds an issue when colors and color_hex are not the same length; both schemas share it. */
export function checkColorHexLength(
  value: { colors?: readonly string[] | undefined; color_hex?: readonly string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.colors === undefined && value.color_hex === undefined) return;
  if (value.colors === undefined || value.color_hex === undefined) {
    // The two lists are parallel (one swatch per colour name), so an edit that
    // changed one without the other could leave them misaligned.
    ctx.addIssue({
      code: "custom",
      path: [value.colors === undefined ? "colors" : "color_hex"],
      message: "Send colors and color_hex together.",
    });
    return;
  }
  if (value.colors.length !== value.color_hex.length) {
    ctx.addIssue({
      code: "custom",
      path: ["color_hex"],
      message: "Give one hex colour for each colour name.",
    });
  }
}

// ---------------------------------------------------------------------------
// Item edits
// ---------------------------------------------------------------------------

/**
 * Every editable field, all optional, without the cross-field check. zod
 * forbids pick/partial/extend on a refined object, so forms that need those
 * start from this and add checkColorHexLength themselves.
 */
export const ItemPatchFieldsSchema = z.strictObject({
  name: ITEM_FIELD_SCHEMAS.name.optional(),
  category: ITEM_FIELD_SCHEMAS.category.optional(),
  subcategory: ITEM_FIELD_SCHEMAS.subcategory.optional(),
  colors: ITEM_FIELD_SCHEMAS.colors.optional(),
  color_hex: ITEM_FIELD_SCHEMAS.color_hex.optional(),
  material_guess: ITEM_FIELD_SCHEMAS.material_guess.optional(),
  materials: ITEM_FIELD_SCHEMAS.materials.optional(),
  warmth_level: ITEM_FIELD_SCHEMAS.warmth_level.optional(),
  waterproof: ITEM_FIELD_SCHEMAS.waterproof.optional(),
  windproof: ITEM_FIELD_SCHEMAS.windproof.optional(),
  insulated: ITEM_FIELD_SCHEMAS.insulated.optional(),
  breathable: ITEM_FIELD_SCHEMAS.breathable.optional(),
  seasons: ITEM_FIELD_SCHEMAS.seasons.optional(),
  formality: ITEM_FIELD_SCHEMAS.formality.optional(),
  pattern: ITEM_FIELD_SCHEMAS.pattern.optional(),
  fit: ITEM_FIELD_SCHEMAS.fit.optional(),
  condition: ITEM_FIELD_SCHEMAS.condition.optional(),
  brand: ITEM_FIELD_SCHEMAS.brand.optional(),
  description: ITEM_FIELD_SCHEMAS.description.optional(),
  size: z.string().trim().max(40).nullable().optional(),
  notes: z.string().max(2000).optional(),
  purchase_price: z.number().min(0).max(100_000).nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Use a three-letter currency code such as EUR.")
    .optional(),
  purchase_date: z.iso.date().nullable().optional(),
  location: z.enum(ITEM_LOCATIONS).optional(),
  decision: z.enum(ITEM_DECISIONS).optional(),
});

/** A partial edit of an item. colors and color_hex must be sent together and match in length. */
export const ItemPatchSchema = ItemPatchFieldsSchema.superRefine(checkColorHexLength);
export type ItemPatch = z.infer<typeof ItemPatchSchema>;
/** What a form holds before zod trims strings; equal to ItemPatch in shape. */
export type ItemPatchInput = z.input<typeof ItemPatchSchema>;
export type ItemPatchField = keyof ItemPatch;

/** Drizzle item keys for the editable tag fields. */
export const TAG_FIELD_TO_COLUMN = {
  name: "name",
  category: "category",
  subcategory: "subcategory",
  colors: "colors",
  color_hex: "colorHex",
  material_guess: "materialGuess",
  materials: "materials",
  warmth_level: "warmthLevel",
  waterproof: "waterproof",
  windproof: "windproof",
  insulated: "insulated",
  breathable: "breathable",
  seasons: "seasons",
  formality: "formality",
  pattern: "pattern",
  fit: "fit",
  condition: "condition",
  brand: "brand",
  description: "description",
} as const satisfies Record<EditableTagField, keyof NewItem>;

/** Drizzle item keys for every ItemPatch field. */
export const ITEM_PATCH_FIELD_TO_COLUMN = {
  ...TAG_FIELD_TO_COLUMN,
  size: "size",
  notes: "notes",
  purchase_price: "purchasePrice",
  currency: "currency",
  purchase_date: "purchaseDate",
  location: "location",
  decision: "decision",
} as const satisfies Record<ItemPatchField, keyof NewItem>;

export type ItemPatchColumns = Partial<
  Pick<NewItem, (typeof ITEM_PATCH_FIELD_TO_COLUMN)[ItemPatchField]>
>;

/** Maps a validated patch to drizzle column values, leaving out the keys it does not set. */
export function patchToItemColumns(patch: ItemPatch): ItemPatchColumns {
  const columns: ItemPatchColumns = {};
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.category !== undefined) columns.category = patch.category;
  if (patch.subcategory !== undefined) columns.subcategory = patch.subcategory;
  if (patch.colors !== undefined) columns.colors = patch.colors;
  if (patch.color_hex !== undefined) columns.colorHex = patch.color_hex;
  if (patch.material_guess !== undefined) columns.materialGuess = patch.material_guess;
  if (patch.materials !== undefined) columns.materials = patch.materials;
  if (patch.warmth_level !== undefined) columns.warmthLevel = patch.warmth_level;
  if (patch.waterproof !== undefined) columns.waterproof = patch.waterproof;
  if (patch.windproof !== undefined) columns.windproof = patch.windproof;
  if (patch.insulated !== undefined) columns.insulated = patch.insulated;
  if (patch.breathable !== undefined) columns.breathable = patch.breathable;
  if (patch.seasons !== undefined) columns.seasons = patch.seasons;
  if (patch.formality !== undefined) columns.formality = patch.formality;
  if (patch.pattern !== undefined) columns.pattern = patch.pattern;
  if (patch.fit !== undefined) columns.fit = patch.fit;
  if (patch.condition !== undefined) columns.condition = patch.condition;
  if (patch.brand !== undefined) columns.brand = patch.brand;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.size !== undefined) columns.size = patch.size;
  if (patch.notes !== undefined) columns.notes = patch.notes;
  if (patch.purchase_price !== undefined) columns.purchasePrice = patch.purchase_price;
  if (patch.currency !== undefined) columns.currency = patch.currency;
  if (patch.purchase_date !== undefined) columns.purchaseDate = patch.purchase_date;
  if (patch.location !== undefined) columns.location = patch.location;
  if (patch.decision !== undefined) columns.decision = patch.decision;
  return columns;
}

// ---------------------------------------------------------------------------
// Item card DTO
// ---------------------------------------------------------------------------

export type ItemImageRef = { url: string; width: number; height: number };

/** One item as the add, review and wardrobe screens show it. Tag fields are null until the item is tagged. */
export type ItemCardDto = {
  id: string;
  status: ItemStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
  name: string | null;
  category: ItemCategory | null;
  subcategory: string | null;
  /** Dominant colour first. */
  colors: string[];
  /** Parallel to colors. */
  colorHex: string[];
  materialGuess: string | null;
  materials: string[];
  warmthLevel: number | null;
  waterproof: boolean | null;
  windproof: boolean | null;
  insulated: boolean | null;
  breathable: boolean | null;
  seasons: Season[];
  formality: Formality | null;
  pattern: string | null;
  fit: string | null;
  condition: ItemCondition | null;
  brand: string | null;
  size: string | null;
  description: string | null;
  notes: string;
  purchasePrice: number | null;
  currency: string;
  /** YYYY-MM-DD. */
  purchaseDate: string | null;
  location: ItemLocation;
  decision: ItemDecision;
  /** Per-field confidence from 0 to 1, keyed by the tagging confidence keys. */
  aiConfidence: Record<string, number> | null;
  multipleItemsDetected: boolean;
  /** EditableTagField names. */
  userEditedFields: string[];
  taggingError: string | null;
  taggingBatchId: string | null;
  aiModel: string | null;
  images: {
    thumb: ItemImageRef | null;
    processed: ItemImageRef | null;
    nobg: ItemImageRef | null;
  };
};

const ItemImageRefSchema = z.object({
  url: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

/** Parses item cards in route responses on the client. Unknown keys are dropped, so the server can add fields first. */
export const ItemCardDtoSchema: z.ZodType<ItemCardDto> = z.object({
  id: z.string(),
  status: z.enum(ITEM_STATUSES),
  createdAt: z.string(),
  name: z.string().nullable(),
  category: z.enum(ITEM_CATEGORIES).nullable(),
  subcategory: z.string().nullable(),
  colors: z.array(z.string()),
  colorHex: z.array(z.string()),
  materialGuess: z.string().nullable(),
  materials: z.array(z.string()),
  warmthLevel: z.number().nullable(),
  waterproof: z.boolean().nullable(),
  windproof: z.boolean().nullable(),
  insulated: z.boolean().nullable(),
  breathable: z.boolean().nullable(),
  seasons: z.array(z.enum(SEASONS)),
  formality: z.enum(FORMALITIES).nullable(),
  pattern: z.string().nullable(),
  fit: z.string().nullable(),
  condition: z.enum(ITEM_CONDITIONS).nullable(),
  brand: z.string().nullable(),
  size: z.string().nullable(),
  description: z.string().nullable(),
  notes: z.string(),
  purchasePrice: z.number().nullable(),
  currency: z.string(),
  purchaseDate: z.string().nullable(),
  location: z.enum(ITEM_LOCATIONS),
  decision: z.enum(ITEM_DECISIONS),
  aiConfidence: z.record(z.string(), z.number()).nullable(),
  multipleItemsDetected: z.boolean(),
  userEditedFields: z.array(z.string()),
  taggingError: z.string().nullable(),
  taggingBatchId: z.string().nullable(),
  aiModel: z.string().nullable(),
  images: z.object({
    thumb: ItemImageRefSchema.nullable(),
    processed: ItemImageRefSchema.nullable(),
    nobg: ItemImageRefSchema.nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Blob uploads
// ---------------------------------------------------------------------------

export const UPLOAD_LIMITS = {
  originalMaxBytes: 10 * 1024 * 1024,
  originalContentTypes: ["image/jpeg", "image/png", "image/webp"],
  nobgMaxBytes: 15 * 1024 * 1024,
  nobgContentTypes: ["image/png"],
} as const;

/**
 * What the browser sends as upload()'s clientPayload (JSON.stringify'd), so
 * /api/blob/upload knows which item and pathname the token is for.
 */
export const BlobClientPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("original"), itemId: z.uuid(), sourceHash: SourceHashSchema }),
  z.strictObject({ kind: z.literal("nobg"), itemId: z.uuid() }),
]);
export type BlobClientPayload = z.infer<typeof BlobClientPayloadSchema>;

/** The pathname the client asks for; addRandomSuffix inserts "-<suffix>" before the extension. */
export function originalUploadPathname(itemId: string): string {
  return `items/${itemId}/original.jpg`;
}

export function nobgUploadPathname(itemId: string): string {
  return `items/${itemId}/nobg.png`;
}

/** Prefix every stored original of the item starts with, whatever suffix Blob added. */
export function originalUploadPrefix(itemId: string): string {
  return `items/${itemId}/original`;
}

export function nobgUploadPrefix(itemId: string): string {
  return `items/${itemId}/nobg`;
}

const RANDOM_SUFFIX = /^-[A-Za-z0-9_-]{1,64}$/;

/**
 * True when a stored pathname is `requested` itself or `requested` with a
 * random suffix before the extension. Stricter than a prefix check: it rules
 * out extra path segments and other extensions.
 */
export function matchesUploadPathname(pathname: string, requested: string): boolean {
  if (pathname === requested) return true;
  const dot = requested.lastIndexOf(".");
  if (dot <= requested.lastIndexOf("/")) return false;
  const base = requested.slice(0, dot);
  const extension = requested.slice(dot);
  if (!pathname.startsWith(base) || !pathname.endsWith(extension)) return false;
  const suffix = pathname.slice(base.length, pathname.length - extension.length);
  return RANDOM_SUFFIX.test(suffix);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const ITEM_API = {
  blobUpload: "/api/blob/upload",
  checkHashes: "/api/items/check-hashes",
  register: "/api/items/register",
  tag: (itemId: string) => `/api/items/${itemId}/tag`,
  nobg: (itemId: string) => `/api/items/${itemId}/nobg`,
  pollBatchesCron: "/api/cron/poll-batches",
} as const;

// Blob URLs are always https; anything else cannot be one of ours.
const blobUrl = z.url({ protocol: /^https$/ });
const blobPathname = z.string().min(1).max(300);

export const CheckHashesBodySchema = z.strictObject({
  sourceHashes: z.array(SourceHashSchema).min(1).max(500),
});
export type CheckHashesBody = z.infer<typeof CheckHashesBodySchema>;
export type CheckHashesData = {
  /** sourceHash -> id of the item that already has it. */
  known: Record<string, string>;
};
export const CheckHashesDataSchema: z.ZodType<CheckHashesData> = z.object({
  known: z.record(z.string(), z.string()),
});

export const RegisterBodySchema = z.strictObject({
  itemId: z.uuid(),
  url: blobUrl,
  pathname: blobPathname,
  sourceHash: SourceHashSchema,
  originalFilename: z.string().max(255),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type RegisterData = { duplicate: false; item: ItemCardDto } | { duplicate: true; existingItemId: string };
export const RegisterDataSchema: z.ZodType<RegisterData> = z.discriminatedUnion("duplicate", [
  z.object({ duplicate: z.literal(false), item: ItemCardDtoSchema }),
  z.object({ duplicate: z.literal(true), existingItemId: z.string() }),
]);

export const TagBodySchema = z.strictObject({
  /** Re-tag even when the item already has tags (the Re-tag button). */
  force: z.boolean().default(false),
  /**
   * The batch the card believes the item waits in ("Tag now instead"). When
   * the item is no longer linked to it and already has tags, the server
   * answers with those tags instead of a forced call: the batch was applied
   * after the card was rendered.
   */
  batchId: z.uuid().optional(),
});
export type TagBody = z.infer<typeof TagBodySchema>;
export type TagData = { cached: boolean; item: ItemCardDto };
export const TagDataSchema: z.ZodType<TagData> = z.object({ cached: z.boolean(), item: ItemCardDtoSchema });

/** Tagging limits shared by the add page, the review page and the batch service (D-024, D-074). */
export const TAGGING_LIMITS = {
  /** Tagging calls the browser runs at once. */
  concurrency: 4,
  /** A batch is offered for more than 20 items; fewer are tagged directly. */
  batchMinItems: 21,
  /** One batch per run; far below the API's 100,000 requests. */
  batchMaxItems: 1_000,
} as const;

/** What the startTaggingBatch action returns. */
export type StartTaggingBatchData = {
  /** ai_batches.id, the value items.tagging_batch_id now holds. */
  batchId: string;
  /** Items covered: the dry-run item plus the batched ones. */
  count: number;
  /** Estimated USD for the dry run plus the batch. */
  estimateUsd: number;
  /** The first item, already tagged synchronously before the batch was created. */
  dryRunItemId: string;
};

/**
 * Set in the details of a failed batch start when the dry run had already
 * tagged its item, so the page can show that item as tagged and leave it out
 * of the next attempt.
 */
export const TAGGED_ITEM_DETAIL = "taggedItemId";

/** The item id a failed batch start already tagged, if any. */
export function taggedItemIdFrom(details: Record<string, unknown> | undefined): string | null {
  const value = details?.[TAGGED_ITEM_DETAIL];
  return typeof value === "string" ? value : null;
}

/**
 * Set in the details of a batch start whose dry run failed: the item that was
 * tagged as a test and now carries the stored tagging_error. The page can
 * show that error on the item; the next start picks another item first.
 */
export const DRY_RUN_ITEM_DETAIL = "dryRunItemId";

/** The item whose dry run failed in a failed batch start, if any. */
export function dryRunItemIdFrom(details: Record<string, unknown> | undefined): string | null {
  const value = details?.[DRY_RUN_ITEM_DETAIL];
  return typeof value === "string" ? value : null;
}

export const NobgBodySchema = z.strictObject({ url: blobUrl, pathname: blobPathname });
export type NobgBody = z.infer<typeof NobgBodySchema>;
export type NobgData = { item: ItemCardDto };
export const NobgDataSchema: z.ZodType<NobgData> = z.object({ item: ItemCardDtoSchema });

const AppErrorPayloadSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Parses a route's JSON Result<T> on the client: resultSchema(TagDataSchema).safeParse(await res.json()). */
export function resultSchema<T>(data: z.ZodType<T>): z.ZodType<Result<T>> {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: AppErrorPayloadSchema }),
  ]);
}
