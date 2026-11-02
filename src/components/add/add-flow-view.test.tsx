// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Activity } from "react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { toast } from "@/components/ui/toast"
import type { PreparedImage } from "@/lib/images/client-pipeline"
import { DRY_RUN_ITEM_DETAIL, type RegisterBody, type TagData } from "@/lib/items/contracts"
import { CONFIG_ERROR_MESSAGE, err, ok, type Result } from "@/lib/result"

import type { AddApi, UploadOriginalInput } from "./add-api"
import { AddFlowView, type AddFlowProps } from "./add-flow-view"
import { cardFor, fakeHash, taggingSetupFor } from "./test-fixtures"
import type { AddFlowDeps } from "./use-add-flow"

// useLeaveGuard follows a held-back link with router.push.
const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}))

const PROPS: AddFlowProps = { setup: ok(taggingSetupFor()) }
/** The tagging settings could not be read (an unpriced model override, for example). */
const UNAVAILABLE: AddFlowProps = { setup: err("CONFIG", CONFIG_ERROR_MESSAGE) }

const LONG_WAIT = { timeout: 5000 }

function photo(name: string): File {
  return new File([`bytes of ${name}`], name, { type: "image/jpeg" })
}

function photos(count: number): File[] {
  return Array.from({ length: count }, (_, index) => photo(`photo-${index + 1}.jpg`))
}

type Fakes = {
  deps: AddFlowDeps
  prepareImage: ReturnType<typeof vi.fn<(file: File) => Promise<PreparedImage>>>
  checkHashes: ReturnType<typeof vi.fn<AddApi["checkHashes"]>>
  uploadOriginal: ReturnType<typeof vi.fn<AddApi["uploadOriginal"]>>
  register: ReturnType<typeof vi.fn<AddApi["register"]>>
  tagItem: ReturnType<typeof vi.fn<AddApi["tagItem"]>>
  taggingSetup: ReturnType<typeof vi.fn<AddApi["taggingSetup"]>>
  startTaggingBatch: ReturnType<typeof vi.fn<AddFlowDeps["startTaggingBatch"]>>
}

function makeFakes(): Fakes {
  const prepareImage = vi.fn(
    async (file: File): Promise<PreparedImage> => ({
      blob: new Blob(["jpeg"], { type: "image/jpeg" }),
      width: 300,
      height: 400,
      sourceHash: fakeHash(file.name),
      originalFilename: file.name,
    }),
  )
  const checkHashes = vi.fn<AddApi["checkHashes"]>(async () => ok({ known: {} }))
  const uploadOriginal = vi.fn<AddApi["uploadOriginal"]>(async ({ itemId }: UploadOriginalInput) =>
    ok({
      url: `https://store.public.blob.vercel-storage.com/items/${itemId}/original-abc.jpg`,
      pathname: `items/${itemId}/original-abc.jpg`,
    }),
  )
  const register = vi.fn<AddApi["register"]>(async (body: RegisterBody) =>
    ok({ duplicate: false as const, item: cardFor(body.itemId) }),
  )
  const tagItem = vi.fn<AddApi["tagItem"]>(async (itemId) =>
    ok({ cached: false, item: cardFor(itemId, { status: "tagged", name: `Tagged ${itemId.slice(0, 4)}` }) }),
  )
  const taggingSetup = vi.fn<AddApi["taggingSetup"]>(async () => ok(taggingSetupFor()))
  const startTaggingBatch = vi.fn<AddFlowDeps["startTaggingBatch"]>(async ({ itemIds }) =>
    ok({ batchId: "batch-1", count: itemIds.length, estimateUsd: 0.1, dryRunItemId: itemIds[0] ?? "" }),
  )
  return {
    deps: { prepareImage, api: { checkHashes, uploadOriginal, register, tagItem, taggingSetup }, startTaggingBatch },
    prepareImage,
    checkHashes,
    uploadOriginal,
    register,
    tagItem,
    taggingSetup,
    startTaggingBatch,
  }
}

function renderFlow(fakes: Fakes, props: AddFlowProps = PROPS) {
  return render(<AddFlowView {...props} deps={fakes.deps} />)
}

function choose(files: File[]) {
  fireEvent.change(screen.getByLabelText("Choose photos"), { target: { files } })
}

