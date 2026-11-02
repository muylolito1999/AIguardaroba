// drizzle-kit loads this file directly, so it must not import `server-only`
// (D-017) and must use relative imports (the kit does not resolve `@/`).
// `snakeCase.table` maps camelCase keys to snake_case column names, so no
// driver needs a casing option (D-008).

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { ClimateMonth } from "../climate/types";
import {
  AI_CALL_STATUSES,
  AI_PURPOSES,
  ANALYSIS_KINDS,
  ANALYSIS_PART_KINDS,
  ANALYSIS_STATUSES,
  BATCH_STATUSES,
  FORMALITIES,
  IMAGE_KINDS,
  ITEM_CATEGORIES,
  ITEM_CONDITIONS,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  ITEM_STATUSES,
  OUTFIT_SLOTS,
  OUTFIT_SOURCES,
  PACKING_GROUPS,
  PART_STATUSES,
  SEASONS,
  SHOPPING_STATUSES,
} from "./enums";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const itemStatusEnum = pgEnum("item_status", ITEM_STATUSES);
export const itemLocationEnum = pgEnum("item_location", ITEM_LOCATIONS);
export const itemDecisionEnum = pgEnum("item_decision", ITEM_DECISIONS);
export const itemCategoryEnum = pgEnum("item_category", ITEM_CATEGORIES);
export const formalityEnum = pgEnum("formality", FORMALITIES);
export const itemConditionEnum = pgEnum("item_condition", ITEM_CONDITIONS);
export const imageKindEnum = pgEnum("image_kind", IMAGE_KINDS);
export const analysisKindEnum = pgEnum("analysis_kind", ANALYSIS_KINDS);
export const analysisStatusEnum = pgEnum("analysis_status", ANALYSIS_STATUSES);
export const analysisPartKindEnum = pgEnum("analysis_part_kind", ANALYSIS_PART_KINDS);
export const partStatusEnum = pgEnum("part_status", PART_STATUSES);
export const shoppingStatusEnum = pgEnum("shopping_status", SHOPPING_STATUSES);
export const packingGroupEnum = pgEnum("packing_group", PACKING_GROUPS);
export const outfitSourceEnum = pgEnum("outfit_source", OUTFIT_SOURCES);
export const outfitSlotEnum = pgEnum("outfit_slot", OUTFIT_SLOTS);
export const aiPurposeEnum = pgEnum("ai_purpose", AI_PURPOSES);
export const aiCallStatusEnum = pgEnum("ai_call_status", AI_CALL_STATUSES);
export const batchStatusEnum = pgEnum("batch_status", BATCH_STATUSES);

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const id = () => uuid().primaryKey().defaultRandom();
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
// A non-null text[] that starts empty, so code never has to handle null arrays.
const textList = () =>
  text()
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);
// Six decimals keep sub-cent token costs exact; mode number because the
// amounts stay far below float precision limits.
const usd = () => numeric({ precision: 12, scale: 6, mode: "number" });
const eur = () => numeric({ precision: 10, scale: 2, mode: "number" });

// Built from the shared constant so the CHECK and the TS list cannot drift
// apart; the values are fixed literals, never user input.
const seasonLiterals = SEASONS.map((season) => `'${season}'`).join(", ");
const SEASONS_SQL = sql.raw(`ARRAY[${seasonLiterals}]::text[]`);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Message Batches submitted for tagging (D-024). */
export const aiBatches = snakeCase.table(
  "ai_batches",
  {
    id: id(),
    anthropicBatchId: text().notNull().unique(),
    purpose: aiPurposeEnum().notNull(),
    model: text().notNull(),
    status: batchStatusEnum().notNull().default("in_progress"),
    itemIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    requestCount: integer().notNull(),
    // Counted by the budget check until the batch is processed (D-020).
    estimatedCostUsd: usd().notNull().default(0),
    costUsd: usd().notNull().default(0),
    createdAt: createdAt(),
    endedAt: timestamp({ withTimezone: true }),
    processedAt: timestamp({ withTimezone: true }),
    error: text(),
  },
  (t) => [index("ai_batches_status_idx").on(t.status)],
);

