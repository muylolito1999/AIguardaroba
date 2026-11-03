"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useTransition } from "react"
import { CloudOff, Loader2, RotateCcw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

import { useWeatherRetry } from "./today-weather-frame"

export type WeatherUnavailableProps = {
  city: string
  /** The server's message, such as "Weather is unavailable right now." */
  message: string
}

/**
 * Shown instead of the weather card and the suggestions when the forecast
 * cannot be read: no weather is made up, and no outfits are offered without
 * it. Try again reads the page again; a failed fetch is never cached, so it
 * asks Open-Meteo again. The frame around it announces the outcome and, when
 * the forecast loads and this alert goes, moves focus to the weather heading.
 */
export function WeatherUnavailable({ city, message }: WeatherUnavailableProps) {
  const router = useRouter()
  const retry = useWeatherRetry()
  const [pending, startTransition] = useTransition()
  // The read ends here only when the forecast is still missing: a working one replaces this alert.
  const wasPending = useRef(false)
  useEffect(() => {
    if (pending) {
      wasPending.current = true
    } else if (wasPending.current) {
      wasPending.current = false
      retry?.failed()
    }
  }, [pending, retry])
  return (
    <Alert variant="destructive">
      <CloudOff aria-hidden />
      <AlertTitle>No forecast for {city}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <p>Outfit suggestions need today&rsquo;s forecast, so they appear once it loads.</p>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="mt-2"
          disabled={pending}
          focusableWhenDisabled
          aria-busy={pending || undefined}
          onClick={() => {
            retry?.started()
            startTransition(() => router.refresh())
          }}
        >
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  )
}