function rowFor(fileName: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((item) => within(item).queryByTitle(fileName) !== null)
  if (row === undefined) throw new Error(`no row for ${fileName}`)
  return row
}

async function waitForReady(count: number) {
  await waitFor(() => expect(screen.getAllByText("Ready")).toHaveLength(count), LONG_WAIT)
}

/** Disabled the way the tagging buttons are: still focusable, so aria-disabled rather than `disabled`. */
function isDisabled(element: HTMLElement): boolean {
  return element.getAttribute("aria-disabled") === "true" || (element as HTMLButtonElement).disabled
}

function beforeUnloadIsBlocked(): boolean {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

/** Clicks an in-app link without letting jsdom navigate. */
function clickLink(link: HTMLElement) {
  // Registered after the guard would be, so an active guard still sees the
  // click first; this only keeps the real <Link> from navigating in jsdom.
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener("click", swallow, true)
  try {
    fireEvent.click(link)
  } finally {
    window.removeEventListener("click", swallow, true)
  }
}

let toastAdd: MockInstance<typeof toast.add>
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>

/** jsdom has no ResizeObserver; the tagging bar only needs observe and disconnect. */
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver)
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
  let next = 0
  createObjectURL = vi.fn(() => `blob:preview-${(next += 1)}`)
  revokeObjectURL = vi.fn()
  // jsdom implements neither.
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  router.push.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("pickers", () => {
  it("offers a labelled camera input, a photo picker and a folder import", () => {
    renderFlow(makeFakes())

    const camera = screen.getByLabelText("Take photo") as HTMLInputElement
    expect(camera.type).toBe("file")
    expect(camera.getAttribute("capture")).toBe("environment")
    expect(camera.getAttribute("accept")).toBe("image/*")
    expect(camera.multiple).toBe(true)

    const chooser = screen.getByLabelText("Choose photos") as HTMLInputElement
    expect(chooser.getAttribute("accept")).toBe("image/*,.heic,.heif")
    expect(chooser.multiple).toBe(true)

    const folder = screen.getByLabelText("Import folder") as HTMLInputElement
    expect(folder.webkitdirectory).toBe(true)

    expect(screen.getByRole("button", { name: /Drop photos here/ })).toBeTruthy()
  })

  it("skips files that are not photos and says so", async () => {
    const fakes = makeFakes()
    renderFlow(fakes)

    fireEvent.change(screen.getByLabelText("Import folder"), {
      target: { files: [new File(["x"], "notes.txt", { type: "text/plain" }), photo("coat.jpg")] },
    })

    await waitForReady(1)
    expect(fakes.prepareImage).toHaveBeenCalledTimes(1)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Skipped 1 file", type: "warning" }))
  })
})

