// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { toast } from "@/components/ui/toast"
import type { OutfitSlot } from "@/lib/db/enums"
import type { OutfitDetailDto, OutfitItemDto, SlotCandidateDto } from "@/lib/outfits/contracts"
import { err, ok, type Result } from "@/lib/result"

import { OutfitForm, type OutfitFormProps } from "./outfit-form"
import { valuesFromOutfit } from "./outfit-form-model"

const SWEATER = "11111111-1111-4111-8111-111111111111"
const DRESS = "22222222-2222-4222-8222-222222222222"
const JEANS = "33333333-3333-4333-8333-333333333333"
const BELT = "44444444-4444-4444-8444-444444444444"
const RUNNING = "55555555-5555-4555-8555-555555555555"
const TEE = "66666666-6666-4666-8666-666666666666"
const HOODIE = "77777777-7777-4777-8777-777777777777"
const SOCKS = "88888888-8888-4888-8888-888888888888"

function candidate(id: string, category: SlotCandidateDto["category"], name: string, extra: Partial<SlotCandidateDto> = {}) {
  return {
    id,
    name,
    category,
    subcategory: null,
    colors: [],
    warmthLevel: 2,
    waterproof: false,
    thumbUrl: null,
    wearCount: 0,
    lastWornAt: null,
    location: "hamburg",
    ...extra,
  } satisfies SlotCandidateDto
}

const TOPS = [
  candidate(SWEATER, "top", "Grey merino sweater", { wearCount: 3, lastWornAt: "2026-10-30T11:00:00.000Z" }),
  candidate(HOODIE, "top", "Navy cotton hoodie"),
  candidate(TEE, "top", "White cotton tee"),
]

// As the server lists them: every top is a candidate for the top and the mid layer (D-253).
const CANDIDATES: Record<OutfitSlot, SlotCandidateDto[]> = {
  outerwear: [],
  mid_layer: TOPS,
  base_layer: [],
  top: [candidate(DRESS, "dress", "Black wool dress", { colors: ["black"] }), ...TOPS],
  bottom: [candidate(JEANS, "bottom", "Dark jeans")],
  socks: [candidate(SOCKS, "socks", "Grey wool socks")],
  shoes: [],
  hat: [],
  gloves: [],
  scarf: [],
  accessory: [candidate(BELT, "accessory", "Brown belt")],
}

