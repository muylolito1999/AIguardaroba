import { describe, expect, it } from "vitest"

import type { ItemCollection } from "@/lib/db/enums"
import type { ItemCardDto } from "@/lib/items/contracts"

import {
  INITIAL_ADD_FLOW_STATE,
  addFlowReducer,
  countEntries,
  hasWorkInFlight,
  leaveWarning,
  progressAnnouncement,
  tagStatusText,
  uploadStatusText,
  type AddFlowState,
} from "./upload-queue"
import { cardFor } from "./test-fixtures"

function withEntries(...keys: string[]): AddFlowState {
  return addEntries(INITIAL_ADD_FLOW_STATE, "clothing", ...keys)
}

function addEntries(state: AddFlowState, collection: ItemCollection, ...keys: string[]): AddFlowState {
  return addFlowReducer(state, {
    type: "add",
    entries: keys.map((key) => ({ key, fileName: `${key}.jpg`, collection })),
  })
}

function registered(state: AddFlowState, key: string, item: ItemCardDto = cardFor(key)): AddFlowState {
  return addFlowReducer(state, { type: "registered", key, item })
}

describe("addFlowReducer", () => {
  it("adds entries as waiting, untagged and without a preview", () => {
    const state = withEntries("a", "b")
    expect(state.entries.map((entry) => entry.key)).toEqual(["a", "b"])
    expect(state.entries[0]).toMatchObject({
      fileName: "a.jpg",
      upload: { kind: "waiting" },
      tag: { kind: "idle" },
      previewUrl: null,
      item: null,
    })
  })

  it("keeps the same state object when an upload percentage repeats", () => {
    const uploading = addFlowReducer(withEntries("a"), {
      type: "upload",
      key: "a",
      stage: { kind: "uploading", percent: 40 },
    })
    const again = addFlowReducer(uploading, { type: "upload", key: "a", stage: { kind: "uploading", percent: 40 } })
    expect(again).toBe(uploading)
  })

  it("ignores actions for unknown keys", () => {
    const state = withEntries("a")
    expect(addFlowReducer(state, { type: "upload", key: "missing", stage: { kind: "saving" } })).toBe(state)
  })

  it("marks a registered pending item ready and idle, and an already tagged one as tagged", () => {
    let state = registered(withEntries("a", "b"), "a")
    state = registered(state, "b", cardFor("b", { status: "tagged", name: "Grey hoodie" }))
    expect(state.entries[0]).toMatchObject({ upload: { kind: "ready" }, tag: { kind: "idle" } })
    expect(state.entries[1]).toMatchObject({ upload: { kind: "ready" }, tag: { kind: "tagged", cached: true } })
  })

  it("returns queued tagging calls to idle when the budget blocks, and leaves running ones alone", () => {
    let state = registered(registered(withEntries("a", "b"), "a"), "b")
    state = addFlowReducer(state, { type: "tag", keys: ["a"], stage: { kind: "tagging" } })
    state = addFlowReducer(state, { type: "tag", keys: ["b"], stage: { kind: "queued" } })
    state = addFlowReducer(state, {
      type: "budgetBlocked",
      error: { code: "BUDGET_EXCEEDED", message: "Budget reached." },
    })
    expect(state.budgetBlock?.code).toBe("BUDGET_EXCEEDED")
    expect(state.entries.map((entry) => entry.tag.kind)).toEqual(["tagging", "idle"])
  })

  it("removes an entry", () => {
    const state = addFlowReducer(withEntries("a", "b"), { type: "remove", key: "a" })
    expect(state.entries.map((entry) => entry.key)).toEqual(["b"])
  })

  it("empties the list on reset and keeps the budget block", () => {
    const error = { code: "BUDGET_EXCEEDED" as const, message: "Budget reached." }
    let state = registered(withEntries("a", "b"), "a")
    state = addFlowReducer(state, { type: "budgetBlocked", error })
    state = addFlowReducer(state, { type: "reset" })
    expect(state).toEqual({ entries: [], budgetBlock: error, collection: "clothing" })
  })

  it("lifts the budget block, and keeps the same state when there is none", () => {
    const blocked = addFlowReducer(withEntries("a"), {
      type: "budgetBlocked",
      error: { code: "BUDGET_EXCEEDED", message: "Budget reached." },
    })
    const lifted = addFlowReducer(blocked, { type: "budgetLifted" })
    expect(lifted.budgetBlock).toBeNull()
    expect(lifted.entries).toBe(blocked.entries)
    expect(addFlowReducer(lifted, { type: "budgetLifted" })).toBe(lifted)
  })
})

