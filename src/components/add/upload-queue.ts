// State of the add flow as plain data: one entry per chosen photo, with its
// upload stage and, once registered, its tagging stage. The reducer is pure so
// the transitions can be tested without React; the async pipeline that drives
// it lives in use-add-flow.ts.

import type { ItemCollection } from "@/lib/db/enums"
import type { ItemCardDto } from "@/lib/items/contracts"
import type { AppErrorPayload } from "@/lib/result"

/** The pipeline step an upload failed in; Retry resumes there. */
export type UploadStep = "prepare" | "check" | "upload" | "register"

export type UploadStage =
  | { kind: "waiting" }
  | { kind: "preparing" }
  | { kind: "checking" }
  | { kind: "uploading"; percent: number }
  | { kind: "saving" }
  | { kind: "ready" }
  | { kind: "duplicate"; where: "wardrobe" | "queue"; existingItemId: string | null }
  | { kind: "failed"; step: UploadStep; error: AppErrorPayload }

export type TagStage =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "tagging" }
  | { kind: "tagged"; cached: boolean }
  | { kind: "batched" }
  | { kind: "failed"; error: AppErrorPayload }

export type QueueEntry = {
  /** Local id, independent of the item id the server will store. */
  key: string
  fileName: string
  /**
   * Stamped when the photo was queued, from the "Adding running gear" switch,
   * and sent with its register (D-252). Turning the switch later leaves it alone.
   */
  collection: ItemCollection
  upload: UploadStage
  /** Object URL of the prepared JPEG, then the server thumbnail once registered. */
  previewUrl: string | null
  item: ItemCardDto | null
  tag: TagStage
}

export type AddFlowState = {
  entries: QueueEntry[]
  /** Set by a BUDGET_EXCEEDED answer; no new tagging calls start while it is set. */
  budgetBlock: AppErrorPayload | null
  /** The "Adding running gear" switch: what photos queued from now on are stamped with (D-252). */
  collection: ItemCollection
}

export type AddFlowAction =
  | { type: "add"; entries: Array<{ key: string; fileName: string; collection: ItemCollection }> }
  | { type: "upload"; key: string; stage: UploadStage }
  | { type: "preview"; key: string; url: string | null }
  | { type: "registered"; key: string; item: ItemCardDto }
  | { type: "tag"; keys: readonly string[]; stage: TagStage }
  | { type: "tagged"; key: string; item: ItemCardDto; cached: boolean }
  | { type: "remove"; key: string }
  | { type: "budgetBlocked"; error: AppErrorPayload }
  /** A fresh server read of the budget found room again. */
  | { type: "budgetLifted" }
  /** The switch changed; entries already queued keep their own stamp. */
  | { type: "setCollection"; collection: ItemCollection }
  /**
   * The page was left (or hidden): the queue starts empty on return and the
   * switch is off again, so a later visit never marks clothes as running gear
   * unasked (D-252); the budget block stays.
   */
  | { type: "reset" }

export const INITIAL_ADD_FLOW_STATE: AddFlowState = { entries: [], budgetBlock: null, collection: "clothing" }

function updateEntry(state: AddFlowState, key: string, update: (entry: QueueEntry) => QueueEntry): AddFlowState {
  let changed = false
  const entries = state.entries.map((entry) => {
    if (entry.key !== key) return entry
    const updated = update(entry)
    if (updated !== entry) changed = true
    return updated
  })
  return changed ? { ...state, entries } : state
}

export function addFlowReducer(state: AddFlowState, action: AddFlowAction): AddFlowState {
  switch (action.type) {
    case "add":
      return {
        ...state,
        entries: [
          ...state.entries,
          ...action.entries.map(
            ({ key, fileName, collection }): QueueEntry => ({
              key,
              fileName,
              collection,
              upload: { kind: "waiting" },
              previewUrl: null,
              item: null,
              tag: { kind: "idle" },
            }),
          ),
        ],
      }
    case "upload":
      return updateEntry(state, action.key, (entry) => {
        // Progress events arrive many times a second; skip renders that change nothing.
        if (
          entry.upload.kind === "uploading" &&
          action.stage.kind === "uploading" &&
          entry.upload.percent === action.stage.percent
        ) {
          return entry
        }
        return { ...entry, upload: action.stage }
      })
    case "preview":
      return updateEntry(state, action.key, (entry) => ({ ...entry, previewUrl: action.url }))
    case "registered":
      return updateEntry(state, action.key, (entry) => ({
        ...entry,
        item: action.item,
        upload: { kind: "ready" },
        // A photo the server already tagged (same image, new upload) needs no call.
        tag: action.item.status === "pending_tagging" ? { kind: "idle" } : { kind: "tagged", cached: true },
      }))
    case "tag": {
      const keys = new Set(action.keys)
      return {
        ...state,
        entries: state.entries.map((entry) => (keys.has(entry.key) ? { ...entry, tag: action.stage } : entry)),
      }
    }
    case "tagged":
      return updateEntry(state, action.key, (entry) => ({
        ...entry,
        item: action.item,
        tag: { kind: "tagged", cached: action.cached },
      }))
    case "remove":
      return { ...state, entries: state.entries.filter((entry) => entry.key !== action.key) }
    case "budgetBlocked":
      return {
        ...state,
        budgetBlock: action.error,
        // Calls that had not started yet go back to idle, so the counts stay honest.
        entries: state.entries.map((entry) =>
          entry.tag.kind === "queued" ? { ...entry, tag: { kind: "idle" } } : entry,
        ),
      }
    case "budgetLifted":
      return state.budgetBlock === null ? state : { ...state, budgetBlock: null }
    case "setCollection":
      return state.collection === action.collection ? state : { ...state, collection: action.collection }
    case "reset":
      return { ...state, entries: [], collection: "clothing" }
  }
}

