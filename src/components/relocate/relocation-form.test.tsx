// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { toast } from "@/components/ui/toast"
import { HAMBURG_MONTHS } from "@/lib/climate/hamburg"
import type {
  ClimateProfileDto,
  RelocationEstimateDto,
  RelocationParamsInput,
  StartRelocationResult,
} from "@/lib/relocation/contracts"
import { err, ok, type Result } from "@/lib/result"

import type { EstimateRelocationAction, StartRelocationAction } from "./actions"
import { RelocationForm } from "./relocation-form"
import { ESTIMATE_DEBOUNCE_MS } from "./use-relocation-estimate"

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

const HAMBURG_ID = "00000000-0000-4000-8000-0000000000e1"
const BOLOGNA_ID = "00000000-0000-4000-8000-0000000000e2"

function profile(overrides: Partial<ClimateProfileDto>): ClimateProfileDto {
  return {
    id: HAMBURG_ID,
    slug: "hamburg",
    city: "Hamburg",
    country: "Germany",
    source: "DWD normals",
    isDefault: false,
    isPlaceholder: false,
    complete: true,
    months: HAMBURG_MONTHS,
    windNotes: "",
    notes: "",
    ...overrides,
  }
}

const PROFILES = [
  profile({ isDefault: true }),
  profile({ id: BOLOGNA_ID, slug: "bologna", city: "Bologna", country: "Italy", isPlaceholder: true, complete: false }),
]

const DATES = { dateFrom: "2026-11-03", dateTo: "2027-11-02" }

function estimateDto(overrides: Partial<RelocationEstimateDto> = {}): RelocationEstimateDto {
  return {
    itemCount: 287,
    excluded: { pending: 12, archived: 0, unconfirmed: 3 },
    chunkCount: 4,
    months: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    model: "claude-sonnet-5-5",
    effort: "medium",
    usd: 0.38,
    lowUsd: 0.27,
    highUsd: 0.57,
    tooLarge: false,
    placeholder: false,
    cached: null,
    budget: { monthToDateUsd: 1, budgetUsd: 10, remainingUsd: 9, blocked: false },
    ...overrides,
  }
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    settle = done
  })
  return { promise, settle }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  })
}

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
  router.push.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup(options: {
  estimate?: EstimateRelocationAction
  start?: StartRelocationAction
} = {}) {
  const estimateRelocation = vi.fn<EstimateRelocationAction>(options.estimate ?? (async () => ok(estimateDto())))
  const startRelocation = vi.fn<StartRelocationAction>(
    options.start ?? (async () => ok<StartRelocationResult>({ kind: "started", analysisId: "new-run" }))
  )
  render(<RelocationForm profiles={PROFILES} defaultDates={DATES} actions={{ estimateRelocation, startRelocation }} />)
  return { estimateRelocation, startRelocation }
}

function runButton(): HTMLElement {
  return screen.getByRole("button", { name: /Run analysis|Starting…/ })
}

const DEFAULT_PARAMS: RelocationParamsInput = {
  climateProfileId: HAMBURG_ID,
  dateFrom: DATES.dateFrom,
  dateTo: DATES.dateTo,
  constraints: "",
  purchaseBudgetEur: null,
  includeOnlyConfirmed: true,
  acceptPlaceholder: false,
}

