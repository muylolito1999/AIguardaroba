// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { homeCityDataIsStale } from "@/components/today/today-changes"
import { toast } from "@/components/ui/toast"
import { err, ok, type Result } from "@/lib/result"
import type { HomeCitySettingsDto } from "@/server/services/settings"

import { HomeProfileSelect, type SetHomeProfileAction } from "./home-profile-select"

const BOLOGNA = { id: "00000000-0000-4000-8000-000000000001", slug: "bologna", city: "Bologna", country: "Italy" }
const HAMBURG = { id: "00000000-0000-4000-8000-000000000002", slug: "hamburg", city: "Hamburg", country: "Germany" }
const SETTINGS: HomeCitySettingsDto = { homeProfileId: BOLOGNA.id, options: [BOLOGNA, HAMBURG] }

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function select(): HTMLSelectElement {
  const element = screen.getByLabelText("Home city")
  if (!(element instanceof HTMLSelectElement)) throw new Error("not a select")
  return element
}

function deferred() {
  let settle: (result: Result<HomeCitySettingsDto>) => void = () => undefined
  const promise = new Promise<Result<HomeCitySettingsDto>>((done) => {
    settle = done
  })
  return { promise, settle }
}

describe("HomeProfileSelect", () => {
  it("shows the saved city among Bologna and Hamburg", () => {
    render(<HomeProfileSelect settings={SETTINGS} setHomeProfile={vi.fn()} />)
    expect(select().value).toBe(BOLOGNA.id)
    expect([...select().options].map((option) => option.textContent)).toEqual(["Bologna, Italy", "Hamburg, Germany"])
  })

  it("saves a new city at once, says so, and tells a kept /today to read again", async () => {
    const save = deferred()
    const setHomeProfile = vi.fn<SetHomeProfileAction>().mockReturnValue(save.promise)
    render(<HomeProfileSelect settings={SETTINGS} setHomeProfile={setHomeProfile} />)
    const todayData = {}
    expect(homeCityDataIsStale(todayData)).toBe(false)

    fireEvent.change(select(), { target: { value: HAMBURG.id } })

    expect(setHomeProfile).toHaveBeenCalledWith({ profileId: HAMBURG.id })
    expect(select().value).toBe(HAMBURG.id)
    expect(select().disabled).toBe(true)
    expect(screen.getByRole("status").textContent).toBe("Saving Hamburg…")

    await act(async () => save.settle(ok({ ...SETTINGS, homeProfileId: HAMBURG.id })))

    expect(select().disabled).toBe(false)
    expect(select().value).toBe(HAMBURG.id)
    expect(toastAdd).toHaveBeenCalledWith({ title: "Home city: Hamburg", type: "success" })
    expect(homeCityDataIsStale(todayData)).toBe(true)
  })

  it("puts the saved city back and toasts the error when the save is refused", async () => {
    const setHomeProfile = vi.fn<SetHomeProfileAction>().mockResolvedValue(err("NOT_FOUND", "That city no longer exists."))
    render(<HomeProfileSelect settings={SETTINGS} setHomeProfile={setHomeProfile} />)

    await act(async () => fireEvent.change(select(), { target: { value: HAMBURG.id } }))

    expect(select().value).toBe(BOLOGNA.id)
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "That city no longer exists." })
    )
  })

  it("offers a placeholder while no home city is set", () => {
    render(<HomeProfileSelect settings={{ ...SETTINGS, homeProfileId: null }} setHomeProfile={vi.fn()} />)
    expect(select().value).toBe("")
    expect(select().options[0]?.textContent).toBe("Choose a city")
  })
})