describe("uploads", () => {
  it("prepares, checks the hashes in one request, uploads and registers each photo", async () => {
    const fakes = makeFakes()
    renderFlow(fakes)

    choose([photo("coat.jpg"), photo("boots.jpg")])

    await waitForReady(2)
    expect(fakes.checkHashes).toHaveBeenCalledTimes(1)
    expect(fakes.checkHashes.mock.calls[0]?.[0]).toEqual([fakeHash("coat.jpg"), fakeHash("boots.jpg")])
    expect(fakes.uploadOriginal).toHaveBeenCalledTimes(2)
    const [registered] = fakes.register.mock.calls[0] ?? []
    expect(registered).toMatchObject({ sourceHash: fakeHash("coat.jpg"), originalFilename: "coat.jpg" })
    // The upload and the register use the same client-chosen item id.
    expect(registered?.itemId).toBe(fakes.uploadOriginal.mock.calls[0]?.[0].itemId)

    // The server thumbnail replaces the local preview, which is released.
    const image = within(rowFor("coat.jpg")).getByRole("presentation") as HTMLImageElement
    expect(image.getAttribute("src")).toMatch(/thumb\.webp$/)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("status").textContent).toBe("2 of 2 photos uploaded.")
  })

  it("shows a clear configuration error per photo when uploads are not configured, and registers nothing", async () => {
    const fakes = makeFakes()
    fakes.uploadOriginal.mockResolvedValue(err("CONFIG", CONFIG_ERROR_MESSAGE))
    renderFlow(fakes)

    choose([photo("coat.jpg"), photo("boots.jpg")])

    await waitFor(
      () => expect(screen.getAllByText("Failed: Uploads are not configured on the server.")).toHaveLength(2),
      LONG_WAIT,
    )
    expect(fakes.register).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "add-upload-CONFIG",
        title: "Configuration problem",
        type: "error",
        description: expect.stringContaining("read-write token"),
      }),
    )
    expect(within(rowFor("coat.jpg")).getByRole("button", { name: "Retry coat.jpg" })).toBeTruthy()
  })

  it("marks photos the wardrobe already has and does not upload them", async () => {
    const fakes = makeFakes()
    fakes.checkHashes.mockResolvedValue(ok({ known: { [fakeHash("coat.jpg")]: "existing-item" } }))
    renderFlow(fakes)

    choose([photo("coat.jpg"), photo("boots.jpg")])

    await waitForReady(1)
    expect(within(rowFor("coat.jpg")).getByText("Already in your wardrobe")).toBeTruthy()
    expect(fakes.uploadOriginal).toHaveBeenCalledTimes(1)
  })

  it("marks the same photo picked twice as already in the list", async () => {
    const fakes = makeFakes()
    renderFlow(fakes)

    choose([photo("coat.jpg"), photo("coat.jpg")])

    await waitForReady(1)
    expect(screen.getByText("Already in this list")).toBeTruthy()
    expect(fakes.uploadOriginal).toHaveBeenCalledTimes(1)
  })

  it("checks a photo marked as already in the list again once the copy it matched is removed", async () => {
    const fakes = makeFakes()
    fakes.uploadOriginal.mockResolvedValueOnce(err("UPSTREAM", "Upload to storage failed: offline."))
    renderFlow(fakes)

    choose([photo("coat.jpg")])
    await screen.findByText("Failed: Upload to storage failed: offline.", undefined, LONG_WAIT)
    // Picked again instead of retried.
    choose([photo("coat.jpg")])
    await screen.findByText("Already in this list", undefined, LONG_WAIT)

    const [failedCopy] = screen.getAllByRole("button", { name: "Remove coat.jpg from this list" })
    if (failedCopy === undefined) throw new Error("no Remove button")
    fireEvent.click(failedCopy)

    await waitForReady(1)
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
    expect(screen.queryByText("Already in this list")).toBeNull()
    expect(fakes.uploadOriginal).toHaveBeenCalledTimes(2)
    expect(fakes.register).toHaveBeenCalledTimes(1)
  })

  it("retries from the failed step without preparing the photo again", async () => {
    const fakes = makeFakes()
    fakes.register.mockResolvedValueOnce(err("UPSTREAM", "Could not reach the server. Check your connection."))
    renderFlow(fakes)

    choose([photo("coat.jpg")])
    const retry = await screen.findByRole("button", { name: "Retry coat.jpg" }, LONG_WAIT)
    fireEvent.click(retry)

    await waitForReady(1)
    expect(fakes.prepareImage).toHaveBeenCalledTimes(1)
    expect(fakes.uploadOriginal).toHaveBeenCalledTimes(1)
    expect(fakes.register).toHaveBeenCalledTimes(2)
  })

  it("releases the preview when a photo is removed", async () => {
    const fakes = makeFakes()
    fakes.uploadOriginal.mockResolvedValue(err("UPSTREAM", "Upload to storage failed: offline."))
    renderFlow(fakes)

    choose([photo("coat.jpg")])
    await screen.findByText("Failed: Upload to storage failed: offline.", undefined, LONG_WAIT)
    fireEvent.click(screen.getByRole("button", { name: "Remove coat.jpg from this list" }))

    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1")
  })
})

