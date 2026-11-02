import "server-only";

import { TAG_FIELD_TO_TAGS_KEY, tagsToItemColumns, type ItemTags } from "@/lib/ai/tagging/schema";
import type { ItemStatus } from "@/lib/db/enums";
import type { Item, NewItem } from "@/lib/db/schema";
import { EDITABLE_TAG_FIELDS, TAG_FIELD_TO_COLUMN, type EditableTagField, type ItemPatch } from "@/lib/items/contracts";

// Which tags the owner has changed, and how a new tagging result is applied
// around them (spec: "edited fields are recorded in user_edited_fields";
// D-023: Re-tag keeps them). Pure functions shared by the edit, tag and batch
// services, so a synchronous re-tag and a batch result treat edits the same way.

/** Lists compared as sets: their order carries no meaning. colors and color_hex are ordered (dominant first). */
const UNORDERED_FIELDS: ReadonlySet<EditableTagField> = new Set(["materials", "seasons"]);

/** Nullable text the form may clear to "" instead of null; both mean "none". */
const EMPTY_MEANS_NULL: ReadonlySet<EditableTagField> = new Set(["fit", "brand"]);

/** Fields where null is a value the owner can choose ("unknown", "no brand"), so an edited null is kept. */
const NULL_IS_A_CHOICE: ReadonlySet<EditableTagField> = new Set(["breathable", "fit", "brand"]);

const EDITABLE: ReadonlySet<string> = new Set(EDITABLE_TAG_FIELDS);

export function isEditableTagField(value: string): value is EditableTagField {
  return EDITABLE.has(value);
}

/** The tagging output as a key lookup, or null when the item has never been tagged. */
function aiValues(aiRaw: unknown): Map<string, unknown> | null {
  if (typeof aiRaw !== "object" || aiRaw === null || Array.isArray(aiRaw)) return null;
  return new Map<string, unknown>(Object.entries(aiRaw));
}

/** A comparable form of a tag value under the field's equality rules. */
function canonical(field: EditableTagField, value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (value === "" && EMPTY_MEANS_NULL.has(field)) return "null";
  if (Array.isArray(value)) {
    const entries = value.map((entry) => String(entry));
    return JSON.stringify(UNORDERED_FIELDS.has(field) ? entries.sort() : entries);
  }
  return JSON.stringify(value);
}

/**
 * colors and color_hex are parallel lists. If only one of them were kept on a
 * re-tag, a kept list and a new one could differ in length, so they count as
 * edited together.
 */
function coupleColors(edited: Set<EditableTagField>): void {
  if (edited.has("colors") || edited.has("color_hex")) {
    edited.add("colors");
    edited.add("color_hex");
  }
}

/**
 * The user_edited_fields after a patch: the previous list plus every tag field
 * in the patch whose value differs from Claude's (sticky: setting a field back
 * to Claude's value does not un-mark it). With no tagging output yet, every
 * tag field in the patch counts as edited. Non-tag fields (size, notes, price,
 * location, decision...) are never tracked. Returned in EDITABLE_TAG_FIELDS order.
 */
export function computeUserEditedFields(
  aiRaw: unknown,
  previous: readonly string[],
  patch: ItemPatch,
): EditableTagField[] {
  const edited = new Set<EditableTagField>(previous.filter(isEditableTagField));
  const ai = aiValues(aiRaw);
  for (const field of EDITABLE_TAG_FIELDS) {
    const next: unknown = patch[field];
    if (next === undefined) continue;
    const key = TAG_FIELD_TO_TAGS_KEY[field];
    if (ai === null || !ai.has(key) || canonical(field, next) !== canonical(field, ai.get(key))) {
      edited.add(field);
    }
  }
  coupleColors(edited);
  return EDITABLE_TAG_FIELDS.filter((field) => edited.has(field));
}

/** pending_tagging becomes tagged; tagged, confirmed and archived items keep their status. */
export function statusAfterTagging(status: ItemStatus): ItemStatus {
  return status === "pending_tagging" ? "tagged" : status;
}

type TagColumn = (typeof TAG_FIELD_TO_COLUMN)[EditableTagField];

/** Everything a successful tagging result writes to the item row, in one update. */
export type TaggedItemUpdate = Pick<
  NewItem,
  TagColumn | "aiConfidence" | "aiRaw" | "aiModel" | "aiPromptVersion" | "taggingError" | "taggingBatchId" | "status"
>;

/**
 * Whether the row holds a value worth keeping for an edited field. Only a
 * hand-edited database could leave a required field empty; then Claude's value
 * is written so the row still passes items_tagged_complete_check.
 */
function hasKeepableValue(field: EditableTagField, current: Item): boolean {
  if (NULL_IS_A_CHOICE.has(field)) return true;
  const value = current[TAG_FIELD_TO_COLUMN[field]];
  if (value === null) return false;
  if (field === "seasons" && Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The update for applying `tags` to `current`: Claude's values for every tag
 * field except those in current.userEditedFields, which keep the owner's
 * values. Also records the raw output, model and prompt version, clears the
 * tagging error and batch link, and sets the status (a confirmed item stays
 * confirmed).
 */
export function taggedItemUpdate(
  current: Item,
  tags: ItemTags,
  meta: { model: string; promptVersion: string },
): TaggedItemUpdate {
  const ai = tagsToItemColumns(tags);
  const edited = new Set(current.userEditedFields.filter(isEditableTagField));
  coupleColors(edited);
  const keep = (field: EditableTagField): boolean => edited.has(field) && hasKeepableValue(field, current);
  // The colour lists are kept or replaced as a pair, and only when they still line up.
  const keepColors =
    edited.has("colors") && current.colors.length > 0 && current.colors.length === current.colorHex.length;

  return {
    name: keep("name") ? current.name : ai.name,
    category: keep("category") ? current.category : ai.category,
    subcategory: keep("subcategory") ? current.subcategory : ai.subcategory,
    colors: keepColors ? current.colors : ai.colors,
    colorHex: keepColors ? current.colorHex : ai.colorHex,
    materialGuess: keep("material_guess") ? current.materialGuess : ai.materialGuess,
    materials: keep("materials") ? current.materials : ai.materials,
    warmthLevel: keep("warmth_level") ? current.warmthLevel : ai.warmthLevel,
    waterproof: keep("waterproof") ? current.waterproof : ai.waterproof,
    windproof: keep("windproof") ? current.windproof : ai.windproof,
    insulated: keep("insulated") ? current.insulated : ai.insulated,
    breathable: keep("breathable") ? current.breathable : ai.breathable,
    seasons: keep("seasons") ? current.seasons : ai.seasons,
    formality: keep("formality") ? current.formality : ai.formality,
    pattern: keep("pattern") ? current.pattern : ai.pattern,
    fit: keep("fit") ? current.fit : ai.fit,
    condition: keep("condition") ? current.condition : ai.condition,
    brand: keep("brand") ? current.brand : ai.brand,
    description: keep("description") ? current.description : ai.description,
    aiConfidence: ai.aiConfidence,
    aiRaw: tags,
    aiModel: meta.model,
    aiPromptVersion: meta.promptVersion,
    taggingError: null,
    taggingBatchId: null,
    status: statusAfterTagging(current.status),
  };
}
