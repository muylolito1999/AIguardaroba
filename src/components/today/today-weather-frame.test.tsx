// @vitest-environment jsdom
import { Activity, StrictMode, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WeatherSnapshot } from "@/lib/weather/open-meteo"

import { TodayWeatherFrame } from "./today-weather-frame"
import { WeatherCard } from "./weather-card"
import { WeatherUnavailable } from "./weather-unavailable"

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

beforeEach(() => {
  router.refresh.mockClear()
})

afterEach(() => {
  cleanup()
})

const WEATHER: WeatherSnapshot = {
  date: "2026-11-03",
  timezone: "Europe/Berlin",
  currentC: 9.4,
  tminC: 5.9,
  tmaxC: 10.8,
  apparentMinC: 2.1,
  apparentMaxC: 7.6,
  precipSumMm: 3.4,
  precipProbMax: 80,
  windGustMaxKmh: 52.9,
  weatherCode: 61,
  label: "Light rain",
  fetchedAt: "2026-11-03T13:20:00.000Z",
}

// The page puts the frame in the same place around the error and around the view.
function page(ready: boolean, mode: "visible" | "hidden" = "visible"): ReactNode {
  return (
    <StrictMode>
      <Activity mode={mode}>
        <TodayWeatherFrame ready={ready}>
          {ready ? (
            <WeatherCard weather={WEATHER} city="Hamburg" />
          ) : (
            <WeatherUnavailable city="Hamburg" message="Weather is unavailable right now." />
          )}
        </TodayWeatherFrame>
        <a href="/settings">Settings</a>
      </Activity>
    </StrictMode>
  )
}

async function pressTryAgain(): Promise<HTMLElement> {
  const button = screen.getByRole("button", { name: "Try again" })
  button.focus()
  await act(async () => fireEvent.click(button))
  expect(router.refresh).toHaveBeenCalledTimes(1)
  return button
}

describe("Try again on the weather error", () => {
  it("moves focus to the weather heading and announces the forecast once it loads", async () => {
    const { rerender } = render(page(false))
    await pressTryAgain()

    rerender(page(true))

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Weather in Hamburg" }))
    expect(screen.getByRole("status").textContent).toBe("Forecast loaded.")
  })

  it("says the forecast is still unavailable when the retry brings the error again, and keeps focus", async () => {
    render(page(false))
    // The mocked refresh ends the read at once, as one that brings the error again does.
    const button = await pressTryAgain()

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The forecast is still unavailable."))
    expect(document.activeElement).toBe(button)
  })

  it("leaves focus where the owner moved it meanwhile", async () => {
    const { rerender } = render(page(false))
    await pressTryAgain()
    const elsewhere = screen.getByRole("link", { name: "Settings" })
    elsewhere.focus()

    rerender(page(true))

    expect(document.activeElement).toBe(elsewhere)
    expect(screen.getByRole("status").textContent).toBe("Forecast loaded.")
  })

  it("never moves focus when the page is shown again later", async () => {
    const { rerender } = render(page(false))
    await pressTryAgain()

    // Next hid the page, and shows it again once the forecast is back.
    rerender(page(false, "hidden"))
    ;(document.activeElement as HTMLElement | null)?.blur()
    rerender(page(true))

    expect(document.activeElement).toBe(document.body)
  })
})
