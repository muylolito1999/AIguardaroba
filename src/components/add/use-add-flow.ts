// The add flow's engine: per photo, prepare -> check the source hash ->
// upload the original to Blob -> register, three photos at a time; then tag
// registered items through POST /api/items/[id]/tag, four at a time, or hand
// them to a Message Batch. Route Handlers rather than Server Actions carry the
// parallel work, because Next runs actions one at a time per client (D-035).

import pLimit from "p-limit"
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"

import { toast } from "@/components/ui/toast"
import type { ItemCollection } from "@/lib/db/enums"
import type { PreparedImage } from "@/lib/images/client-pipeline"
import {
  TAGGING_LIMITS,
  dryRunItemIdFrom,
  taggedItemIdFrom,
  type StartTaggingBatchData,
} from "@/lib/items/contracts"
import { err, type AppErrorPayload, type Result } from "@/lib/result"

import { NETWORK_ERROR_MESSAGE, type AddApi, type UploadedBlob } from "./add-api"
import { describeError, prepareFailure, toastIdFor, type AddFlowStep } from "./add-errors"
import { formatResetDate, formatUsd, type TaggingSetup } from "./cost-quote"
import { createHashBatcher } from "./hash-batcher"
import {
  INITIAL_ADD_FLOW_STATE,
  addFlowReducer,
  countEntries,
  isUntaggedReady,
  type AddFlowState,
  type QueueCounts,
  type UploadStep,
} from "./upload-queue"

export const UPLOAD_CONCURRENCY = 3
export const TAG_CONCURRENCY = TAGGING_LIMITS.concurrency
/** Batches are offered for more than 20 untagged items (spec; D-024). */
export const BATCH_MIN_ITEMS = TAGGING_LIMITS.batchMinItems

export type { StartTaggingBatchData }

export type AddFlowDeps = {
  prepareImage: (file: File) => Promise<PreparedImage>
  api: AddApi
  startTaggingBatch: (input: { itemIds: string[] }) => Promise<Result<StartTaggingBatchData>>
}

export type AddFlowOptions = {
  /**
   * The tagging setup the server rendered the page with. The budget block
   * starts from it, and a new one (a later server render) re-derives it.
   */
  serverSetup: Result<TaggingSetup>
  /** False while the tagging settings cannot be read: no tagging call starts. */
  taggingAvailable: boolean
  /** Called when a run of tagging calls has settled and after a batch start, to re-read the budget. */
  onTaggingSettled: () => void
}

/** Per-photo working data that does not belong in rendered state. */
type Job = {
  file: File
  /** Chosen once, so a retried upload or register stays idempotent on the server. */
  itemId: string
  /** The switch's value when the photo was queued; every register attempt sends it (D-252). */
  collection: ItemCollection
  prepared: PreparedImage | null
  checked: boolean
  uploaded: UploadedBlob | null
  /** The id the server stored, once registered. */
  registeredItemId: string | null
  objectUrl: string | null
  controller: AbortController
  removed: boolean
  /** The key of the entry this photo was found to repeat ("Already in this list"). */
  duplicateOf: string | null
}

type Duplicate = { where: "wardrobe"; existingItemId: string | null } | { where: "queue"; ownerKey: string }

export type AddFlow = {
  state: AddFlowState
  counts: QueueCounts
  batchPending: boolean
  /** Stamps the switch's current collection on each photo (D-252). */
  addFiles(files: readonly File[]): void
  /** The "Adding running gear" switch; photos already queued keep their stamp. */
  setCollection(collection: ItemCollection): void
  retryUpload(key: string): void
  retryTag(key: string): void
  remove(key: string): void
  startTagging(): void
  startBatch(): Promise<void>
}

/** The block a setup implies: none unless this month's budget is used up. */
export function budgetBlockFor(setup: Result<TaggingSetup>): AppErrorPayload | null {
  if (!setup.ok || setup.data.budget.remainingUsd > 0) return null
  const { budgetUsd, resetsAt } = setup.data.budget
  return {
    code: "BUDGET_EXCEEDED",
    message: `This month's AI budget of ${formatUsd(budgetUsd)} is used up. It resets on ${formatResetDate(resetsAt)}. Photos can still be uploaded.`,
  }
}