describe("the running-gear switch (D-252)", () => {
  it("starts off", () => {
    expect(INITIAL_ADD_FLOW_STATE.collection).toBe("clothing")
  })

  it("stamps entries with the collection they were queued with, which a later switch does not change", () => {
    let state = addFlowReducer(INITIAL_ADD_FLOW_STATE, { type: "setCollection", collection: "running" })
    expect(state.collection).toBe("running")
    state = addEntries(state, "running", "shoes")
    state = addFlowReducer(state, { type: "setCollection", collection: "clothing" })
    state = addEntries(state, "clothing", "coat")
    state = registered(state, "shoes")

    expect(state.collection).toBe("clothing")
    expect(state.entries.map((entry) => [entry.key, entry.collection])).toEqual([
      ["shoes", "running"],
      ["coat", "clothing"],
    ])
  })

  it("keeps the same state when the switch is set to what it already is", () => {
    const state = withEntries("a")
    expect(addFlowReducer(state, { type: "setCollection", collection: "clothing" })).toBe(state)
  })

  it("is turned off again when the page is left, together with emptying the list", () => {
    let state = addFlowReducer(INITIAL_ADD_FLOW_STATE, { type: "setCollection", collection: "running" })
    state = addEntries(state, "running", "shoes")
    state = addFlowReducer(state, { type: "reset" })
    expect(state.collection).toBe("clothing")
    expect(state.entries).toEqual([])
  })

  it("stays on when the budget blocks or lifts", () => {
    let state = addFlowReducer(INITIAL_ADD_FLOW_STATE, { type: "setCollection", collection: "running" })
    state = addFlowReducer(state, {
      type: "budgetBlocked",
      error: { code: "BUDGET_EXCEEDED", message: "Budget reached." },
    })
    expect(state.collection).toBe("running")
    state = addFlowReducer(state, { type: "budgetLifted" })
    expect(state.collection).toBe("running")
  })
})

describe("countEntries and progressAnnouncement", () => {
  it("counts each entry once, by upload stage first and tagging stage once ready", () => {
    let state = withEntries("a", "b", "c", "d", "e")
    state = registered(state, "a")
    state = registered(state, "b")
    state = addFlowReducer(state, { type: "tagged", key: "b", item: cardFor("b", { status: "tagged" }), cached: false })
    state = addFlowReducer(state, {
      type: "upload",
      key: "c",
      stage: { kind: "duplicate", where: "wardrobe", existingItemId: "x" },
    })
    state = addFlowReducer(state, {
      type: "upload",
      key: "d",
      stage: { kind: "failed", step: "upload", error: { code: "CONFIG", message: "Not configured." } },
    })

    const counts = countEntries(state.entries)
    expect(counts).toMatchObject({
      total: 5,
      uploading: 1,
      ready: 2,
      duplicates: 1,
      uploadFailed: 1,
      untagged: 1,
      tagged: 1,
    })
    expect(progressAnnouncement(counts)).toBe(
      "2 of 5 photos uploaded, 1 in progress, 1 already in your wardrobe, 1 failed, 1 tagged.",
    )
  })

  it("announces nothing for an empty queue", () => {
    expect(progressAnnouncement(countEntries([]))).toBe("")
  })
})

describe("leaving while work is in flight", () => {
  const idle = countEntries([])

  it("warns about uploads and tagging separately, and only about what is running", () => {
    expect(hasWorkInFlight(idle)).toBe(false)
    expect(leaveWarning(idle)).toBe("Everything has finished, so nothing will be lost.")

    const uploading = { ...idle, total: 2, uploading: 2 }
    expect(hasWorkInFlight(uploading)).toBe(true)
    expect(leaveWarning(uploading)).toBe(
      "2 photos are still being uploaded. Leaving cancels them, and you would need to pick them again.",
    )

    const tagging = { ...idle, total: 1, ready: 1, tagging: 1 }
    expect(hasWorkInFlight(tagging)).toBe(true)
    expect(leaveWarning(tagging)).toBe(
      "1 item is being tagged. Any that have not started stay untagged; you can tag them from the review page.",
    )
  })

  it("does not send the owner to tag items from the review page while a batch for them is starting", () => {
    const batching = { ...idle, total: 21, ready: 21, tagging: 21 }
    const warning = leaveWarning(batching, { batchPending: true })
    expect(warning).toBe(
      "A batch is being started for these items. Leaving does not stop it; the review page shows them in the " +
        "batch once it has started.",
    )
    expect(leaveWarning({ ...batching, uploading: 1, total: 22 }, { batchPending: true })).toBe(
      `1 photo is still being uploaded. Leaving cancels it, and you would need to pick it again. ${warning}`,
    )
    expect(leaveWarning(batching, { batchPending: false })).toContain("you can tag them from the review page")
  })
})

describe("status text", () => {
  it("names every upload stage", () => {
    expect(uploadStatusText({ kind: "waiting" })).toBe("Waiting")
    expect(uploadStatusText({ kind: "preparing" })).toBe("Preparing")
    expect(uploadStatusText({ kind: "checking" })).toBe("Checking")
    expect(uploadStatusText({ kind: "uploading", percent: 42 })).toBe("Uploading 42%")
    expect(uploadStatusText({ kind: "saving" })).toBe("Saving")
    expect(uploadStatusText({ kind: "ready" })).toBe("Ready")
    expect(uploadStatusText({ kind: "duplicate", where: "wardrobe", existingItemId: null })).toBe(
      "Already in your wardrobe",
    )
    expect(uploadStatusText({ kind: "duplicate", where: "queue", existingItemId: null })).toBe(
      "Already in this list",
    )
    expect(
      uploadStatusText({ kind: "failed", step: "upload", error: { code: "UPSTREAM", message: "Offline." } }),
    ).toBe("Failed: Offline.")
  })

  it("says nothing about tagging until it starts", () => {
    expect(tagStatusText({ kind: "idle" })).toBeNull()
    expect(tagStatusText({ kind: "tagging" })).toBe("Tagging")
    expect(tagStatusText({ kind: "failed", error: { code: "AI_TIMEOUT", message: "Timed out." } })).toBe(
      "Tagging failed: Timed out.",
    )
  })
})