describe("tagging", () => {
  it("shows the estimate and budget, then tags every ready item", async () => {
    const fakes = makeFakes()
    renderFlow(fakes)

    choose([photo("coat.jpg"), photo("boots.jpg")])
    await waitForReady(2)

    const bar = screen.getByRole("region", { name: "Tagging" })
    expect(within(bar).getByText("Tag 2 items ≈ $0.03 (Haiku 5.5)")).toBeTruthy()
    expect(within(bar).getByText(/\$12\.50 left this month/)).toBeTruthy()
    expect(within(bar).getByRole("link", { name: "Review 2 items" }).getAttribute("href")).toBe("/add/review")
    expect(within(bar).queryByRole("button", { name: /Tag as a batch/ })).toBeNull()

    fireEvent.click(within(bar).getByRole("button", { name: "Start tagging" }))

    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(2), LONG_WAIT)
    expect(fakes.tagItem).toHaveBeenCalledTimes(2)
    expect(fakes.tagItem.mock.calls.map(([, body]) => body)).toEqual([{ force: false }, { force: false }])
    expect(within(bar).getByText("All 2 items tagged")).toBeTruthy()
  })

  it("reads the budget again once a run settles and shows what is left", async () => {
    const fakes = makeFakes()
    fakes.taggingSetup.mockResolvedValue(ok(taggingSetupFor({ remainingUsd: 11.97 })))
    renderFlow(fakes)

    choose([photo("coat.jpg"), photo("boots.jpg")])
    await waitForReady(2)
    const bar = screen.getByRole("region", { name: "Tagging" })
    fireEvent.click(within(bar).getByRole("button", { name: "Start tagging" }))

    await waitFor(() => expect(within(bar).getByText(/\$11\.97 left this month/)).toBeTruthy(), LONG_WAIT)
    // Once for the run, not once per call.
    expect(fakes.taggingSetup).toHaveBeenCalledTimes(1)
  })

  it("keeps the last budget when reading it again fails, without blocking anything", async () => {
    const fakes = makeFakes()
    fakes.taggingSetup.mockResolvedValue(err("UPSTREAM", "Could not reach the server. Check your connection."))
    renderFlow(fakes)

    choose([photo("coat.jpg")])
    await waitForReady(1)
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))

    await waitFor(() => expect(fakes.taggingSetup).toHaveBeenCalledTimes(1), LONG_WAIT)
    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(1))
    expect(screen.getByText(/\$12\.50 left this month/)).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("re-derives the budget block from a new server setup", async () => {
    const fakes = makeFakes()
    const view = renderFlow(fakes, { setup: ok(taggingSetupFor({ remainingUsd: 0 })) })
    expect(screen.getByRole("alert").textContent).toContain("AI budget reached")

    choose([photo("coat.jpg")])
    await waitForReady(1)
    expect(isDisabled(screen.getByRole("button", { name: "Start tagging" }))).toBe(true)

    // A later server render, for example on a return to the page in a new month.
    view.rerender(<AddFlowView setup={ok(taggingSetupFor({ remainingUsd: 20 }))} deps={fakes.deps} />)

    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText(/\$20\.00 left this month/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))
    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(1), LONG_WAIT)
  })

  it("stops starting calls and shows a blocking alert when the budget is exceeded", async () => {
    const fakes = makeFakes()
    const pending: Array<(result: Result<TagData>) => void> = []
    fakes.tagItem.mockImplementationOnce(async () =>
      err("BUDGET_EXCEEDED", "Monthly AI budget reached: $0.00 left until 1 December 2026."),
    )
    fakes.tagItem.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    renderFlow(fakes)

    choose(photos(6))
    await waitForReady(6)
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))

    const alert = await screen.findByRole("alert", undefined, LONG_WAIT)
    expect(alert.textContent).toContain("Monthly AI budget reached")
    // Four started together (the pool size); the two waiting never start.
    await waitFor(() => expect(pending).toHaveLength(3))
    for (const resolve of pending) resolve(err("AI_TIMEOUT", "Timed out."))
    await waitFor(() => expect(screen.getAllByText("Tagging failed: Timed out.")).toHaveLength(3))
    expect(fakes.tagItem).toHaveBeenCalledTimes(4)
    expect(isDisabled(screen.getByRole("button", { name: "Start tagging" }))).toBe(true)
  })

  it("blocks tagging from the start when the month's budget is already spent", async () => {
    const fakes = makeFakes()
    renderFlow(fakes, { setup: ok(taggingSetupFor({ remainingUsd: 0 })) })

    expect(screen.getByRole("alert").textContent).toContain("It resets on 1 December")
    choose([photo("coat.jpg")])
    await waitForReady(1)

    expect(isDisabled(screen.getByRole("button", { name: "Start tagging" }))).toBe(true)
  })

  it("offers a batch for more than 20 untagged items and sends all of them", async () => {
    const fakes = makeFakes()
    renderFlow(fakes)

    choose(photos(21))
    await waitForReady(21)

    // The dry run at standard rates (0.025), then 20 items at batch rates (0.01 + 19 x 0.005).
    const batch = screen.getByRole("button", { name: "Tag as a batch (≈ $0.13)" })
    fireEvent.click(batch)

    // The dry-run item is tagged already; the other 20 wait in the batch.
    await waitFor(() => expect(screen.getAllByText(/In a batch/)).toHaveLength(20))
    expect(screen.getAllByText("Tagged")).toHaveLength(1)
    const [input] = fakes.startTaggingBatch.mock.calls[0] ?? []
    expect(input?.itemIds).toHaveLength(21)
    expect(new Set(input?.itemIds).size).toBe(21)
    expect(fakes.tagItem).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Batch started",
        type: "success",
        description: "1 item was tagged right away; 20 items are in the batch, usually done within an hour.",
      }),
    )
  })

  it("keeps the dry-run item out of the next attempt when the batch itself could not be created", async () => {
    const fakes = makeFakes()
    fakes.startTaggingBatch.mockImplementationOnce(async ({ itemIds }) =>
      err("AI_UNAVAILABLE", "The first item was tagged, but the batch could not be created: overloaded.", {
        taggedItemId: itemIds[0],
      }),
    )
    renderFlow(fakes)

    choose(photos(22))
    await waitForReady(22)
    fireEvent.click(screen.getByRole("button", { name: /Tag as a batch/ }))

    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(1))
    expect(screen.getByText(/^Tag 21 items/)).toBeTruthy()
    const [first] = fakes.startTaggingBatch.mock.calls[0] ?? []

    fireEvent.click(screen.getByRole("button", { name: /Tag as a batch/ }))
    await waitFor(() => expect(fakes.startTaggingBatch).toHaveBeenCalledTimes(2))
    const [second] = fakes.startTaggingBatch.mock.calls[1] ?? []
    expect(second?.itemIds).toHaveLength(21)
    expect(second?.itemIds).not.toContain(first?.itemIds[0])
  })

  it("marks only the dry-run item as failed when the dry run fails, and leaves it out of the next batch", async () => {
    const fakes = makeFakes()
    fakes.startTaggingBatch.mockImplementationOnce(async ({ itemIds }) =>
      err("AI_REFUSAL", "No batch was created: tagging the first item as a test failed. Claude declined.", {
        [DRY_RUN_ITEM_DETAIL]: itemIds[0],
      }),
    )
    renderFlow(fakes)

    choose(photos(22))
    await waitForReady(22)
    fireEvent.click(screen.getByRole("button", { name: /Tag as a batch/ }))

    const failed = await screen.findByText(/^Tagging failed: No batch was created/, undefined, LONG_WAIT)
    expect(screen.getAllByText(/^Tagging failed/)).toHaveLength(1)
    const row = failed.closest("li")
    if (row === null) throw new Error("no row for the failed item")
    expect(within(row).getByRole("button", { name: /^Retry tagging / })).toBeTruthy()
    // The other 21 are untagged again, so the batch is still offered for them.
    expect(screen.getByText(/^Tag 21 items/)).toBeTruthy()
    const [first] = fakes.startTaggingBatch.mock.calls[0] ?? []

    fireEvent.click(screen.getByRole("button", { name: /Tag as a batch/ }))
    await waitFor(() => expect(fakes.startTaggingBatch).toHaveBeenCalledTimes(2))
    const [second] = fakes.startTaggingBatch.mock.calls[1] ?? []
    expect(second?.itemIds).toHaveLength(21)
    expect(second?.itemIds).not.toContain(first?.itemIds[0])
  })

  it("does not offer a batch for 20 items", async () => {
    renderFlow(makeFakes())

    choose(photos(20))
    await waitForReady(20)

    expect(screen.queryByRole("button", { name: /Tag as a batch/ })).toBeNull()
  })

  it("puts items back when the batch cannot start", async () => {
    const fakes = makeFakes()
    fakes.startTaggingBatch.mockResolvedValue(err("CONFIG", CONFIG_ERROR_MESSAGE))
    renderFlow(fakes)

    choose(photos(21))
    await waitForReady(21)
    fireEvent.click(screen.getByRole("button", { name: /Tag as a batch/ }))

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ id: "add-batch-CONFIG", description: expect.stringContaining("Anthropic API key") }),
      ),
    )
    expect(screen.getByText("Tag 21 items ≈ $0.22 (Haiku 5.5)")).toBeTruthy()
  })
})

