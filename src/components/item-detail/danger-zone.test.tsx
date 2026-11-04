// @vitest-environment jsdom
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { taggedCard } from "@/components/items/test-fixtures"
import { toast } from "@/components/ui/toast"
import type { ItemStatus } from "@/lib/db/enums"
import type { ItemDetailDto } from "@/lib/items/wardrobe"
import { CONFIG_ERROR_MESSAGE, err, ok, type Result } from "@/lib/result"

import { DangerZone, unarchivedDescription } from "./danger-zone"
import type { ArchiveItemAction, DeleteItemAction, UnarchiveItemAction } from "./detail-actions"

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}))

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
  router.replace.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function detail(status: ItemStatus): ItemDetailDto {
  return {
    ...taggedCard({ status }),
    updatedAt: "2026-11-02T10:00:00.000Z",
    wearCount: 0,
    lastWornAt: null,
    original: null,
  }
}

type Actions = {
  archiveItem: ArchiveItemAction
  unarchiveItem: UnarchiveItemAction
  deleteItem: DeleteItemAction
}

/** Holds the status like the detail page does. */
function Harness({ initial, actions }: { initial: ItemDetailDto; actions: Actions }) {
  const [item, setItem] = useState(initial)
  return (
    <DangerZone
      item={item}
      name="Navy wool coat"
      {...actions}
      onStatusChange={(next) => setItem((previous) => ({ ...previous, status: next.status }))}
    />
  )
}

function setup(status: ItemStatus = "confirmed") {
  const item = detail(status)
  const actions = {
    archiveItem: vi.fn<ArchiveItemAction>(),
    unarchiveItem: vi.fn<UnarchiveItemAction>(),
    deleteItem: vi.fn<DeleteItemAction>(),
  }
  render(<Harness initial={item} actions={actions} />)
  return { item, ...actions }
}

async function openDeleteDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Delete item" }))
  return screen.findByRole("alertdialog")
}

describe("DangerZone", () => {
  it("asks before deleting and says what goes", async () => {
    const { deleteItem } = setup()

    const dialog = await openDeleteDialog()

    expect(within(dialog).getByRole("heading", { name: "Delete Navy wool coat?" })).toBeTruthy()
    expect(dialog.textContent).toContain("including from photo storage")
    expect(dialog.textContent).toContain("This cannot be undone.")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(deleteItem).not.toHaveBeenCalled()
  })

  it("mentions the wear history only when the item was worn", async () => {
    const item = { ...detail("confirmed"), wearCount: 4 }
    render(<Harness initial={item} actions={{ archiveItem: vi.fn(), unarchiveItem: vi.fn(), deleteItem: vi.fn() }} />)

    const dialog = await openDeleteDialog()

    expect(dialog.textContent).toContain("along with its wear history")
  })

  it("deletes, shows a toast and replaces the page with the wardrobe", async () => {
    const { item, deleteItem } = setup()
    deleteItem.mockResolvedValue(ok({ deleted: true }))

    const dialog = await openDeleteDialog()
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/wardrobe"))
    expect(deleteItem).toHaveBeenCalledWith({ id: item.id })
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Item deleted", type: "success" }))
  })

  it("keeps the dialog open with the reason when the delete fails, and stays on the page", async () => {
    const { deleteItem } = setup()
    let settle: (result: Result<{ deleted: true }>) => void = () => undefined
    deleteItem.mockReturnValue(new Promise((done) => (settle = done)))

    const dialog = await openDeleteDialog()
    const confirm = within(dialog).getByRole("button", { name: "Delete" })
    fireEvent.click(confirm)

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeTruthy())
    expect(within(dialog).getByRole("button", { name: "Deleting…" }).getAttribute("aria-disabled")).toBe("true")
    await act(async () => settle(err("CONFIG", CONFIG_ERROR_MESSAGE)))

    const alert = await within(dialog).findByRole("alert")
    expect(alert.textContent).toContain("Not deleted")
    expect(alert.textContent).toContain(CONFIG_ERROR_MESSAGE)
    expect(screen.getByRole("alertdialog")).toBe(dialog)
    expect(within(dialog).getByRole("button", { name: "Delete" }).getAttribute("aria-disabled")).not.toBe("true")
    expect(router.replace).not.toHaveBeenCalled()
  })

  it("clears an earlier failure when the dialog is opened again", async () => {
    const { deleteItem } = setup()
    // A refusal deleteItem still gives (no Blob token); a Blob failure no longer keeps the item (D-234).
    deleteItem.mockResolvedValue(err("CONFIG", CONFIG_ERROR_MESSAGE))

    let dialog = await openDeleteDialog()
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    await within(dialog).findByRole("alert")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())

    dialog = await openDeleteDialog()
    expect(within(dialog).queryByRole("alert")).toBeNull()
  })

  it("archives, then unarchives with the same button", async () => {
    const { item, archiveItem, unarchiveItem } = setup("confirmed")
    archiveItem.mockResolvedValue(ok({ ...detail("archived"), id: item.id }))
    unarchiveItem.mockResolvedValue(ok({ ...detail("confirmed"), id: item.id }))

    const button = screen.getByRole("button", { name: "Archive" })
    button.focus()
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole("button", { name: "Unarchive" })).toBe(button))
    expect(archiveItem).toHaveBeenCalledWith({ id: item.id })
    expect(document.activeElement).toBe(button)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Archived", type: "success" }))

    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive" })).toBe(button))
    expect(unarchiveItem).toHaveBeenCalledWith({ id: item.id })
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Back in your wardrobe", description: "Navy wool coat is confirmed again." })
    )
  })

  it("says where an unarchived item came back to", async () => {
    const { item, unarchiveItem } = setup("archived")
    unarchiveItem.mockResolvedValue(ok({ ...detail("tagged"), id: item.id }))

    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }))

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Back in your wardrobe",
          description: "Navy wool coat is back on the review page, with its tags still to check.",
        })
      )
    )
    expect(unarchivedDescription("Scarf", "pending_tagging")).toBe("Scarf is waiting for tags again.")
  })

  it("keeps the status and shows a toast when archiving fails", async () => {
    const { archiveItem } = setup("tagged")
    archiveItem.mockResolvedValue(err("NOT_FOUND", "That item no longer exists."))

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "Not found" }))
    )
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy()
  })
})
