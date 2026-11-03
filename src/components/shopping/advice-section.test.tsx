// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FeatureFlags } from "@/components/settings/feature-flags"
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result"

import type { ShoppingAdviceReadyDto } from "./advice-model"
import { ShoppingAdviceSection } from "./advice-section"

// The two async server components that read FEATURE_SHOPPING_AI: rendered by
// awaiting them, with the session, the database and the service mocked.

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  getDb: vi.fn(),
  getShoppingAdviceState: vi.fn(),
  getShoppingAdviceFlag: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
}))
vi.mock("@/lib/auth/dal", () => ({ verifySession: mocks.verifySession }))
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }))
vi.mock("@/server/actions/relocation", () => ({ addGapsToShoppingList: vi.fn() }))
vi.mock("@/server/services/shopping-advice", () => ({
  getShoppingAdviceState: mocks.getShoppingAdviceState,
  getShoppingAdviceFlag: mocks.getShoppingAdviceFlag,
}))
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }))

beforeEach(() => {
  mocks.verifySession.mockReset()
  mocks.verifySession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 })
  mocks.getDb.mockReturnValue({})
  mocks.getShoppingAdviceState.mockReset()
  mocks.getShoppingAdviceFlag.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const READY: ShoppingAdviceReadyDto = {
  enabled: true,
  blocker: "Nothing to rank: your shopping list has nothing left to buy and the latest relocation plan has no other gaps.",
  climate: { city: "Hamburg", country: "Germany" },
  scenarios: [],
  candidates: [],
  omittedCandidates: 0,
  budget: { purchaseBudgetEur: null, boughtMinimumEur: 0, unpricedBought: 0, remainingEur: null, relocationAnalysisId: null },
  model: "claude-sonnet-5-5",
  estimateUsd: null,
  latest: null,
}

describe("ShoppingAdviceSection", () => {
  it("renders nothing with the flag off", async () => {
    mocks.getShoppingAdviceState.mockResolvedValue({ enabled: false })
    const { container } = render(await ShoppingAdviceSection())
    expect(container.innerHTML).toBe("")
    expect(mocks.verifySession).toHaveBeenCalledTimes(1)
  })

  it("renders the panel with the flag on", async () => {
    mocks.getShoppingAdviceState.mockResolvedValue(READY)
    render(await ShoppingAdviceSection())
    expect(screen.getByRole("heading", { level: 2, name: "What to buy next" })).toBeTruthy()
    expect(screen.getByText(/^Nothing to rank/)).toBeTruthy()
  })

  it("says the section is unavailable on a configuration error, without its details", async () => {
    mocks.getShoppingAdviceState.mockRejectedValue(new AppError("CONFIG", "FEATURE_SHOPPING_AI must be true, false, 1 or 0."))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    render(await ShoppingAdviceSection())
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain(CONFIG_ERROR_MESSAGE)
    expect(alert.textContent).not.toContain("FEATURE_SHOPPING_AI")
    expect(logged).toHaveBeenCalled()
  })

  it("lets other errors reach the error boundary", async () => {
    mocks.getShoppingAdviceState.mockRejectedValue(new Error("database down"))
    await expect(ShoppingAdviceSection()).rejects.toThrow("database down")
  })
})

describe("FeatureFlags", () => {
  it.each([
    [{ enabled: false }, "Off", /set FEATURE_SHOPPING_AI to true in the server environment and redeploy/],
    [{ enabled: true }, "On", /shows on Shopping\. Each ranking is a paid Claude call/],
  ])("shows %o as %s", async (flag, badge, explanation) => {
    mocks.getShoppingAdviceFlag.mockResolvedValue(flag)
    render(await FeatureFlags())
    const region = screen.getByRole("region", { name: "Features" })
    expect(region.textContent).toContain("Shopping advice")
    expect(screen.getByText(badge, { exact: true })).toBeTruthy()
    expect(region.textContent).toMatch(explanation)
  })

  it("links to Shopping when the feature is on", async () => {
    mocks.getShoppingAdviceFlag.mockResolvedValue({ enabled: true })
    render(await FeatureFlags())
    expect(screen.getByRole("link", { name: "Shopping" }).getAttribute("href")).toBe("/shopping")
  })

  it("shows an unusable value as unreadable, without its details", async () => {
    mocks.getShoppingAdviceFlag.mockRejectedValue(new AppError("CONFIG", "FEATURE_SHOPPING_AI must be true, false, 1 or 0."))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    render(await FeatureFlags())
    expect(screen.getByText("Unreadable", { exact: true })).toBeTruthy()
    expect(screen.getByText(/cannot use\. Check the server logs\./)).toBeTruthy()
    expect(screen.queryByText(/must be true, false/)).toBeNull()
    expect(logged).toHaveBeenCalled()
  })
})