const IN_FLIGHT_UPLOADS: ReadonlySet<UploadStage["kind"]> = new Set([
  "waiting",
  "preparing",
  "checking",
  "uploading",
  "saving",
])

export function isUploadInFlight(entry: QueueEntry): boolean {
  return IN_FLIGHT_UPLOADS.has(entry.upload.kind)
}

/** Registered and not tagged yet: what "Start tagging" and the batch offer work on. */
export function isUntaggedReady(entry: QueueEntry): boolean {
  return entry.upload.kind === "ready" && entry.item !== null && entry.tag.kind === "idle"
}

export type QueueCounts = {
  total: number
  uploading: number
  ready: number
  duplicates: number
  uploadFailed: number
  untagged: number
  tagging: number
  tagged: number
  batched: number
  tagFailed: number
}

export function countEntries(entries: readonly QueueEntry[]): QueueCounts {
  const counts: QueueCounts = {
    total: entries.length,
    uploading: 0,
    ready: 0,
    duplicates: 0,
    uploadFailed: 0,
    untagged: 0,
    tagging: 0,
    tagged: 0,
    batched: 0,
    tagFailed: 0,
  }
  for (const entry of entries) {
    if (isUploadInFlight(entry)) counts.uploading += 1
    else if (entry.upload.kind === "duplicate") counts.duplicates += 1
    else if (entry.upload.kind === "failed") counts.uploadFailed += 1
    else if (entry.upload.kind === "ready") {
      counts.ready += 1
      switch (entry.tag.kind) {
        case "idle":
          counts.untagged += 1
          break
        case "queued":
        case "tagging":
          counts.tagging += 1
          break
        case "tagged":
          counts.tagged += 1
          break
        case "batched":
          counts.batched += 1
          break
        case "failed":
          counts.tagFailed += 1
          break
      }
    }
  }
  return counts
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * One sentence for the polite live region. It changes only when a count
 * changes, never on upload percentages, so screen readers are not flooded.
 */
export function progressAnnouncement(counts: QueueCounts): string {
  if (counts.total === 0) return ""
  const parts = [`${counts.ready} of ${plural(counts.total, "photo", "photos")} uploaded`]
  if (counts.uploading > 0) parts.push(`${counts.uploading} in progress`)
  if (counts.duplicates > 0) parts.push(`${counts.duplicates} already in your wardrobe`)
  if (counts.uploadFailed > 0) parts.push(`${counts.uploadFailed} failed`)
  if (counts.tagging > 0) parts.push(`${counts.tagging} tagging`)
  if (counts.tagged > 0) parts.push(`${counts.tagged} tagged`)
  if (counts.batched > 0) parts.push(`${counts.batched} in a batch`)
  if (counts.tagFailed > 0) parts.push(`${plural(counts.tagFailed, "tag", "tags")} failed`)
  return `${parts.join(", ")}.`
}

/** True while leaving the page would cancel something: an upload, or a tagging call not yet sent. */
export function hasWorkInFlight(counts: QueueCounts): boolean {
  return counts.uploading > 0 || counts.tagging > 0
}

/**
 * The leave dialog's explanation. Uploads in progress are aborted and must be
 * picked again; tagging calls already sent finish on the server, and the ones
 * still waiting simply do not start. A batch start is one server call that
 * leaving does not stop, so its items must not be tagged again elsewhere.
 */
export function leaveWarning(counts: QueueCounts, { batchPending = false }: { batchPending?: boolean } = {}): string {
  const parts: string[] = []
  if (counts.uploading > 0) {
    parts.push(
      `${plural(counts.uploading, "photo is", "photos are")} still being uploaded. Leaving cancels ` +
        `${counts.uploading === 1 ? "it" : "them"}, and you would need to pick ` +
        `${counts.uploading === 1 ? "it" : "them"} again.`,
    )
  }
  if (counts.tagging > 0) {
    parts.push(
      batchPending
        ? "A batch is being started for these items. Leaving does not stop it; the review page shows them in " +
            "the batch once it has started."
        : `${plural(counts.tagging, "item is", "items are")} being tagged. Any that have not started stay ` +
            "untagged; you can tag them from the review page.",
    )
  }
  if (parts.length === 0) return "Everything has finished, so nothing will be lost."
  return parts.join(" ")
}

export function uploadStatusText(stage: UploadStage): string {
  switch (stage.kind) {
    case "waiting":
      return "Waiting"
    case "preparing":
      return "Preparing"
    case "checking":
      return "Checking"
    case "uploading":
      return `Uploading ${stage.percent}%`
    case "saving":
      return "Saving"
    case "ready":
      return "Ready"
    case "duplicate":
      return stage.where === "wardrobe" ? "Already in your wardrobe" : "Already in this list"
    case "failed":
      return `Failed: ${stage.error.message}`
  }
}

/** Null while there is nothing to say about tagging yet. */
export function tagStatusText(stage: TagStage): string | null {
  switch (stage.kind) {
    case "idle":
      return null
    case "queued":
      return "Waiting to tag"
    case "tagging":
      return "Tagging"
    case "tagged":
      return "Tagged"
    case "batched":
      return "In a batch: results usually within an hour"
    case "failed":
      return `Tagging failed: ${stage.error.message}`
  }
}