export const items = snakeCase.table(
  "items",
  {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    status: itemStatusEnum().notNull().default("pending_tagging"),
    location: itemLocationEnum().notNull().default("bologna"),
    decision: itemDecisionEnum().notNull().default("undecided"),
    // Tag columns stay null until the item is tagged; the
    // items_tagged_complete_check below enforces them for tagged items.
    name: text(),
    category: itemCategoryEnum(),
    subcategory: text(),
    /** Dominant colour first. */
    colors: textList(),
    colorHex: textList(),
    materialGuess: text(),
    materials: textList(),
    warmthLevel: integer(),
    waterproof: boolean(),
    windproof: boolean(),
    insulated: boolean(),
    breathable: boolean(),
    seasons: textList(),
    formality: formalityEnum(),
    pattern: text(),
    fit: text(),
    condition: itemConditionEnum(),
    brand: text(),
    size: text(),
    description: text(),
    notes: text().notNull().default(""),
    purchasePrice: eur(),
    currency: char({ length: 3 }).notNull().default("EUR"),
    purchaseDate: date({ mode: "string" }),
    /** The full validated tagging output. */
    aiRaw: jsonb(),
    aiModel: text(),
    aiPromptVersion: text(),
    /** Per-field confidence from 0 to 1. */
    aiConfidence: jsonb().$type<Record<string, number>>(),
    /** sha256 of the processed image; the tagging cache key (D-033). */
    imageHash: text().notNull().unique(),
    /** sha256 of the original upload, used to skip known photos before upload. */
    sourceHash: text().unique(),
    userEditedFields: textList(),
    wearCount: integer().notNull().default(0),
    lastWornAt: timestamp({ withTimezone: true }),
    taggingError: text(),
    taggingBatchId: uuid().references(() => aiBatches.id, { onDelete: "set null" }),
  },
  (t) => [
    check("items_warmth_level_check", sql`${t.warmthLevel} BETWEEN 1 AND 5`),
    check("items_seasons_check", sql`${t.seasons} <@ ${SEASONS_SQL}`),
    check("items_wear_count_check", sql`${t.wearCount} >= 0`),
    // A tagged or confirmed item must carry every field the relocation
    // payload and the filters rely on; pending and archived items may not.
    check(
      "items_tagged_complete_check",
      sql`${t.status} NOT IN ('tagged', 'confirmed') OR (${sql.join(
        [
          ...[t.category, t.warmthLevel, t.waterproof, t.windproof, t.insulated, t.formality, t.condition].map(
            (column) => sql`${column} IS NOT NULL`,
          ),
          sql`cardinality(${t.seasons}) > 0`,
        ],
        sql` AND `,
      )})`,
    ),
    index("items_status_idx").on(t.status),
    index("items_category_idx").on(t.category),
    index("items_location_idx").on(t.location),
    index("items_decision_idx").on(t.decision),
    index("items_created_at_idx").on(t.createdAt),
    index("items_tagging_batch_id_idx").on(t.taggingBatchId),
  ],
);

export const itemImages = snakeCase.table(
  "item_images",
  {
    id: id(),
    itemId: uuid()
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    kind: imageKindEnum().notNull(),
    blobUrl: text().notNull(),
    blobPathname: text().notNull(),
    contentType: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    bytes: integer().notNull(),
    // Lets the usage page count this month's Blob writes.
    createdAt: createdAt(),
  },
  (t) => [unique("item_images_item_id_kind_unique").on(t.itemId, t.kind)],
);

