// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { runListIsStale } from "@/components/relocate/run-changes"
import { toast } from "@/components/ui/toast"
import { BOLOGNA } from "@/lib/climate/bologna"
import { HAMBURG } from "@/lib/climate/hamburg"
import { hasCompleteMonths, type ClimateMonth, type ClimateProfileInput } from "@/lib/climate/types"
import type { ClimateProfileDto } from "@/lib/relocation/contracts"
import { ok } from "@/lib/result"

import type { ClimateActions, SetDefaultClimateProfileAction, UpdateClimateProfileAction } from "./climate-actions"
import type { ClimateProfileUpdate } from "./climate-model"
import { ClimateProfiles } from "./climate-profiles"

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const HAMBURG_ID = "00000000-0000-4000-8000-0000000000a1"
const BOLOGNA_ID = "00000000-0000-4000-8000-0000000000b1"

function dto(id: string, input: ClimateProfileInput): ClimateProfileDto {
  return {
    id,
    slug: input.slug,
    city: input.city,
    country: input.country,
    source: input.source,
    isDefault: input.isDefault,
    isPlaceholder: input.isPlaceholder,
    complete: hasCompleteMonths(input.months),
    months: input.months,
    windNotes: input.windNotes,
    notes: input.notes,
  }
}

/** The action as the server answers: the saved months, and the placeholder flag cleared once complete. */
function fakeUpdate(profiles: ClimateProfileDto[]) {
  return vi.fn<UpdateClimateProfileAction>(async (input: ClimateProfileUpdate) => {
    const profile = profiles.find((entry) => entry.id === input.id)
    if (profile === undefined) throw new Error("unknown profile")
    const complete = hasCompleteMonths(input.months)
    return ok({ ...profile, ...input, complete, isPlaceholder: profile.isPlaceholder && !complete })
  })
}

function setup() {
  const profiles = [dto(HAMBURG_ID, HAMBURG), dto(BOLOGNA_ID, BOLOGNA)]
  const actions = {
    updateClimateProfile: fakeUpdate(profiles),
    setDefaultClimateProfile: vi.fn<SetDefaultClimateProfileAction>(),
  } satisfies ClimateActions
  render(<ClimateProfiles profiles={profiles} actions={actions} />)
  return { actions, profiles }
}

function card(city: string): HTMLElement {
  return screen.getByRole("region", { name: city })
}

function isDisabled(button: HTMLElement): boolean {
  return button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true"
}