describe("RelocationForm", () => {
  it("starts with the default profile and dates, and asks for an estimate once the form is quiet", async () => {
    const { estimateRelocation } = setup()

    expect((screen.getByLabelText("Climate profile") as HTMLSelectElement).value).toBe(HAMBURG_ID)
    expect((screen.getByLabelText("Arrival") as HTMLInputElement).value).toBe(DATES.dateFrom)
    expect((screen.getByLabelText("Until") as HTMLInputElement).value).toBe(DATES.dateTo)
    expect(screen.getByText("Covers Nov–Oct, all year.")).toBeTruthy()
    expect(screen.getByRole("switch", { name: "Confirmed items only" }).getAttribute("aria-checked")).toBe("true")

    await advance(ESTIMATE_DEBOUNCE_MS - 1)
    expect(estimateRelocation).not.toHaveBeenCalled()
    await advance(1)
    await flush()
    expect(estimateRelocation).toHaveBeenCalledTimes(1)
    expect(estimateRelocation).toHaveBeenCalledWith(DEFAULT_PARAMS)

    const status = screen.getByRole("status")
    expect(status.textContent).toContain("≈ $0.38 with Sonnet 5.5 · 5 parts · 287 items")
    expect(status.textContent).toContain("Likely between $0.27 and $0.57 at medium effort.")
    expect(status.textContent).toContain("12 waiting for tags and 3 not confirmed are left out.")
  })

  it("waits for typing to pause, and ignores an answer that arrives after a newer one", async () => {
    const answers: { params: RelocationParamsInput; settle: (result: Result<RelocationEstimateDto>) => void }[] = []
    const { estimateRelocation } = setup({
      estimate: (params) => {
        const next = deferred<Result<RelocationEstimateDto>>()
        answers.push({ params, settle: next.settle })
        return next.promise
      },
    })
    await advance(ESTIMATE_DEBOUNCE_MS)
    expect(estimateRelocation).toHaveBeenCalledTimes(1)

    const constraints = screen.getByLabelText("Your constraints")
    for (const text of ["I", "I bike", "I bike daily"]) {
      fireEvent.change(constraints, { target: { value: text } })
      await advance(ESTIMATE_DEBOUNCE_MS / 2)
    }
    expect(estimateRelocation).toHaveBeenCalledTimes(1)
    await advance(ESTIMATE_DEBOUNCE_MS)
    expect(estimateRelocation).toHaveBeenCalledTimes(2)
    expect(answers[1]?.params.constraints).toBe("I bike daily")

    // The newer request answers first; the older answer must not replace it.
    await act(async () => answers[1]?.settle(ok(estimateDto({ itemCount: 20 }))))
    await flush()
    await act(async () => answers[0]?.settle(ok(estimateDto({ itemCount: 99 }))))
    await flush()
    expect(screen.getByRole("status").textContent).toContain("20 items")
    expect(screen.getByRole("status").textContent).not.toContain("99 items")
  })

  it("needs consent before running on a placeholder profile", async () => {
    const { estimateRelocation, startRelocation } = setup()
    fireEvent.change(screen.getByLabelText("Climate profile"), { target: { value: BOLOGNA_ID } })
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()

    expect(screen.getByText("Placeholder data")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toContain("Bologna has placeholder climate data")
    expect(screen.getByRole("link", { name: "Settings, Climate profiles" }).getAttribute("href")).toBe(
      "/settings/climate"
    )
    expect(runButton().getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByText(/Tick “Use the placeholder data anyway” to run on it\./)).toBeTruthy()
    fireEvent.click(runButton())
    expect(startRelocation).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("checkbox", { name: "Use the placeholder data anyway" }))
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()
    expect(estimateRelocation).toHaveBeenLastCalledWith({
      ...DEFAULT_PARAMS,
      climateProfileId: BOLOGNA_ID,
      acceptPlaceholder: true,
    })
    expect(runButton().getAttribute("aria-disabled")).not.toBe("true")

    fireEvent.click(runButton())
    await flush()
    expect(startRelocation).toHaveBeenCalledWith({
      params: { ...DEFAULT_PARAMS, climateProfileId: BOLOGNA_ID, acceptPlaceholder: true },
      force: false,
    })
  })

  it("offers an identical earlier run, and Re-run anyway starts a new one", async () => {
    const { startRelocation } = setup({
      estimate: async () =>
        ok(estimateDto({ cached: { analysisId: "cached-run", completedAt: "2026-11-02T18:30:00.000Z" } })),
    })
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()

    expect(screen.getByRole("heading", { name: "Unchanged since 2 Nov 2026" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "View result" }).getAttribute("href")).toBe("/relocate/cached-run")
    expect(screen.queryByRole("button", { name: "Run analysis" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Re-run anyway" }))
    await flush()
    expect(startRelocation).toHaveBeenCalledWith({ params: DEFAULT_PARAMS, force: true })
    expect(router.push).toHaveBeenCalledWith("/relocate/new-run")
  })

  it("disables Run with the reason when the month's AI budget would be exceeded", async () => {
    const { startRelocation } = setup({
      estimate: async () =>
        ok(estimateDto({ usd: 0.55, budget: { monthToDateUsd: 9.9, budgetUsd: 10, remainingUsd: 0.1, blocked: true } })),
    })
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()

    const run = runButton()
    expect(run.getAttribute("aria-disabled")).toBe("true")
    const reason = document.getElementById(run.getAttribute("aria-describedby") ?? "")
    expect(reason?.textContent).toBe("Not enough AI budget left this month: about $0.55 needed, $0.10 left of $10.00.")
    fireEvent.click(run)
    expect(startRelocation).not.toHaveBeenCalled()
  })

  it("disables Run with the reason when the synthesis would not fit one part (D-175)", async () => {
    const { startRelocation } = setup({
      estimate: async () => ok(estimateDto({ itemCount: 2_000, chunkCount: 29, effort: "high", tooLarge: true })),
    })
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()

    const run = runButton()
    expect(run.getAttribute("aria-disabled")).toBe("true")
    const reason = document.getElementById(run.getAttribute("aria-describedby") ?? "")
    expect(reason?.textContent).toBe(
      "Too many items to plan in one pass at high effort: the packing list would not fit in one part. Analyse fewer items, for example confirmed ones only, or set a lower analysis effort."
    )
    fireEvent.click(run)
    expect(startRelocation).not.toHaveBeenCalled()
  })

  it("starts once however often Run is pressed, then opens the run", async () => {
    const start = deferred<Result<StartRelocationResult>>()
    const { startRelocation } = setup({ start: () => start.promise })
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()

    fireEvent.click(runButton())
    fireEvent.click(runButton())
    await flush()
    expect(startRelocation).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Starting…" }).getAttribute("aria-disabled")).toBe("true")

    await act(async () => start.settle(ok({ kind: "cached", analysisId: "earlier-run" })))
    await flush()
    expect(router.push).toHaveBeenCalledWith("/relocate/earlier-run")
  })

  it("shows a refused start as a toast and lets the owner try again", async () => {
    const { startRelocation } = setup({
      start: async () => err("BUDGET_EXCEEDED", "The monthly AI budget of $10.00 is used up."),
    })
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()

    fireEvent.click(runButton())
    await flush()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "AI budget reached", description: "The monthly AI budget of $10.00 is used up." })
    )
    expect(router.push).not.toHaveBeenCalled()
    expect(runButton().getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(runButton())
    await flush()
    expect(startRelocation).toHaveBeenCalledTimes(2)
  })

  it("sends the budget as whole euros and asks for no estimate while it is invalid", async () => {
    const { estimateRelocation } = setup()
    await advance(ESTIMATE_DEBOUNCE_MS)

    fireEvent.change(screen.getByLabelText("Purchase budget (EUR)"), { target: { value: "12.5" } })
    await advance(ESTIMATE_DEBOUNCE_MS)
    expect(screen.getByText("Enter whole euros, or leave it empty for no budget.")).toBeTruthy()
    expect(estimateRelocation).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Set the budget to €600" }))
    fireEvent.click(screen.getByRole("button", { name: /^Bike commute/ }))
    await advance(ESTIMATE_DEBOUNCE_MS)
    expect(estimateRelocation).toHaveBeenLastCalledWith({
      ...DEFAULT_PARAMS,
      purchaseBudgetEur: 600,
      constraints: "I commute by bike every day.",
    })
  })

  it("keeps focus on a chip and on the €600 button that disable themselves when pressed (D-182)", async () => {
    setup()
    await advance(ESTIMATE_DEBOUNCE_MS)

    // jsdom keeps focus on a natively disabled button, so the attributes are what tell.
    for (const name of [/^Bike commute/, /^Business-casual office/, "Set the budget to €600"]) {
      const button = screen.getByRole("button", { name })
      button.focus()
      fireEvent.click(button)
      expect(button.hasAttribute("disabled")).toBe(false)
      expect(button.getAttribute("aria-disabled")).toBe("true")
      expect(document.activeElement).toBe(button)
    }
    // Pressed again while disabled, a chip adds nothing.
    fireEvent.click(screen.getByRole("button", { name: /^Bike commute/ }))
    expect((screen.getByLabelText("Your constraints") as HTMLTextAreaElement).value).toBe(
      "I commute by bike every day.\nMy office dress code is business casual."
    )
  })

  it("never reads a budget it cannot parse as no budget", async () => {
    const { estimateRelocation, startRelocation } = setup()
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()
    expect(estimateRelocation).toHaveBeenCalledTimes(1)

    const budget = screen.getByLabelText("Purchase budget (EUR)") as HTMLInputElement
    fireEvent.change(budget, { target: { value: "600€" } })
    await advance(ESTIMATE_DEBOUNCE_MS)
    await flush()

    expect(budget.value).toBe("600€")
    expect(screen.getByText("Enter whole euros, or leave it empty for no budget.")).toBeTruthy()
    expect(estimateRelocation).toHaveBeenCalledTimes(1)
    expect(runButton().getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByText("Fix the fields marked above first.")).toBeTruthy()
    fireEvent.click(runButton())
    await flush()
    expect(startRelocation).not.toHaveBeenCalled()
  })

  it("follows a new default profile while kept hidden, unless the owner chose a profile", async () => {
    const estimateRelocation = vi.fn<EstimateRelocationAction>(async () => ok(estimateDto()))
    const startRelocation = vi.fn<StartRelocationAction>()
    const bolognaDefault = [
      profile({ isDefault: false }),
      profile({ id: BOLOGNA_ID, slug: "bologna", city: "Bologna", country: "Italy", isDefault: true }),
    ]
    const ui = (mode: "visible" | "hidden", profiles: ClimateProfileDto[]) => (
      <Activity mode={mode}>
        <RelocationForm profiles={profiles} defaultDates={DATES} actions={{ estimateRelocation, startRelocation }} />
      </Activity>
    )
    const select = () => screen.getByLabelText("Climate profile") as HTMLSelectElement

    const view = render(ui("visible", PROFILES))
    expect(select().value).toBe(HAMBURG_ID)
    view.rerender(ui("hidden", PROFILES))
    view.rerender(ui("visible", bolognaDefault))
    expect(select().value).toBe(BOLOGNA_ID)
    view.unmount()

    // A profile picked by hand stays picked.
    const chosen = render(ui("visible", PROFILES))
    fireEvent.change(select(), { target: { value: HAMBURG_ID } })
    chosen.rerender(ui("hidden", PROFILES))
    chosen.rerender(ui("visible", bolognaDefault))
    expect(select().value).toBe(HAMBURG_ID)
  })
})