describe("leaving the page", () => {
  it("asks before a link leaves while photos are still uploading, and follows it only when told to", async () => {
    const fakes = makeFakes()
    let finishUpload = () => {}
    fakes.uploadOriginal.mockImplementationOnce(
      ({ itemId }) =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve(ok({ url: `https://store.public.blob.vercel-storage.com/items/${itemId}/o.jpg`, pathname: `items/${itemId}/o.jpg` }))
        }),
    )
    renderFlow(fakes)

    choose([photo("coat.jpg"), photo("boots.jpg")])
    await waitForReady(1)
    expect(beforeUnloadIsBlocked()).toBe(true)

    const review = screen.getByRole("link", { name: "Review 1 item" })
    fireEvent.click(review)
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Leave this page?")).toBeTruthy()
    expect(dialog.textContent).toContain("1 photo is still being uploaded. Leaving cancels it")
    expect(router.push).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())

    fireEvent.click(review)
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave anyway" }))
    expect(router.push).toHaveBeenCalledWith("/add/review")

    finishUpload()
    await waitForReady(2)
  })

  it("lets links and reloads through once nothing is in flight", async () => {
    renderFlow(makeFakes())
    expect(beforeUnloadIsBlocked()).toBe(false)

    choose([photo("coat.jpg")])
    await waitForReady(1)

    // The guard drops its listeners in a passive effect, which can run just
    // after "Ready" shows when the upload's last update came from a promise.
    await waitFor(() => expect(beforeUnloadIsBlocked()).toBe(false))
    clickLink(screen.getByRole("link", { name: "Review 1 item" }))
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("says that leaving does not stop a batch that is being started", async () => {
    const fakes = makeFakes()
    let finishBatch = () => {}
    fakes.startTaggingBatch.mockImplementationOnce(
      ({ itemIds }) =>
        new Promise((resolve) => {
          finishBatch = () =>
            resolve(ok({ batchId: "batch-1", count: itemIds.length, estimateUsd: 0.1, dryRunItemId: itemIds[0] ?? "" }))
        }),
    )
    renderFlow(fakes)

    choose(photos(21))
    await waitForReady(21)
    fireEvent.click(screen.getByRole("button", { name: /Tag as a batch/ }))
    clickLink(screen.getByRole("link", { name: "Review 21 items" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog.textContent).toContain("A batch is being started for these items. Leaving does not stop it")
    expect(dialog.textContent).not.toContain("you can tag them from the review page")

    await act(async () => finishBatch())
  })
})

/**
 * With cacheComponents, Next keeps a page the owner leaves in a hidden
 * <Activity> and shows the same instance again on return: effects clean up
 * and run again, state survives (node_modules/next/dist/docs/01-app/02-guides/
 * preserving-ui-state.md).
 */
describe("leaving through a hidden <Activity> and coming back", () => {
  function renderInActivity(fakes: Fakes) {
    const ui = (mode: "visible" | "hidden") => (
      <>
        <a href="/wardrobe">Wardrobe</a>
        <Activity mode={mode}>
          <AddFlowView {...PROPS} deps={fakes.deps} />
        </Activity>
      </>
    )
    const view = render(ui("visible"))
    return {
      hide: () => view.rerender(ui("hidden")),
      show: () => view.rerender(ui("visible")),
    }
  }

  it("starts with an empty list that uploads and tags new photos, and no longer guards links", async () => {
    const fakes = makeFakes()
    const page = renderInActivity(fakes)
    choose([photo("coat.jpg"), photo("boots.jpg")])
    await waitForReady(2)

    page.hide()
    page.show()

    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.getByRole("status").textContent).toBe("")
    expect(beforeUnloadIsBlocked()).toBe(false)
    clickLink(screen.getByRole("link", { name: "Wardrobe" }))
    expect(screen.queryByRole("alertdialog")).toBeNull()

    choose([photo("scarf.jpg")])
    await waitForReady(1)
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))
    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(1), LONG_WAIT)
    expect(fakes.tagItem).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("status").textContent).toBe("1 of 1 photo uploaded, 1 tagged.")
  })

  it("aborts an upload that is still running when the page is hidden", async () => {
    const fakes = makeFakes()
    let signal: AbortSignal | undefined
    fakes.uploadOriginal.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal
          input.signal?.addEventListener("abort", () => resolve(err("UPSTREAM", "Upload to storage failed: aborted.")))
        }),
    )
    const page = renderInActivity(fakes)
    choose([photo("coat.jpg")])
    await waitFor(() => expect(signal).toBeDefined(), LONG_WAIT)
    expect(beforeUnloadIsBlocked()).toBe(true)

    page.hide()
    expect(signal?.aborted).toBe(true)
    page.show()

    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(beforeUnloadIsBlocked()).toBe(false)
    expect(fakes.register).not.toHaveBeenCalled()
    // The cancelled upload reports nothing once the page is back.
    await act(async () => {})
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("closes a leave dialog that was open when the page was hidden, so it does not follow the old link on return", async () => {
    const fakes = makeFakes()
    let signal: AbortSignal | undefined
    fakes.uploadOriginal.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal
          input.signal?.addEventListener("abort", () => resolve(err("UPSTREAM", "Upload to storage failed: aborted.")))
        }),
    )
    const page = renderInActivity(fakes)
    choose([photo("coat.jpg")])
    await waitFor(() => expect(signal).toBeDefined(), LONG_WAIT)

    // A sidebar link is held back while the upload runs.
    fireEvent.click(screen.getByRole("link", { name: "Wardrobe" }))
    await screen.findByRole("alertdialog")

    // The owner goes Back (or swipes back) instead of answering, which the
    // guard does not intercept: Next hides the page. Later they return.
    page.hide()
    page.show()
    await act(async () => {})

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(router.push).not.toHaveBeenCalled()
  })

  it("settles tagging calls that were cleared from the queue, so later runs still re-read the budget", async () => {
    const fakes = makeFakes()
    const pending: Array<(result: Result<TagData>) => void> = []
    fakes.tagItem.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const page = renderInActivity(fakes)
    choose(photos(6))
    await waitForReady(6)
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))
    // Four run (the pool size); two wait in the queue.
    await waitFor(() => expect(pending).toHaveLength(4))

    page.hide()
    page.show()
    await act(async () => {
      for (const resolve of pending.splice(0)) resolve(err("AI_TIMEOUT", "Timed out."))
    })
    // The cancelled run reports nothing and its rows do not come back.
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(toastAdd).not.toHaveBeenCalled()

    fakes.tagItem.mockImplementation(async (itemId) =>
      ok({ cached: false, item: cardFor(itemId, { status: "tagged", name: "Grey scarf" }) }),
    )
    const readsBefore = fakes.taggingSetup.mock.calls.length
    choose([photo("scarf.jpg")])
    await waitForReady(1)
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))
    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(1), LONG_WAIT)

    // The two queued calls never ran, and the new run's re-read shows the count came back to zero.
    expect(fakes.tagItem).toHaveBeenCalledTimes(5)
    await waitFor(() => expect(fakes.taggingSetup.mock.calls).toHaveLength(readsBefore + 1))
  })
})

