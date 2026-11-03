import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import type { ItemStatus } from "@/lib/db/enums";
import { items, type NewItem } from "@/lib/db/schema";
import {
  isHandTagDefault,
  isUuid,
  ItemPatchSchema,
  patchToItemColumns,
  UncheckedDefaultsSchema,
  type EditableTagField,
  type HandTagDefaultField,
  type ItemCardDto,
  type ItemPatch,
} from "@/lib/items/contracts";
import { AppError } from "@/lib/result";
import { loadItemCard } from "@/server/items/dto";
import { computeUserEditedFields, handTaggedEditedFields } from "@/server/items/user-edited-fields";

// Edits, confirmation and tagging by hand from the review screen (spec Phase
// 3: "Confirm sets status confirmed; edited fields are recorded in
// user_edited_fields"). Each edit reads and writes the row in one transaction
// with a row lock, so two saves of the same card cannot lose each other's
// user_edited_fields.

/** Upper bound for "Confirm all untouched" in one call. */
export const CONFIRM_MANY_MAX = 500;

const CONFIRMABLE: ReadonlySet<ItemStatus> = new Set(["tagged", "confirmed"]);
const NEEDS_COMPLETE_TAGS: ReadonlySet<ItemStatus> = new Set(["tagged", "confirmed"]);

type CompletenessColumns = Pick<
  NewItem,
  | "name"
  | "category"
  | "colors"
  | "warmthLevel"
  | "waterproof"
  | "windproof"
  | "insulated"
  | "seasons"
  | "formality"
  | "condition"
>;

/**
 * Tag fields a tagged or confirmed item cannot be without: the columns of
 * items_tagged_complete_check plus a name and at least one colour, which every
 * valid tagging output has. Returned as EditableTagField names.
 */
export function missingTagFields(row: CompletenessColumns): EditableTagField[] {
  const missing: EditableTagField[] = [];
  if (row.name === null || row.name === undefined || row.name.trim() === "") missing.push("name");
  if (row.category === null || row.category === undefined) missing.push("category");
  if (row.colors === undefined || row.colors.length === 0) missing.push("colors");
  if (row.warmthLevel === null || row.warmthLevel === undefined) missing.push("warmth_level");
  if (row.waterproof === null || row.waterproof === undefined) missing.push("waterproof");
  if (row.windproof === null || row.windproof === undefined) missing.push("windproof");
  if (row.insulated === null || row.insulated === undefined) missing.push("insulated");
  if (row.seasons === undefined || row.seasons.length === 0) missing.push("seasons");
  if (row.formality === null || row.formality === undefined) missing.push("formality");
  if (row.condition === null || row.condition === undefined) missing.push("condition");
  return missing;
}

function notFound(id: string): AppError {
  return new AppError("NOT_FOUND", "That item no longer exists.", { itemId: id });
}

/**
 * Validates again at the service boundary: callers other than the action
 * wrapper (scripts, later phases) must not be able to write an unchecked patch.
 */
function parsePatch(patch: ItemPatch): ItemPatch {
  const parsed = ItemPatchSchema.safeParse(patch);
  if (parsed.success) return parsed.data;
  throw new AppError("VALIDATION", "Some fields are missing or invalid.", {
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

/** Applies a patch (and optionally confirms) inside one locked read-modify-write. */
async function editItem(db: Db, id: string, patch: ItemPatch | undefined, confirm: boolean): Promise<void> {
  if (!isUuid(id)) throw notFound(id);
  const validated = patch === undefined ? undefined : parsePatch(patch);

  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(items).where(eq(items.id, id)).for("update");
    if (row === undefined) throw notFound(id);
    if (confirm && !CONFIRMABLE.has(row.status)) {
      throw new AppError(
        "VALIDATION",
        row.status === "archived"
          ? "Archived items cannot be confirmed."
          : "This item has no tags yet. Tag it before confirming.",
        { itemId: id, status: row.status },
      );
    }

    const columns = validated === undefined ? {} : patchToItemColumns(validated);
    const userEditedFields =
      validated === undefined ? row.userEditedFields : computeUserEditedFields(row.aiRaw, row.userEditedFields, validated);
    const status: ItemStatus = confirm ? "confirmed" : row.status;

    // A validated patch cannot clear a required tag, but a row edited by hand
    // could lack one; answering VALIDATION beats a CHECK violation (a 500).
    if (NEEDS_COMPLETE_TAGS.has(status)) {
      const missing = missingTagFields({ ...row, ...columns });
      if (missing.length > 0) {
        throw new AppError("VALIDATION", `Fill in ${missing.join(", ").replaceAll("_", " ")} first.`, {
          itemId: id,
          missing,
        });
      }
    }

    await tx
      .update(items)
      .set({ ...columns, userEditedFields, status })
      .where(eq(items.id, id));
  });
}

/** Saves an edit of any item fields; tag fields that differ from Claude's are added to user_edited_fields. */
export async function updateItem(db: Db, id: string, patch: ItemPatch): Promise<ItemCardDto> {
  await requireSession();
  await editItem(db, id, patch, false);
  return loadItemCard(db, id);
}

/**
 * Confirms a tagged (or already confirmed) item, applying an optional patch in
 * the same update. VALIDATION when the item has no tags yet or would lack a
 * required tag.
 */
export async function confirmItem(db: Db, id: string, patch?: ItemPatch): Promise<ItemCardDto> {
  await requireSession();
  await editItem(db, id, patch, true);
  return loadItemCard(db, id);
}

/**
 * Checks which fields the form says the owner left at its starting value. The
 * client is not trusted with what a Re-tag may replace: only fields that have
 * a form default may be listed, and only while the patch holds that default.
 * Any other list is refused rather than reinterpreted (D-232).
 */
function parseUncheckedDefaults(patch: ItemPatch, claimed: readonly HandTagDefaultField[]): HandTagDefaultField[] {
  const parsed = UncheckedDefaultsSchema.safeParse(claimed);
  if (!parsed.success) {
    throw new AppError("VALIDATION", "Some fields are missing or invalid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: ["uncheckedDefaults", ...issue.path.map(String)].join("."),
        message: issue.message,
      })),
    });
  }
  const mismatched = parsed.data.filter((field) => !isHandTagDefault(field, patch[field]));
  if (mismatched.length > 0) {
    throw new AppError("VALIDATION", "The form's default values did not match. Reload the page and try again.", {
      uncheckedDefaults: mismatched,
    });
  }
  return parsed.data;
}

