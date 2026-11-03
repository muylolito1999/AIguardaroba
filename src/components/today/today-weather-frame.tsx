"use client"

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { focusWasLost } from "@/lib/focus"

import { WEATHER_HEADING_ID } from "./weather-card"

// /today's weather area: the forecast's error (WeatherUnavailable) or the view
// that replaces it once the forecast loads (TodayView). The page renders this
// frame in the same place in both cases, so it stays mounted when Try again
// brings the forecast and the error with its button goes. It keeps a status
// region that outlives that swap, and moves focus from the button that left
// to the weather heading (D-224), as the page does after Save (focusWasLost).

type WeatherRetry = {
  /** Try again was pressed. */
  started: () => void
  /** The retry's read finished and the forecast is still unavailable. */
  failed: () => void
}

const WeatherRetryContext = createContext<WeatherRetry | null>(null)

/** For WeatherUnavailable's Try again; null outside a frame (then nothing is announced). */
export function useWeatherRetry(): WeatherRetry | null {
  return useContext(WeatherRetryContext)
}

export type TodayWeatherFrameProps = {
  /** The forecast loaded: the children are the view, not the error. */
  ready: boolean
  children: ReactNode
}

export function TodayWeatherFrame({ ready, children }: TodayWeatherFrameProps) {
  const [announcement, setAnnouncement] = useState("")
  // A Try again pressed since the error was shown, until the forecast loads.
  const pressed = useRef(false)
  const wasReady = useRef(ready)

  // Before paint, so focus never rests on <body> in between.
  useLayoutEffect(() => {
    const before = wasReady.current
    wasReady.current = ready
    if (!ready || before || !pressed.current) return
    pressed.current = false
    setAnnouncement("Forecast loaded.")
    const heading = document.getElementById(WEATHER_HEADING_ID)
    if (heading !== null && focusWasLost(document.activeElement)) heading.focus()
  }, [ready])

  // Next hiding the page forgets the press, so showing it later never moves focus.
  useEffect(
    () => () => {
      pressed.current = false
    },
    []
  )

  const retry = useMemo<WeatherRetry>(
    () => ({
      started: () => {
        pressed.current = true
        setAnnouncement("Checking the weather again…")
      },
      failed: () => {
        if (pressed.current) setAnnouncement("The forecast is still unavailable.")
      },
    }),
    []
  )

  return (
    <WeatherRetryContext.Provider value={retry}>
      {children}
      {/* Always in the page, so screen readers announce the text when it changes. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </WeatherRetryContext.Provider>
  )
}