describe("when the tagging settings cannot be read", () => {
  it("still uploads and registers photos, says why tagging is off, and enables no tagging control", async () => {
    const fakes = makeFakes()
    renderFlow(fakes, UNAVAILABLE)

    const alert = screen.getByRole("alert")
    expect(within(alert).getByText("Tagging is unavailable")).toBeTruthy()
    expect(alert.textContent).toContain(CONFIG_ERROR_MESSAGE)

    choose([photo("coat.jpg"), photo("boots.jpg")])
    await waitForReady(2)
    expect(fakes.uploadOriginal).toHaveBeenCalledTimes(2)
    expect(fakes.register).toHaveBeenCalledTimes(2)

    const tagging = screen.queryAllByRole("button").filter((button) => /tag/i.test(button.textContent ?? ""))
    expect(tagging.filter((button) => !isDisabled(button))).toEqual([])
    expect(screen.queryByRole("button", { name: "Start tagging" })).toBeNull()
    // Reviewing still works.
    const bar = screen.getByRole("region", { name: "Tagging" })
    expect(within(bar).getByText("2 items uploaded; tagging is unavailable")).toBeTruthy()
    expect(within(bar).getByRole("link", { name: "Review 2 items" }).getAttribute("href")).toBe("/add/review")
    expect(fakes.tagItem).not.toHaveBeenCalled()
    expect(fakes.startTaggingBatch).not.toHaveBeenCalled()
  })

  it("disables Retry tagging and starts nothing once a later setup is an error", async () => {
    const fakes = makeFakes()
    fakes.tagItem.mockResolvedValueOnce(err("AI_TIMEOUT", "Timed out."))
    const view = renderFlow(fakes)

    choose([photo("coat.jpg")])
    await waitForReady(1)
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))
    const retry = await screen.findByRole("button", { name: "Retry tagging coat.jpg" }, LONG_WAIT)

    view.rerender(<AddFlowView {...UNAVAILABLE} deps={fakes.deps} />)
    expect(isDisabled(retry)).toBe(true)
    fireEvent.click(retry)
    expect(fakes.tagItem).toHaveBeenCalledTimes(1)
  })

  it("enables tagging once a later setup can be read", async () => {
    const fakes = makeFakes()
    const view = renderFlow(fakes, UNAVAILABLE)
    choose([photo("coat.jpg")])
    await waitForReady(1)

    view.rerender(<AddFlowView {...PROPS} deps={fakes.deps} />)

    expect(screen.queryByText("Tagging is unavailable")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Start tagging" }))
    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(1), LONG_WAIT)
  })
})