export const climateProfiles = snakeCase.table(
  "climate_profiles",
  {
    id: id(),
    slug: text().notNull().unique(),
    city: text().notNull(),
    country: text().notNull(),
    lat: doublePrecision().notNull(),
    lon: doublePrecision().notNull(),
    timezone: text().notNull(),
    source: text().notNull(),
    /** January to December; values are nullable until the owner fills them in. */
    months: jsonb().$type<ClimateMonth[]>().notNull(),
    windNotes: text().notNull().default(""),
    notes: text().notNull().default(""),
    isDefault: boolean().notNull().default(false),
    isPlaceholder: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one default profile (the relocation form's preselection).
    uniqueIndex("climate_profiles_single_default_idx").on(t.isDefault).where(sql`${t.isDefault}`),
    // CASE keeps jsonb_array_length away from non-array values, which it rejects with an error.
    check(
      "climate_profiles_months_check",
      sql`CASE WHEN jsonb_typeof(${t.months}) = 'array' THEN jsonb_array_length(${t.months}) = 12 ELSE false END`,
    ),
  ],
);

export const analyses = snakeCase.table(
  "analyses",
  {
    id: id(),
    createdAt: createdAt(),
    kind: analysisKindEnum().notNull(),
    status: analysisStatusEnum().notNull().default("pending"),
    climateProfileId: uuid().references(() => climateProfiles.id, { onDelete: "set null" }),
    dateFrom: date({ mode: "string" }),
    dateTo: date({ mode: "string" }),
    params: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    model: text().notNull(),
    effort: text(),
    promptVersion: text().notNull(),
    inputSnapshotHash: text(),
    /** Snapshot hash plus params; an identical earlier run is reused (D-028). */
    cacheKey: text(),
    inputSnapshot: jsonb(),
    result: jsonb(),
    estimatedCostUsd: usd(),
    costUsd: usd().notNull().default(0),
    error: text(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("analyses_cache_key_idx").on(t.cacheKey),
    index("analyses_kind_created_at_idx").on(t.kind, t.createdAt),
    index("analyses_climate_profile_id_idx").on(t.climateProfileId),
  ],
);

/** Resumable pieces of one analysis: category chunks plus a synthesis (D-025). */
export const analysisParts = snakeCase.table(
  "analysis_parts",
  {
    id: id(),
    analysisId: uuid()
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    kind: analysisPartKindEnum().notNull(),
    partIndex: integer().notNull(),
    status: partStatusEnum().notNull().default("pending"),
    input: jsonb().notNull(),
    result: jsonb(),
    costUsd: usd().notNull().default(0),
    attempts: integer().notNull().default(0),
    error: text(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique("analysis_parts_analysis_id_kind_part_index_unique").on(t.analysisId, t.kind, t.partIndex)],
);

export const shoppingListItems = snakeCase.table(
  "shopping_list_items",
  {
    id: id(),
    analysisId: uuid().references(() => analyses.id, { onDelete: "set null" }),
    itemType: text().notNull(),
    category: itemCategoryEnum(),
    priority: integer().notNull().default(2),
    reason: text().notNull().default(""),
    /** Spec lines such as "waterproof ≥10,000 mm, hood" (D-027). */
    specs: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    budgetHintEur: eur(),
    quantity: integer().notNull().default(1),
    estPriceMinEur: eur(),
    estPriceMaxEur: eur(),
    /** before_move, after_move or either (D-027). */
    buyTiming: text(),
    status: shoppingStatusEnum().notNull().default("todo"),
    linkedItemId: uuid().references(() => items.id, { onDelete: "set null" }),
    /** Stable key of an analysis gap, so "add gaps" is idempotent (D-029). */
    gapKey: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check("shopping_list_items_priority_check", sql`${t.priority} BETWEEN 1 AND 3`),
    check("shopping_list_items_quantity_check", sql`${t.quantity} >= 1`),
    unique("shopping_list_items_analysis_id_gap_key_unique").on(t.analysisId, t.gapKey),
    index("shopping_list_items_linked_item_id_idx").on(t.linkedItemId),
  ],
);

export const packingChecklistItems = snakeCase.table(
  "packing_checklist_items",
  {
    id: id(),
    analysisId: uuid()
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    itemId: uuid().references(() => items.id, { onDelete: "set null" }),
    label: text().notNull(),
    packed: boolean().notNull().default(false),
    // "group" is a reserved word; Drizzle always quotes identifiers.
    group: packingGroupEnum().notNull(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [
    index("packing_checklist_items_analysis_id_idx").on(t.analysisId),
    index("packing_checklist_items_item_id_idx").on(t.itemId),
  ],
);

export const outfits = snakeCase.table(
  "outfits",
  {
    id: id(),
    name: text().notNull(),
    occasion: text(),
    weatherMinC: numeric({ precision: 4, scale: 1, mode: "number" }),
    weatherMaxC: numeric({ precision: 4, scale: 1, mode: "number" }),
    rainOk: boolean().notNull().default(false),
    source: outfitSourceEnum().notNull().default("user"),
    rating: integer(),
    notes: text().notNull().default(""),
    aiReasoning: text(),
    createdAt: createdAt(),
  },
  (t) => [check("outfits_rating_check", sql`${t.rating} BETWEEN 1 AND 5`)],
);

export const outfitItems = snakeCase.table(
  "outfit_items",
  {
    outfitId: uuid()
      .notNull()
      .references(() => outfits.id, { onDelete: "cascade" }),
    itemId: uuid()
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    slot: outfitSlotEnum().notNull(),
  },
  (t) => [primaryKey({ columns: [t.outfitId, t.itemId] }), index("outfit_items_item_id_idx").on(t.itemId)],
);

export const wearLogs = snakeCase.table(
  "wear_logs",
  {
    id: id(),
    // Both references cascade instead of SET NULL: with SET NULL, deleting the
    // only referenced row would null both columns, the CHECK below would
    // reject that, and the item or outfit could not be deleted at all.
    itemId: uuid().references(() => items.id, { onDelete: "cascade" }),
    outfitId: uuid().references(() => outfits.id, { onDelete: "cascade" }),
    wornOn: date({ mode: "string" }).notNull(),
    weatherSnapshot: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [
    check("wear_logs_target_check", sql`${t.itemId} IS NOT NULL OR ${t.outfitId} IS NOT NULL`),
    index("wear_logs_item_id_idx").on(t.itemId),
    index("wear_logs_outfit_id_idx").on(t.outfitId),
  ],
);

/** One row per Claude attempt, failed ones included (D-020). */
export const aiCalls = snakeCase.table(
  "ai_calls",
  {
    id: id(),
    createdAt: createdAt(),
    model: text().notNull(),
    purpose: aiPurposeEnum().notNull(),
    status: aiCallStatusEnum().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheCreationInputTokens: integer().notNull().default(0),
    cacheReadInputTokens: integer().notNull().default(0),
    // Named explicitly: snake-casing the key would give cache_write1h_tokens.
    cacheWrite1hTokens: integer("cache_write_1h_tokens").notNull().default(0),
    thinkingTokens: integer().notNull().default(0),
    /** standard or long (Haiku's long-context tier, D-021). */
    pricingTier: text(),
    isBatch: boolean().notNull().default(false),
    costUsd: usd().notNull().default(0),
    latencyMs: integer(),
    requestId: text(),
    stopReason: text(),
    errorCode: text(),
    errorMessage: text(),
    attempt: integer().notNull().default(1),
    itemId: uuid().references(() => items.id, { onDelete: "set null" }),
    analysisId: uuid().references(() => analyses.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ai_calls_created_at_idx").on(t.createdAt),
    index("ai_calls_purpose_created_at_idx").on(t.purpose, t.createdAt),
    // ai_calls grows by one row per Claude attempt; without these, deleting an
    // item or analysis scans the whole table for its ON DELETE SET NULL.
    index("ai_calls_item_id_idx").on(t.itemId),
    index("ai_calls_analysis_id_idx").on(t.analysisId),
  ],
);

/** Login rate limiting, keyed by sha256(ip|SESSION_SECRET); raw IPs are never stored (D-014). */
export const loginAttempts = snakeCase.table(
  "login_attempts",
  {
    id: id(),
    keyHash: text().notNull(),
    success: boolean().notNull(),
    attemptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_key_hash_attempted_at_idx").on(t.keyHash, t.attemptedAt)],
);

/** A single row (id 1) of app-wide settings. */
export const appSettings = snakeCase.table(
  "app_settings",
  {
    id: integer().primaryKey().default(1),
    homeProfileId: uuid().references(() => climateProfiles.id, { onDelete: "set null" }),
    defaultItemLocation: itemLocationEnum().notNull().default("bologna"),
    updatedAt: updatedAt(),
  },
  (t) => [check("app_settings_single_row_check", sql`${t.id} = 1`)],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemImage = typeof itemImages.$inferSelect;
export type NewItemImage = typeof itemImages.$inferInsert;
export type ClimateProfile = typeof climateProfiles.$inferSelect;
export type NewClimateProfile = typeof climateProfiles.$inferInsert;
export type Analysis = typeof analyses.$inferSelect;
export type NewAnalysis = typeof analyses.$inferInsert;
export type AnalysisPart = typeof analysisParts.$inferSelect;
export type NewAnalysisPart = typeof analysisParts.$inferInsert;
export type ShoppingListItem = typeof shoppingListItems.$inferSelect;
export type NewShoppingListItem = typeof shoppingListItems.$inferInsert;
export type PackingChecklistItem = typeof packingChecklistItems.$inferSelect;
export type NewPackingChecklistItem = typeof packingChecklistItems.$inferInsert;
export type Outfit = typeof outfits.$inferSelect;
export type NewOutfit = typeof outfits.$inferInsert;
export type OutfitItem = typeof outfitItems.$inferSelect;
export type NewOutfitItem = typeof outfitItems.$inferInsert;
export type WearLog = typeof wearLogs.$inferSelect;
export type NewWearLog = typeof wearLogs.$inferInsert;
export type AiCall = typeof aiCalls.$inferSelect;
export type NewAiCall = typeof aiCalls.$inferInsert;
export type AiBatch = typeof aiBatches.$inferSelect;
export type NewAiBatch = typeof aiBatches.$inferInsert;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type NewLoginAttempt = typeof loginAttempts.$inferInsert;
export type AppSettings = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;