function cell(city: string, label: string): HTMLInputElement {
  const input = within(card(city)).getByLabelText(label)
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} is not an input`)
  return input
}

function lastUpdate(update: ReturnType<typeof fakeUpdate>): ClimateProfileUpdate {
  const call = update.mock.lastCall
  if (call === undefined) throw new Error("not called")
  return call[0]
}

function month(update: ClimateProfileUpdate, number: number): ClimateMonth {
  const found = update.months.find((entry) => entry.month === number)
  if (found === undefined) throw new Error(`no month ${number}`)
  return found
}

describe("the climate editor", () => {
  it("shows each profile with its badges and the seed notes", () => {
    setup()

    expect(within(card("Hamburg")).getByText("Default")).toBeTruthy()
    expect(within(card("Hamburg")).getByText(/Running pnpm db:seed restores these reference values/)).toBeTruthy()
    expect(within(card("Bologna")).getByText("Placeholder", { exact: true })).toBeTruthy()
    expect(within(card("Bologna")).getByText(/Running pnpm db:seed makes Hamburg the default again/)).toBeTruthy()
    expect(within(card("Bologna")).queryByText(/restores these reference values/)).toBeNull()
    expect(cell("Hamburg", "January max °C").value).toBe("4.2")
    expect(cell("Bologna", "February max °C").value).toBe("")
  })

  it("enables Save only when a value changed", () => {
    setup()
    const save = within(card("Hamburg")).getByRole("button", { name: "Save" })
    expect(isDisabled(save)).toBe(true)

    fireEvent.change(cell("Hamburg", "January max °C"), { target: { value: "4.5" } })
    expect(isDisabled(save)).toBe(false)

    // The same number written differently is not a change.
    fireEvent.change(cell("Hamburg", "January max °C"), { target: { value: "4.20" } })
    expect(isDisabled(save)).toBe(true)

    fireEvent.change(within(card("Hamburg")).getByLabelText("Notes"), { target: { value: "Edited" } })
    expect(isDisabled(save)).toBe(false)
  })

  it("saves an emptied input as unknown (null)", async () => {
    const { actions } = setup()

    fireEvent.change(cell("Hamburg", "January max °C"), { target: { value: "" } })
    await act(async () => {
      fireEvent.click(within(card("Hamburg")).getByRole("button", { name: "Save" }))
    })

    const update = lastUpdate(actions.updateClimateProfile)
    expect(update.id).toBe(HAMBURG_ID)
    expect(month(update, 1)).toMatchObject({ tmax: null, tmin: -0.5, tmean: 2.1 })
    expect(month(update, 2)).toEqual(HAMBURG.months[1])
    expect(update.months).toHaveLength(12)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Hamburg saved" }))
    expect(within(card("Hamburg")).getByText("Incomplete")).toBeTruthy()
  })

  it("explains a row with an error once it is left, and does not save it", async () => {
    const { actions } = setup()
    const min = cell("Hamburg", "March min °C")

    fireEvent.change(min, { target: { value: "20" } })
    expect(within(card("Hamburg")).queryByText(/Temperatures must go/)).toBeNull()
    fireEvent.blur(min)

    const message = within(card("Hamburg")).getByText(/Temperatures must go Min ≤ Mean ≤ Max\./)
    expect(message.textContent).toBe("March: Temperatures must go Min ≤ Mean ≤ Max.")
    expect(min.getAttribute("aria-invalid")).toBe("true")
    expect(min.getAttribute("aria-describedby")).toBe(message.id)

    fireEvent.change(cell("Hamburg", "May rain days"), { target: { value: "45" } })
    await act(async () => {
      fireEvent.click(within(card("Hamburg")).getByRole("button", { name: "Save" }))
    })

    expect(actions.updateClimateProfile).not.toHaveBeenCalled()
    expect(within(card("Hamburg")).getByRole("alert").textContent).toBe("2 months need fixing before this can be saved.")
    expect(within(card("Hamburg")).getByText(/Rain days must be between 0 and 31\./).textContent).toBe(
      "May: Rain days must be between 0 and 31."
    )
    expect(document.activeElement).toBe(cell("Hamburg", "March max °C"))
  })

  it("treats text an emptied cell cannot read, such as a lone '-', as an error, not unknown (D-153, D-182)", async () => {
    const { actions } = setup()
    const min = cell("Hamburg", "January min °C")
    fireEvent.change(min, { target: { value: "" } })

    // Typing "-" into the empty cell: the browser keeps the value "" and flags
    // badInput, and React's onChange skips an input event that leaves the value as it was.
    Object.defineProperty(min, "validity", { configurable: true, value: { badInput: true, valid: false } })
    fireEvent.input(min)
    fireEvent.blur(min)

    const message = within(card("Hamburg")).getByText(/Min °C: enter a number, or leave it empty\./)
    expect(message.textContent).toBe("January: Min °C: enter a number, or leave it empty.")
    expect(min.getAttribute("aria-invalid")).toBe("true")
    await act(async () => {
      fireEvent.click(within(card("Hamburg")).getByRole("button", { name: "Save" }))
    })
    expect(actions.updateClimateProfile).not.toHaveBeenCalled()

    // Deleting the "-" leaves "" with nothing unreadable: unknown again, and the error goes.
    Object.defineProperty(min, "validity", { configurable: true, value: { badInput: false, valid: true } })
    fireEvent.input(min)
    expect(within(card("Hamburg")).queryByText(/Min °C: enter a number, or leave it empty\./)).toBeNull()
  })

  it("drops the placeholder badge once every Bologna value is filled in", async () => {
    const { actions } = setup()
    const values = { "max °C": "20", "min °C": "8", "mean °C": "14", "rain mm": "60", "rain days": "7", "sun hours": "150" }
    const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    for (const name of names) {
      for (const [field, value] of Object.entries(values)) {
        fireEvent.change(cell("Bologna", `${name} ${field}`), { target: { value } })
      }
    }

    await act(async () => {
      fireEvent.click(within(card("Bologna")).getByRole("button", { name: "Save" }))
    })

    expect(month(lastUpdate(actions.updateClimateProfile), 7)).toMatchObject({ tmax: 20, precip_days: 7, sunshine_h: 150 })
    expect(within(card("Bologna")).queryByText("Placeholder", { exact: true })).toBeNull()
    // This fake server keeps the seeded notes, which still say "Placeholder", so the toast says so (D-169).
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "Every value is filled in, so it is no longer marked as placeholder data. Its notes still mention placeholder data; edit them if they no longer fit.",
      })
    )
    expect(isDisabled(within(card("Bologna")).getByRole("button", { name: "Save" }))).toBe(true)
  })

  it("makes a /relocate page shown before a save read its profiles again", async () => {
    const { actions, profiles } = setup()
    const bologna = profiles[1]
    if (bologna === undefined) throw new Error("fixture")
    actions.setDefaultClimateProfile.mockResolvedValue(ok({ ...bologna, isDefault: true }))
    // The earlier-runs list of a /relocate page Next keeps hidden, shown before the save.
    const shownRuns = {}
    expect(runListIsStale(shownRuns)).toBe(false)

    await act(async () => {
      fireEvent.click(within(card("Bologna")).getByRole("button", { name: "Set as default" }))
    })

    expect(runListIsStale(shownRuns)).toBe(true)
  })

  it("moves the default badge when another profile becomes the default", async () => {
    const { actions, profiles } = setup()
    const bologna = profiles[1]
    if (bologna === undefined) throw new Error("fixture")
    actions.setDefaultClimateProfile.mockResolvedValue(ok({ ...bologna, isDefault: true }))
    expect(within(card("Hamburg")).queryByRole("button", { name: "Set as default" })).toBeNull()

    await act(async () => {
      fireEvent.click(within(card("Bologna")).getByRole("button", { name: "Set as default" }))
    })

    expect(actions.setDefaultClimateProfile).toHaveBeenCalledWith({ id: BOLOGNA_ID })
    expect(within(card("Bologna")).getByText("Default")).toBeTruthy()
    expect(within(card("Hamburg")).queryByText("Default")).toBeNull()
    expect(within(card("Hamburg")).getByRole("button", { name: "Set as default" })).toBeTruthy()
  })

  it("moves focus to the default hint when Set as default leaves, not to <body> (D-172)", async () => {
    const { actions, profiles } = setup()
    const bologna = profiles[1]
    if (bologna === undefined) throw new Error("fixture")
    actions.setDefaultClimateProfile.mockResolvedValue(ok({ ...bologna, isDefault: true }))
    const button = within(card("Bologna")).getByRole("button", { name: "Set as default" })
    button.focus()

    await act(async () => {
      fireEvent.click(button)
    })
    // The focus step runs in the next animation frame.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })

    expect(button.isConnected).toBe(false)
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement?.textContent).toMatch(/^The relocation form starts with this profile\./)
    expect(card("Bologna").contains(document.activeElement)).toBe(true)
  })

  it("leaves focus on Set as default when the request fails", async () => {
    const { actions } = setup()
    actions.setDefaultClimateProfile.mockResolvedValue({ ok: false, error: { code: "UPSTREAM", message: "Offline." } })
    const button = within(card("Bologna")).getByRole("button", { name: "Set as default" })
    button.focus()

    await act(async () => {
      fireEvent.click(button)
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })

    expect(document.activeElement).toBe(button)
  })

  it("keeps unsaved edits when the default moves", async () => {
    const { actions, profiles } = setup()
    const bologna = profiles[1]
    if (bologna === undefined) throw new Error("fixture")
    actions.setDefaultClimateProfile.mockResolvedValue(ok({ ...bologna, isDefault: true }))
    fireEvent.change(cell("Bologna", "March max °C"), { target: { value: "15" } })

    await act(async () => {
      fireEvent.click(within(card("Bologna")).getByRole("button", { name: "Set as default" }))
    })

    expect(cell("Bologna", "March max °C").value).toBe("15")
    expect(isDisabled(within(card("Bologna")).getByRole("button", { name: "Save" }))).toBe(false)
  })
})
