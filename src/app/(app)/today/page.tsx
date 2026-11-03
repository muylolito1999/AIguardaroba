import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { Suspense } from "react"

import { PageHeader } from "@/components/layout/page-header"
import { formatDayHeading } from "@/components/today/format"
import { RefreshTodayWhenShown } from "@/components/today/today-changes"
import { NoHomeCity, TodaySkeleton } from "@/components/today/today-states"
import { TodayView } from "@/components/today/today-view"
import { TodayWeatherFrame } from "@/components/today/today-weather-frame"
import { WeatherUnavailable } from "@/components/today/weather-unavailable"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { isAppError } from "@/lib/result"
import { calendarDayIn } from "@/lib/wear/contracts"
import { saveSuggestedOutfit } from "@/server/actions/outfit-suggestions"
import { logWear, undoWear } from "@/server/actions/wear"
import { getTodaySuggestion, quoteOutfitSuggestion } from "@/server/services/outfit-suggestions"
import { getAppSettings } from "@/server/services/settings"
import { loadTodayWeather, type TodayWeather } from "@/server/weather"

export const metadata: Metadata = {
  title: "Today",
}

const ACTIONS = { saveSuggestedOutfit, logWear, undoWear }

// Static shell plus one Suspense child that reads the session, the home city,
// the cached forecast and today's suggestion at request time (D-041). The
// heading names the day and the city, so it comes with the data; the
// skeleton shows the plain title meanwhile.
export default function TodayPage() {
  return (
    <Suspense fallback={<TodaySkeleton />}>
      <TodayContent />
    </Suspense>
  )
}

function heading(day: string, city: string, country: string) {
  return <PageHeader title="Today" description={`${formatDayHeading(day)} in ${city}, ${country}`} />
}

async function TodayContent() {
  await verifySession()
  const db = getDb()
  // One clock for the whole render, so the forecast and the suggestion agree on the day.
  const now = new Date()
  const settings = await getAppSettings(db)
  const home = settings.homeProfile
  if (home === null) {
    return (
      <>
        <PageHeader title="Today" description="The weather and three outfits for your home city." />
        <NoHomeCity />
        <RefreshTodayWhenShown snapshot={settings} />
      </>
    )
  }

  let today: TodayWeather
  try {
    today = await loadTodayWeather(db, { now })
  } catch (error) {
    unstable_rethrow(error)
    if (!isAppError(error) || error.code !== "UPSTREAM") throw error
    // No made-up weather and no suggestions without it: the error and Try again.
    // The frame sits where the view's does, so it outlives a retry that brings the forecast.
    return (
      <>
        {heading(calendarDayIn(home.timezone, now), home.city, home.country)}
        <TodayWeatherFrame ready={false}>
          <WeatherUnavailable city={home.city} message={error.message} />
        </TodayWeatherFrame>
        <RefreshTodayWhenShown snapshot={settings} />
      </>
    )
  }

  const [quote, suggestion] = await Promise.all([
    quoteOutfitSuggestion(db, today),
    getTodaySuggestion(db, { now }),
  ])
  return (
    <>
      {heading(today.today, home.city, home.country)}
      <TodayWeatherFrame ready>
        <TodayView
          data={{
            place: { profileId: today.profile.id, city: today.profile.city, country: today.profile.country },
            today: today.today,
            weather: today.weather,
            quote,
            suggestion,
          }}
          actions={ACTIONS}
        />
      </TodayWeatherFrame>
    </>
  )
}
