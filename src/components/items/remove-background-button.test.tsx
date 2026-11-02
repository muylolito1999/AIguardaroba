// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { toast } from "@/components/ui/toast"
import type { RemoveBackgroundOptions, SaveCutoutDeps } from "@/lib/images/bg-removal"
import { ITEM_API, type ItemCardDto } from "@/lib/items/contracts"
import { AppError } from "@/lib/result"

import { BG_DOWNLOAD_CONSENT_KEY, RemoveBackgroundButton } from "./remove-background-button"
import { taggedCard } from "./test-fixtures"

// The model is faked; saving runs the real saveCutout against a fake server.
const removal = vi.hoisted(() => ({
  calls: [] as Array<{
    url: string
    options: RemoveBackgroundOptions
    resolve: (blob: Blob) => void
    reject: (error: unknown) => void
  }>,
}))
vi.mock("@/lib/images/bg-removal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/images/bg-removal")>()),
  removeBackgroundFromUrl: (url: string, options: RemoveBackgroundOptions = {}) =>
    new Promise<Blob>((resolve, reject) => {
      removal.calls.push({ url, options, resolve, reject })
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason))
    }),
}))

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  removal.calls.length = 0
  window.localStorage.clear()
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function withNobg(item: ItemCardDto): ItemCardDto {
  return {
    ...item,
    images: { ...item.images, nobg: { url: "https://store.example/items/x/nobg-a.webp", width: 768, height: 1024 } },
  }
}

function fakeSaveDeps(item: ItemCardDto): SaveCutoutDeps & { requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    fetch: async (url) => {
      requests.push(url)
      if (url === ITEM_API.blobUpload) {
        return Response.json({ type: "blob.generate-client-token", clientToken: "vercel_blob_client_fake" })
      }
      return Response.json({ ok: true, data: { item: withNobg(item) } })
    },
    putBlob: async (pathname) => ({ url: `https://store.example/${pathname}`, pathname }),
  }
}

function setup(item: ItemCardDto = taggedCard()) {
  const onDone = vi.fn<(item: ItemCardDto) => void>()
  const saveDeps = fakeSaveDeps(item)
  render(<RemoveBackgroundButton item={item} onDone={onDone} saveDeps={saveDeps} />)
  return { item, onDone, saveDeps }
}

function mainButton(): HTMLElement {
  return screen.getByRole("button", { name: /background/i })
}

describe("RemoveBackgroundButton", () => {
  it("explains the one-time download first, and Not now changes nothing", async () => {
    setup()

    fireEvent.click(mainButton())
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/about 57 MB/)).toBeTruthy()
    expect(within(dialog).getByText(/not sent to IMG\.LY/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(removal.calls).toEqual([])
    expect(window.localStorage.getItem(BG_DOWNLOAD_CONSENT_KEY)).toBeNull()
  })

  it("remembers the consent, shows progress and hands the updated item over", async () => {
    const { item, onDone, saveDeps } = setup()

    fireEvent.click(mainButton())
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Download and remove" }))

    await waitFor(() => expect(removal.calls).toHaveLength(1))
    expect(window.localStorage.getItem(BG_DOWNLOAD_CONSENT_KEY)).toBe("1")
    expect(removal.calls[0]?.url).toBe(item.images.processed?.url)
    expect(mainButton().getAttribute("aria-disabled")).toBe("true")
    expect(mainButton().textContent).toBe("Removing background…")

    removal.calls[0]?.options.onProgress?.({ stage: "download", percent: 40 })
    expect(await screen.findByRole("progressbar")).toBeTruthy()
    expect(screen.getAllByText("Loading the model").length).toBeGreaterThan(0)

    removal.calls[0]?.resolve(new Blob(["png"], { type: "image/png" }))

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(withNobg(item)))
    expect(saveDeps.requests).toEqual([ITEM_API.blobUpload, ITEM_API.nobg(item.id)])
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Background removed", type: "success" }))
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull())
  })

  it("skips the question once the download was accepted", async () => {
    window.localStorage.setItem(BG_DOWNLOAD_CONSENT_KEY, "1")
    setup(withNobg(taggedCard()))

    fireEvent.click(screen.getByRole("button", { name: "Remove background again" }))

    await waitFor(() => expect(removal.calls).toHaveLength(1))
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("still works when storage is blocked, asking each time", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    setup()

    fireEvent.click(mainButton())
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Download and remove" }))

    await waitFor(() => expect(removal.calls).toHaveLength(1))
  })

  it("cancels quietly and can start again", async () => {
    window.localStorage.setItem(BG_DOWNLOAD_CONSENT_KEY, "1")
    const { onDone } = setup()

    fireEvent.click(mainButton())
    await waitFor(() => expect(removal.calls).toHaveLength(1))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull())
    expect(removal.calls[0]?.options.signal?.aborted).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
    expect(toastAdd).not.toHaveBeenCalled()

    fireEvent.click(mainButton())
    await waitFor(() => expect(removal.calls).toHaveLength(2))
  })

  it("shows a failure as an error toast and re-enables the button", async () => {
    window.localStorage.setItem(BG_DOWNLOAD_CONSENT_KEY, "1")
    const { onDone } = setup()

    fireEvent.click(mainButton())
    await waitFor(() => expect(removal.calls).toHaveLength(1))
    removal.calls[0]?.reject(new AppError("UPSTREAM", "Background removal failed. Reload the page and try again."))

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "Background removal failed. Reload the page and try again." }),
      ),
    )
    expect(onDone).not.toHaveBeenCalled()
    await waitFor(() => expect(mainButton().getAttribute("aria-disabled")).not.toBe("true"))
  })
})