/**
 * Tags a pending item from the owner's own values, without Claude (D-093,
 * resolving D-066's dead end for items Claude refuses, and catalogues items without AI
 * spend). The merged row must have every required tag and a season, as for
 * any tagged item. Every tag field the owner set is recorded in
 * user_edited_fields, so a later Re-tag keeps it; the fields in
 * `uncheckedDefaults`, left at the form's own starting value, are stored but
 * not recorded, so a Re-tag may replace them (D-232). ai_raw, ai_model and
 * ai_confidence stay null and tagging_error is cleared. The item becomes
 * tagged, or confirmed with `confirm`. CONFLICT when the item waits in a batch
 * or already has tags; VALIDATION when a required tag is missing or the list
 * of unchecked defaults does not match the patch.
 */
export async function tagItemByHand(
  db: Db,
  id: string,
  patch: ItemPatch,
  options: { confirm: boolean; uncheckedDefaults: readonly HandTagDefaultField[] },
): Promise<ItemCardDto> {
  await requireSession();
  if (!isUuid(id)) throw notFound(id);
  const validated = parsePatch(patch);
  const uncheckedDefaults = parseUncheckedDefaults(validated, options.uncheckedDefaults);

  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(items).where(eq(items.id, id)).for("update");
    if (row === undefined) throw notFound(id);
    if (row.taggingBatchId !== null) {
      throw new AppError(
        "CONFLICT",
        "This item is waiting in a tagging batch. Wait for its result, or tag it now from its card.",
        { itemId: id, batchId: row.taggingBatchId },
      );
    }
    if (row.status !== "pending_tagging" || row.aiRaw !== null) {
      throw new AppError("CONFLICT", "This item already has tags. Reload the page to see them.", {
        itemId: id,
        status: row.status,
      });
    }

    const columns = patchToItemColumns(validated);
    const missing = missingTagFields({ ...row, ...columns });
    if (missing.length > 0) {
      throw new AppError("VALIDATION", `Fill in ${missing.join(", ").replaceAll("_", " ")} first.`, {
        itemId: id,
        missing,
      });
    }

    const userEditedFields = handTaggedEditedFields(row.userEditedFields, validated, uncheckedDefaults);

    await tx
      .update(items)
      .set({ ...columns, userEditedFields, status: options.confirm ? "confirmed" : "tagged", taggingError: null })
      .where(eq(items.id, id));
  });
  return loadItemCard(db, id);
}

/**
 * "Confirm all untouched": confirms those of `ids` that are still tagged and
 * skips the rest (pending, already confirmed, archived, deleted or malformed
 * ids). Tagged rows already satisfy the completeness check, which is the same
 * for confirmed rows.
 */
export async function confirmItems(db: Db, ids: readonly string[]): Promise<{ confirmed: number }> {
  await requireSession();
  const valid = [...new Set(ids)].filter(isUuid);
  if (valid.length > CONFIRM_MANY_MAX) {
    throw new AppError("VALIDATION", `Confirm at most ${CONFIRM_MANY_MAX} items at a time.`, {
      count: valid.length,
    });
  }
  if (valid.length === 0) return { confirmed: 0 };
  const rows = await db
    .update(items)
    .set({ status: "confirmed" })
    .where(and(inArray(items.id, valid), eq(items.status, "tagged")))
    .returning({ id: items.id });
  return { confirmed: rows.length };
}
