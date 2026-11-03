import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  CircleHelp,
  Sun,
  type LucideIcon,
} from "lucide-react"

import { OPEN_METEO_ATTRIBUTION, type WeatherSnapshot } from "@/lib/weather/open-meteo"

import {
  formatDegreeRange,
  formatDegrees,
  formatPrecipitation,
  formatRainChance,
  formatTimeIn,
  weatherKind,
  type WeatherKind,
} from "./format"

const ICONS: Record<WeatherKind, LucideIcon> = {
  clear: Sun,
  partly: CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  thunder: CloudLightning,
  unknown: CircleHelp,
}

/** The heading's id: the /today frame moves focus to it when Try again brings the forecast. */
export const WEATHER_HEADING_ID = "today-weather-heading"

export type WeatherCardProps = {
  weather: WeatherSnapshot
  city: string
}

/**
 * Today's forecast for the home city: the feels-like range first (what the
 * outfits dress for), then the air temperature, rain and gusts, and the
 * credit Open-Meteo's licence asks for (D-039). Server-rendered; every value
 * is text, the icon only repeats the label.
 */
export function WeatherCard({ weather, city }: WeatherCardProps) {
  const Icon = ICONS[weatherKind(weather.weatherCode)]
  return (
    <section
      aria-labelledby={WEATHER_HEADING_ID}
      className="flex flex-col gap-4 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden className="size-10 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-0.5">
          {/* Focusable from script only: it takes focus when Try again brings the forecast. */}
          <h2
            id={WEATHER_HEADING_ID}
            tabIndex={-1}
            className="font-heading text-base font-semibold outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Weather in {city}
          </h2>
          <p className="text-sm text-muted-foreground">
            {weather.label}
            {weather.currentC === null ? null : <>, {formatDegrees(weather.currentC)} now</>}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Feels like</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {formatDegreeRange(weather.apparentMinC, weather.apparentMaxC)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Air</dt>
          <dd className="text-lg font-semibold tabular-nums">{formatDegreeRange(weather.tminC, weather.tmaxC)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Rain</dt>
          <dd className="text-sm font-medium">
            {formatRainChance(weather.precipProbMax)}, {formatPrecipitation(weather.precipSumMm)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Wind gusts</dt>
          <dd className="text-sm font-medium">Up to {Math.round(weather.windGustMaxKmh)} km/h</dd>
        </div>
      </dl>

      <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        <span>Forecast from {formatTimeIn(weather.fetchedAt, weather.timezone)}.</span>
        <a
          href={OPEN_METEO_ATTRIBUTION.href}
          target="_blank"
          rel="noopener noreferrer"
          // A 44 px target, though it reads as a line of small print.
          className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-foreground"
        >
          {OPEN_METEO_ATTRIBUTION.text}
        </a>
      </p>
    </section>
  )
}