describe("focus after row actions", () => {
  function removeButton(name: string): HTMLElement {
    return screen.getByRole("button", { name: `Remove ${name} from this list` })
  }

  it("moves to the next row's Remove button after a Remove, then the previous, then the photo picker", async () => {
    renderFlow(makeFakes())
    choose([photo("coat.jpg"), photo("boots.jpg"), photo("scarf.jpg")])
    await waitForReady(3)

    removeButton("boots.jpg").focus()
    fireEvent.click(removeButton("boots.jpg"))
    await waitFor(() => expect(document.activeElement).toBe(removeButton("scarf.jpg")))

    fireEvent.click(removeButton("scarf.jpg"))
    await waitFor(() => expect(document.activeElement).toBe(removeButton("coat.jpg")))

    fireEvent.click(removeButton("coat.jpg"))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Choose photos")))
  })

  it("keeps focus in the row after a Retry", async () => {
    const fakes = makeFakes()
    fakes.register.mockResolvedValueOnce(err("UPSTREAM", "Could not reach the server. Check your connection."))
    renderFlow(fakes)

    choose([photo("coat.jpg")])
    const retry = await screen.findByRole("button", { name: "Retry coat.jpg" }, LONG_WAIT)
    retry.focus()
    fireEvent.click(retry)

    await waitFor(() => expect(document.activeElement).toBe(removeButton("coat.jpg")))
    await waitForReady(1)
  })

  it("keeps focus on Start tagging once everything is queued", async () => {
    renderFlow(makeFakes())
    choose([photo("coat.jpg"), photo("boots.jpg")])
    await waitForReady(2)

    const start = screen.getByRole("button", { name: "Start tagging" })
    start.focus()
    fireEvent.click(start)

    await waitFor(() => expect(screen.getAllByText("Tagged")).toHaveLength(2), LONG_WAIT)
    // aria-disabled, not `disabled`: browsers move focus off a disabled button (jsdom does not).
    expect(start.getAttribute("aria-disabled")).toBe("true")
    expect(start.hasAttribute("disabled")).toBe(false)
    expect(document.activeElement).toBe(start)
  })

  it("moves focus to the bar's summary when the batch offer goes away under it", async () => {
    renderFlow(makeFakes())
    choose(photos(21))
    await waitForReady(21)

    const batch = screen.getByRole("button", { name: /Tag as a batch/ })
    batch.focus()
    fireEvent.click(batch)

    await waitFor(() => expect(screen.getAllByText(/In a batch/)).toHaveLength(20))
    expect(screen.queryByRole("button", { name: /Tag as a batch/ })).toBeNull()
    const bar = screen.getByRole("region", { name: "Tagging" })
    expect(bar.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.tagName).toBe("P")
  })
})