function existingItemIdFrom(error: AppErrorPayload): string | null {
  const details = error.details ?? {}
  for (const key of ["existingItemId", "itemId"]) {
    const value = details[key]
    if (typeof value === "string") return value
  }
  return null
}

/** Keys of the photos marked as repeating the entry `ownerKey` ("Already in this list"). */
function copiesOf(jobs: ReadonlyMap<string, Job>, ownerKey: string): string[] {
  return [...jobs].filter(([, job]) => job.duplicateOf === ownerKey).map(([key]) => key)
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

export function useAddFlow(deps: AddFlowDeps, { serverSetup, taggingAvailable, onTaggingSettled }: AddFlowOptions): AddFlow {
  const [state, dispatch] = useReducer(addFlowReducer, serverSetup, (setup) => ({
    ...INITIAL_ADD_FLOW_STATE,
    budgetBlock: budgetBlockFor(setup),
  }))
  const [budgetSource, setBudgetSource] = useState(serverSetup)
  if (serverSetup !== budgetSource) {
    // A new server render carries fresh numbers, so the block follows them.
    setBudgetSource(serverSetup)
    const block = budgetBlockFor(serverSetup)
    dispatch(block === null ? { type: "budgetLifted" } : { type: "budgetBlocked", error: block })
  }
  const [batchPending, setBatchPending] = useState(false)
  // rejectOnClear: calls cleared from the queue settle, so the counters below stay true.
  const [uploadLimit] = useState(() => pLimit({ concurrency: UPLOAD_CONCURRENCY, rejectOnClear: true }))
  const [tagLimit] = useState(() => pLimit({ concurrency: TAG_CONCURRENCY, rejectOnClear: true }))
  const [batcher] = useState(() => createHashBatcher((hashes) => deps.api.checkHashes(hashes)))

  // Read by the async pipeline, which must see the latest values rather than
  // those of the render that started it.
  const jobsRef = useRef(new Map<string, Job>())
  const hashOwnersRef = useRef(new Map<string, string>())
  const budgetBlockRef = useRef<AppErrorPayload | null>(state.budgetBlock)
  const syncedBudgetBlockRef = useRef<AppErrorPayload | null>(state.budgetBlock)
  const activeTagCallsRef = useRef(0)
  const disposedRef = useRef(false)
  const onTaggingSettledRef = useRef(onTaggingSettled)

  useLayoutEffect(() => {
    onTaggingSettledRef.current = onTaggingSettled
  }, [onTaggingSettled])

  useLayoutEffect(() => {
    // blockBudget writes the ref itself, at once; this copies only a change
    // made in render (a new server setup), so a commit that predates a block
    // cannot clear it.
    if (syncedBudgetBlockRef.current === state.budgetBlock) return
    syncedBudgetBlockRef.current = state.budgetBlock
    budgetBlockRef.current = state.budgetBlock
  }, [state.budgetBlock])

  // Leaving the page ends the flow. With cacheComponents, Next keeps a page
  // the owner navigates away from in a hidden <Activity> instead of
  // unmounting it: state survives, and this cleanup runs on the hide just as
  // on an unmount. So the queue is emptied here too, and a return to the page
  // starts fresh instead of showing rows whose work was cancelled, with the
  // running-gear switch off (D-252). A layout effect, so no stale frame is shown.
  useLayoutEffect(() => {
    const jobs = jobsRef.current
    const hashOwners = hashOwnersRef.current
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      uploadLimit.clearQueue()
      tagLimit.clearQueue()
      for (const job of jobs.values()) {
        job.removed = true
        job.controller.abort()
        if (job.objectUrl !== null) URL.revokeObjectURL(job.objectUrl)
      }
      jobs.clear()
      hashOwners.clear()
      dispatch({ type: "reset" })
    }
  }, [uploadLimit, tagLimit])

  // A page the browser restores from its back/forward cache runs no cleanup
  // and keeps every state as it was, the switch included. It is turned off
  // again there too, so returning to /add never marks clothes as running gear
  // unasked (D-252). Rows already queued keep their stamp.
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) dispatch({ type: "setCollection", collection: "clothing" })
    }
    window.addEventListener("pageshow", onPageShow)
    return () => window.removeEventListener("pageshow", onPageShow)
  }, [])

  function notify(step: AddFlowStep, error: AppErrorPayload): AppErrorPayload {
    const described = describeError(step, error)
    toast.add({ ...described.toast, priority: "high", id: toastIdFor(step, error) })
    return described.error
  }

  function failUpload(key: string, step: UploadStep, error: AppErrorPayload): void {
    dispatch({ type: "upload", key, stage: { kind: "failed", step, error: notify(step, error) } })
  }

  function dropPreview(key: string, job: Job, replacement: string | null): void {
    dispatch({ type: "preview", key, url: replacement })
    if (job.objectUrl !== null) URL.revokeObjectURL(job.objectUrl)
    job.objectUrl = null
  }

  function markDuplicate(key: string, job: Job, duplicate: Duplicate): void {
    // The preview would hold a full-size JPEG in memory for a photo that goes nowhere.
    dropPreview(key, job, null)
    job.prepared = null
    job.duplicateOf = duplicate.where === "queue" ? duplicate.ownerKey : null
    const existingItemId = duplicate.where === "wardrobe" ? duplicate.existingItemId : null
    dispatch({ type: "upload", key, stage: { kind: "duplicate", where: duplicate.where, existingItemId } })
  }

  async function processUpload(key: string): Promise<void> {
    const job = jobsRef.current.get(key)
    if (job === undefined || job.removed) return

    if (job.prepared === null) {
      dispatch({ type: "upload", key, stage: { kind: "preparing" } })
      let prepared: PreparedImage
      try {
        prepared = await deps.prepareImage(job.file)
      } catch (thrown) {
        if (!job.removed) failUpload(key, "prepare", prepareFailure(thrown))
        return
      }
      if (job.removed) return
      job.prepared = prepared
      job.objectUrl = URL.createObjectURL(prepared.blob)
      dispatch({ type: "preview", key, url: job.objectUrl })
    }
    const prepared = job.prepared

    if (!job.checked) {
      const owners = hashOwnersRef.current
      const owner = owners.get(prepared.sourceHash)
      if (owner !== undefined && owner !== key && jobsRef.current.has(owner)) {
        markDuplicate(key, job, { where: "queue", ownerKey: owner })
        return
      }
      owners.set(prepared.sourceHash, key)

      dispatch({ type: "upload", key, stage: { kind: "checking" } })
      const lookup = await batcher.lookup(prepared.sourceHash)
      if (job.removed) return
      if (!lookup.ok) return failUpload(key, "check", lookup.error)
      // Skipped before upload: the existing item keeps its own collection,
      // whatever this photo was stamped with (D-252).
      if (lookup.data !== null) return markDuplicate(key, job, { where: "wardrobe", existingItemId: lookup.data })
      job.checked = true
    }

    if (job.uploaded === null) {
      dispatch({ type: "upload", key, stage: { kind: "uploading", percent: 0 } })
      const uploaded = await deps.api.uploadOriginal({
        itemId: job.itemId,
        sourceHash: prepared.sourceHash,
        blob: prepared.blob,
        signal: job.controller.signal,
        onProgress: (percent) => {
          if (!job.removed) dispatch({ type: "upload", key, stage: { kind: "uploading", percent } })
        },
      })
      if (job.removed) return
      if (!uploaded.ok) {
        // The upload route refuses a source hash that was registered after our check.
        if (uploaded.error.code === "DUPLICATE") {
          return markDuplicate(key, job, { where: "wardrobe", existingItemId: existingItemIdFrom(uploaded.error) })
        }
        return failUpload(key, "upload", uploaded.error)
      }
      job.uploaded = uploaded.data
    }

    dispatch({ type: "upload", key, stage: { kind: "saving" } })
    const registered = await deps.api.register(
      {
        itemId: job.itemId,
        url: job.uploaded.url,
        pathname: job.uploaded.pathname,
        sourceHash: prepared.sourceHash,
        originalFilename: prepared.originalFilename.slice(0, 255),
        // The stamp from when the photo was queued, so a Retry sends the same (D-252).
        collection: job.collection,
      },
      job.controller.signal,
    )
    if (job.removed) return
    if (!registered.ok) {
      if (registered.error.code === "DUPLICATE") {
        return markDuplicate(key, job, { where: "wardrobe", existingItemId: existingItemIdFrom(registered.error) })
      }
      return failUpload(key, "register", registered.error)
    }
    if (registered.data.duplicate) {
      // The processed image matched an item uploaded from a different file.
      return markDuplicate(key, job, { where: "wardrobe", existingItemId: registered.data.existingItemId })
    }

    const { item } = registered.data
    job.registeredItemId = item.id
    dispatch({ type: "registered", key, item })
    // The server thumbnail replaces the full-size local JPEG, which can then be freed.
    if (item.images.thumb !== null) {
      dropPreview(key, job, item.images.thumb.url)
      job.prepared = null
    }
  }

  function enqueueUpload(key: string): void {
    // A call cleared from the queue (the page was left) rejects; it never ran.
    void uploadLimit(() => processUpload(key)).catch(() => {})
  }

  function blockBudget(error: AppErrorPayload): void {
    budgetBlockRef.current = error
    dispatch({ type: "budgetBlocked", error })
  }

  async function processTag(key: string): Promise<void> {
    const job = jobsRef.current.get(key)
    if (job === undefined || job.removed || job.registeredItemId === null) return
    if (budgetBlockRef.current !== null) {
      dispatch({ type: "tag", keys: [key], stage: { kind: "idle" } })
      return
    }
    dispatch({ type: "tag", keys: [key], stage: { kind: "tagging" } })
    const result = await deps.api.tagItem(job.registeredItemId, { force: false })
    if (job.removed) return
    if (result.ok) {
      dispatch({ type: "tagged", key, item: result.data.item, cached: result.data.cached })
      return
    }
    if (result.error.code === "BUDGET_EXCEEDED") {
      blockBudget(result.error)
      dispatch({ type: "tag", keys: [key], stage: { kind: "idle" } })
      return
    }
    dispatch({ type: "tag", keys: [key], stage: { kind: "failed", error: notify("tag", result.error) } })
  }

  function enqueueTags(keys: readonly string[]): void {
    if (keys.length === 0 || !taggingAvailable || budgetBlockRef.current !== null) return
    dispatch({ type: "tag", keys, stage: { kind: "queued" } })
    for (const key of keys) {
      activeTagCallsRef.current += 1
      void tagLimit(() => processTag(key))
        // A call cleared from the queue (the page was left) rejects; it never ran.
        .catch(() => {})
        .finally(() => {
          activeTagCallsRef.current -= 1
          // Re-read the budget once a run settles, so "left this month" is current.
          if (activeTagCallsRef.current === 0 && !disposedRef.current) onTaggingSettledRef.current()
        })
    }
  }

  function untaggedKeys(): string[] {
    return state.entries.filter(isUntaggedReady).map((entry) => entry.key)
  }

  return {
    state,
    counts: countEntries(state.entries),
    batchPending,

    addFiles(files) {
      if (files.length === 0) return
      const jobs = jobsRef.current
      // Read once, so the job and its row carry the same stamp: the switch as
      // this render shows it.
      const { collection } = state
      const added = files.map((file) => {
        const key = crypto.randomUUID()
        jobs.set(key, {
          file,
          itemId: crypto.randomUUID(),
          collection,
          prepared: null,
          checked: false,
          uploaded: null,
          registeredItemId: null,
          objectUrl: null,
          controller: new AbortController(),
          removed: false,
          duplicateOf: null,
        })
        return { key, fileName: file.name === "" ? "Photo" : file.name, collection }
      })
      dispatch({ type: "add", entries: added })
      for (const { key } of added) enqueueUpload(key)
    },

    setCollection(collection) {
      dispatch({ type: "setCollection", collection })
    },

    retryUpload(key) {
      const job = jobsRef.current.get(key)
      if (job === undefined || job.removed) return
      dispatch({ type: "upload", key, stage: { kind: "waiting" } })
      enqueueUpload(key)
    },

    retryTag(key) {
      enqueueTags([key])
    },

    remove(key) {
      const jobs = jobsRef.current
      const job = jobs.get(key)
      if (job !== undefined) {
        job.removed = true
        job.controller.abort()
        if (job.objectUrl !== null) URL.revokeObjectURL(job.objectUrl)
        job.objectUrl = null
        const hash = job.prepared?.sourceHash
        if (hash !== undefined && hashOwnersRef.current.get(hash) === key) hashOwnersRef.current.delete(hash)
        jobs.delete(key)
      }
      dispatch({ type: "remove", key })
      // Copies marked "Already in this list" because of this photo are checked
      // again; the first to reach the check takes its place.
      for (const copyKey of copiesOf(jobs, key)) {
        const copy = jobs.get(copyKey)
        if (copy === undefined) continue
        copy.prepared = null
        copy.checked = false
        copy.duplicateOf = null
        dispatch({ type: "upload", key: copyKey, stage: { kind: "waiting" } })
        enqueueUpload(copyKey)
      }
    },

    startTagging() {
      enqueueTags(untaggedKeys())
    },

    async startBatch() {
      const keys = untaggedKeys()
      if (keys.length < BATCH_MIN_ITEMS || batchPending || !taggingAvailable || budgetBlockRef.current !== null) return
      const jobs = jobsRef.current
      const itemIds = keys.flatMap((key) => {
        const id = jobs.get(key)?.registeredItemId
        return id === undefined || id === null ? [] : [id]
      })
      const keyOf = (itemId: string | null): string | undefined =>
        itemId === null ? undefined : keys.find((key) => jobs.get(key)?.registeredItemId === itemId)
      setBatchPending(true)
      dispatch({ type: "tag", keys, stage: { kind: "queued" } })
      let result: Result<StartTaggingBatchData>
      try {
        result = await deps.startTaggingBatch({ itemIds })
      } catch {
        // A rejected action call means the request itself failed.
        result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
      }
      setBatchPending(false)
      // Re-read the budget: a started batch reserves its estimate, and a failed
      // start may still have paid for its dry run.
      if (!disposedRef.current) onTaggingSettledRef.current()
      if (result.ok) {
        // The dry run tagged its item synchronously; only the rest wait in the batch.
        const dryRunKey = keyOf(result.data.dryRunItemId)
        const batchedKeys = keys.filter((key) => key !== dryRunKey)
        dispatch({ type: "tag", keys: batchedKeys, stage: { kind: "batched" } })
        if (dryRunKey !== undefined) dispatch({ type: "tag", keys: [dryRunKey], stage: { kind: "tagged", cached: false } })
        toast.add({
          title: "Batch started",
          description:
            `1 item was tagged right away; ${countLabel(batchedKeys.length, "item")} ` +
            `${batchedKeys.length === 1 ? "is" : "are"} in the batch, usually done within an hour.`,
          type: "success",
        })
        return
      }
      if (result.error.code === "BUDGET_EXCEEDED") {
        blockBudget(result.error)
        return
      }
      // When the batch itself failed after the dry run, that item is tagged
      // already and must not be sent again with the next attempt. When the dry
      // run failed, its item shows the failure (the server stored it) and is
      // left out of the next attempt, which would only pay for it again.
      const taggedKey = keyOf(taggedItemIdFrom(result.error.details))
      const dryRunFailedKey = keyOf(dryRunItemIdFrom(result.error.details))
      dispatch({
        type: "tag",
        keys: keys.filter((key) => key !== taggedKey && key !== dryRunFailedKey),
        stage: { kind: "idle" },
      })
      if (taggedKey !== undefined) dispatch({ type: "tag", keys: [taggedKey], stage: { kind: "tagged", cached: false } })
      if (dryRunFailedKey !== undefined) {
        dispatch({
          type: "tag",
          keys: [dryRunFailedKey],
          stage: { kind: "failed", error: describeError("tag", result.error).error },
        })
      }
      notify("batch", result.error)
    },
  }
}