beforeEach(() => {
  vi.spyOn(toast, "add").mockReturnValue("toast-id")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setup(overrides: Partial<OutfitFormProps> = {}) {
  const onSubmit = vi.fn<OutfitFormProps["onSubmit"]>()
  const onSaved = vi.fn<OutfitFormProps["onSaved"]>()
  render(
    <OutfitForm
      initial={valuesFromOutfit(null)}
      candidates={CANDIDATES}
      current={[]}
      submitLabel="Save outfit"
      onSubmit={onSubmit}
      onSaved={onSaved}
      {...overrides}
    />
  )
  return { onSubmit, onSaved }
}

function slotGroup(label: string) {
  return screen.getByRole("group", { name: label })
}

async function pick(buttonName: string, itemName: string) {
  fireEvent.click(screen.getByRole("button", { name: buttonName }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(itemName) }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
}

describe("OutfitForm", () => {
  it("shows a row's small text in full colour on its error tint, where the muted grey is too faint", () => {
    setup()
    const requirement = () => within(slotGroup("Top or dress")).getByText("Required")
    expect(requirement().className).toContain("text-muted-foreground")
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))
    expect(requirement().className).toContain("text-foreground")
    expect(requirement().className).not.toContain("text-muted-foreground")
  })

  it("shows what is missing next to each slot and field, without sending", async () => {
    const { onSubmit } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))

    expect(within(slotGroup("Top or dress")).getByText("Choose a top or a dress.")).toBeTruthy()
    expect(within(slotGroup("Bottom")).getByText("Choose a bottom, or a dress as the top.")).toBeTruthy()
    expect(screen.getByText("Give the outfit a name.")).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
    // The first problem in the form gets focus: the top slot's button, which the message describes.
    const choose = screen.getByRole("button", { name: "Choose top or dress" })
    expect(document.activeElement).toBe(choose)
    expect(choose.getAttribute("aria-describedby")).toBeTruthy()
  })

  it("builds an outfit with the pickers and saves it", async () => {
    let answer: (value: Result<OutfitDetailDto>) => void = () => undefined
    const { onSubmit, onSaved } = setup()
    onSubmit.mockReturnValue(new Promise((resolve) => (answer = resolve)))

    await pick("Choose top or dress", "Grey merino sweater")
    expect(within(slotGroup("Top or dress")).getByText("Grey merino sweater")).toBeTruthy()
    await pick("Choose bottom", "Dark jeans")
    await pick("Add accessory", "Brown belt")
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekend" } })
    fireEvent.change(screen.getByLabelText("Lowest °C"), { target: { value: "4,5" } })
    fireEvent.click(screen.getByRole("checkbox", { name: "Fine in rain" }))

    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      name: "Weekend",
      occasion: "",
      weatherMinC: 4.5,
      weatherMaxC: null,
      rainOk: true,
      rating: null,
      notes: "",
      items: [
        { slot: "top", itemId: SWEATER },
        { slot: "bottom", itemId: JEANS },
        { slot: "accessory", itemId: BELT },
      ],
    })
    // Disabled while saving: a second press sends nothing.
    const saving = screen.getByRole("button", { name: "Saving…" })
    expect(saving.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(saving)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    answer(ok({ id: "outfit-1", name: "Weekend" } as OutfitDetailDto))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it("lets a dress stand without a bottom and shows the picker's wear details", async () => {
    const { onSubmit } = setup()
    onSubmit.mockResolvedValue(ok({ id: "outfit-1", name: "Dinner" } as OutfitDetailDto))
    fireEvent.click(screen.getByRole("button", { name: "Choose top or dress" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Worn 3 times, last 30 Oct 2026")).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText("Search"), { target: { value: "black" } })
    expect(within(dialog).queryByText("Grey merino sweater")).toBeNull()
    fireEvent.click(within(dialog).getByRole("button", { name: /Black wool dress/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    expect(within(slotGroup("Bottom")).getByText("Optional with a dress")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dinner" } })
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it("layers a hoodie over a tee, adds socks and saves them, never offering one item for two slots (D-253)", async () => {
    const { onSubmit, onSaved } = setup()
    onSubmit.mockResolvedValue(ok({ id: "outfit-1", name: "Layers" } as OutfitDetailDto))
    expect(within(slotGroup("Mid layer")).getByText("Optional: a sweater, hoodie or cardigan over the top")).toBeTruthy()
    expect(within(slotGroup("Socks")).getByText("Optional")).toBeTruthy()

    await pick("Choose top or dress", "White cotton tee")
    // The tee is in the top: the mid layer's picker shows it as chosen and does not offer it again.
    fireEvent.click(screen.getByRole("button", { name: "Choose mid layer" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Choose a mid layer")).toBeTruthy()
    const tee = within(dialog).getByRole("button", { name: /White cotton tee/ })
    expect(tee.getAttribute("aria-disabled")).toBe("true")
    expect(within(tee).getByText("Chosen")).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: /Navy cotton hoodie/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await pick("Choose bottom", "Dark jeans")
    await pick("Choose socks", "Grey wool socks")
    expect(within(slotGroup("Top or dress")).getByText("White cotton tee")).toBeTruthy()
    expect(within(slotGroup("Mid layer")).getByText("Navy cotton hoodie")).toBeTruthy()
    expect(within(slotGroup("Socks")).getByText("Grey wool socks")).toBeTruthy()
    expect(within(slotGroup("Top or dress")).queryByText("Navy cotton hoodie")).toBeNull()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Layers" } })
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const sent = onSubmit.mock.calls[0]?.[0]
    expect(sent?.items).toHaveLength(4)
    expect(sent?.items).toEqual(
      expect.arrayContaining([
        { slot: "top", itemId: TEE },
        { slot: "mid_layer", itemId: HOODIE },
        { slot: "bottom", itemId: JEANS },
        { slot: "socks", itemId: SOCKS },
      ])
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it("lists the hoodie before the tee for the mid layer, and the tee first for the top", async () => {
    // As the server lists them, by name: the tee comes before the hoodie.
    const tee = candidate(TEE, "top", "Breton striped tee")
    const hoodie = candidate(HOODIE, "top", "Navy cotton hoodie")
    const turtleneck = candidate(SWEATER, "top", "Oatmeal turtleneck")
    const dress = candidate(DRESS, "dress", "Wrap dress")
    const names = ["Breton striped tee", "Navy cotton hoodie", "Oatmeal turtleneck", "Wrap dress"]
    setup({ candidates: { ...CANDIDATES, mid_layer: [tee, hoodie, turtleneck], top: [tee, hoodie, turtleneck, dress] } })

    const listed = async (buttonName: string) => {
      fireEvent.click(screen.getByRole("button", { name: buttonName }))
      const dialog = await screen.findByRole("dialog")
      const rows = within(within(dialog).getByRole("list", { name: "Items" })).getAllByRole("listitem")
      return { dialog, order: rows.map((row) => names.find((name) => row.textContent?.includes(name))) }
    }

    const mid = await listed("Choose mid layer")
    expect(mid.order).toEqual(["Navy cotton hoodie", "Oatmeal turtleneck", "Breton striped tee"])
    fireEvent.click(within(mid.dialog).getByRole("button", { name: /Navy cotton hoodie/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    const top = await listed("Choose top or dress")
    expect(top.order).toEqual(["Breton striped tee", "Oatmeal turtleneck", "Wrap dress", "Navy cotton hoodie"])
    // The hoodie is in the mid layer: still listed, last, as chosen.
    const chosen = within(top.dialog).getByRole("button", { name: /Navy cotton hoodie/ })
    expect(chosen.getAttribute("aria-disabled")).toBe("true")
  })

  it("shows the server's slot issues next to the slot", async () => {
    const { onSubmit, onSaved } = setup()
    onSubmit.mockResolvedValue(
      err("VALIDATION", "This item is archived.", {
        outfitIssues: [{ code: "archived_item", slot: "bottom", itemId: JEANS, message: "This item is archived." }],
      })
    )
    await pick("Choose top or dress", "Grey merino sweater")
    await pick("Choose bottom", "Dark jeans")
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekend" } })
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))

    expect(await within(slotGroup("Bottom")).findByText("This item is archived.")).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()

    // Removing the item clears the server's message.
    fireEvent.click(screen.getByRole("button", { name: "Remove Dark jeans" }))
    expect(within(slotGroup("Bottom")).queryByText("This item is archived.")).toBeNull()
  })

  it("flags an item the outfit holds that moved to running gear, and refuses to send it (D-250)", async () => {
    const running: OutfitItemDto = {
      itemId: RUNNING,
      slot: "bottom",
      name: "Running tights",
      category: "bottom",
      thumbUrl: null,
      status: "confirmed",
      collection: "running",
      wearCount: 4,
      exists: true,
    }
    const { onSubmit } = setup({
      initial: {
        ...valuesFromOutfit(null),
        name: "Long run",
        entries: [
          { slot: "top", itemId: SWEATER },
          { slot: "bottom", itemId: RUNNING },
        ],
      },
      current: [running],
    })

    const bottom = slotGroup("Bottom")
    expect(within(bottom).getByText("Running tights")).toBeTruthy()
    expect(within(bottom).getByText("Running gear")).toBeTruthy()
    expect(within(bottom).queryByText("Archived")).toBeNull()
    expect(within(slotGroup("Top or dress")).queryByText("Running gear")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))
    expect(within(bottom).getByText("This item is running gear, which outfits leave out.")).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change bottom" }))

    // Swapped for clothing, it sends.
    onSubmit.mockResolvedValue(ok({ id: "outfit-1", name: "Long run" } as OutfitDetailDto))
    await pick("Change bottom", "Dark jeans")
    expect(within(slotGroup("Bottom")).queryByText("Running gear")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it("shows the server's not_clothing issue next to its slot", async () => {
    const message = "This item is running gear, which outfits leave out."
    const { onSubmit, onSaved } = setup()
    onSubmit.mockResolvedValue(
      err("VALIDATION", message, {
        outfitIssues: [{ code: "not_clothing", slot: "bottom", itemId: JEANS, message }],
      })
    )
    await pick("Choose top or dress", "Grey merino sweater")
    await pick("Choose bottom", "Dark jeans")
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekend" } })
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))

    expect(await within(slotGroup("Bottom")).findByText(message)).toBeTruthy()
    expect(within(slotGroup("Top or dress")).queryByText(message)).toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("toasts other errors", async () => {
    const { onSubmit } = setup()
    onSubmit.mockResolvedValue(err("NOT_FOUND", "That outfit no longer exists."))
    await pick("Choose top or dress", "Black wool dress")
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dinner" } })
    fireEvent.click(screen.getByRole("button", { name: "Save outfit" }))
    await waitFor(() => expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })))
  })
})
