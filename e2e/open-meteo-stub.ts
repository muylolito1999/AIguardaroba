// A local stand-in for api.open-meteo.com, so the e2e run never reaches the
// network for /today's forecast. It answers GET /v1/forecast with the saved
// Hamburg response (src/lib/weather/fixtures/forecast-hamburg.json), moved to
// today in the requested time zone, because the app refuses a forecast for
// another day. It also answers GET /health (for Playwright's webServer check)
// and GET /__requests (the forecast queries it received, so a spec can tell
// that the server asked the stub and not the real API).
//
// Plain Node with type stripping, no imports from the app (no path aliases
// there): `node e2e/open-meteo-stub.ts` from the project root starts it on
// OPEN_METEO_STUB_PORT. playwright.config.ts runs it as a second webServer
// and gives the app OPEN_METEO_BASE_URL = OPEN_METEO_STUB_URL.

import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"

export const OPEN_METEO_STUB_PORT = 3901
export const OPEN_METEO_STUB_URL = `http://127.0.0.1:${OPEN_METEO_STUB_PORT}`

/** Relative to the project root, where Playwright starts its web servers. */
const FIXTURE_PATH = path.join("src", "lib", "weather", "fixtures", "forecast-hamburg.json")

export type StubForecastRequest = {
  latitude: string | null
  longitude: string | null
  timezone: string | null
  forecastDays: string | null
  /** ISO 8601. */
  receivedAt: string
}

type Forecast = {
  timezone: string
  current: { time: string }
  hourly: { time: string[] }
  daily: { time: string[] }
}

function isForecast(value: unknown): value is Forecast {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.timezone === "string" &&
    typeof record.current === "object" &&
    typeof record.hourly === "object" &&
    typeof record.daily === "object"
  )
}

function readFixture(root: string): Forecast {
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(root, FIXTURE_PATH), "utf8"))
  if (!isForecast(parsed)) throw new Error(`${FIXTURE_PATH} is not a forecast response`)
  return parsed
}

/** The wall-clock date and time of `now` in an IANA time zone. */
function wallClock(timeZone: string, now: Date): { day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00"
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: part("hour"), minute: part("minute") }
}

/** The fixture moved to today in `timeZone`: the zone, the daily date, the 24 hourly times and the current time. */
export function forecastFor(fixture: Forecast, timeZone: string, now: Date): Forecast {
  const { day, hour, minute } = wallClock(timeZone, now)
  const copy: Forecast = structuredClone(fixture)
  copy.timezone = timeZone
  copy.daily.time = [day, ...copy.daily.time.slice(1)]
  copy.hourly.time = copy.hourly.time.map((_, index) => `${day}T${String(index).padStart(2, "0")}:00`)
  // Open-Meteo reports the current time in 15-minute steps.
  const quarter = String(Math.floor(Number(minute) / 15) * 15).padStart(2, "0")
  copy.current.time = `${day}T${hour}:${quarter}`
  return copy
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  response.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  response.end(text)
}

export type OpenMeteoStub = {
  url: string
  /** The forecast queries received so far. */
  requests: StubForecastRequest[]
  close: () => Promise<void>
}

/** Starts the stub on 127.0.0.1. `root` is the project root the fixture path is resolved from. */
export function startOpenMeteoStub(
  options: { port?: number; root?: string } = {}
): Promise<OpenMeteoStub> {
  const port = options.port ?? OPEN_METEO_STUB_PORT
  const fixture = readFixture(options.root ?? process.cwd())
  const requests: StubForecastRequest[] = []

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
    if (request.method !== "GET") return send(response, 405, "Method not allowed")
    if (url.pathname === "/health") return send(response, 200, "ok")
    if (url.pathname === "/__requests") return send(response, 200, requests)
    if (url.pathname !== "/v1/forecast") return send(response, 404, { error: true, reason: "Not found" })

    const query: StubForecastRequest = {
      latitude: url.searchParams.get("latitude"),
      longitude: url.searchParams.get("longitude"),
      timezone: url.searchParams.get("timezone"),
      forecastDays: url.searchParams.get("forecast_days"),
      receivedAt: new Date().toISOString(),
    }
    requests.push(query)
    if (query.latitude === null || query.longitude === null || query.timezone === null) {
      return send(response, 400, { error: true, reason: "latitude, longitude and timezone are required" })
    }
    try {
      send(response, 200, forecastFor(fixture, query.timezone, new Date()))
    } catch {
      // An unknown time zone, as the real API answers it.
      send(response, 400, { error: true, reason: `Invalid timezone ${query.timezone}` })
    }
  }

  const server = createServer(handle)
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

// Run directly (not when a spec imports the constants above): serve until stopped.
if (process.argv[1]?.replaceAll("\\", "/").endsWith("e2e/open-meteo-stub.ts")) {
  startOpenMeteoStub().then(
    (stub) => {
      console.log(`Open-Meteo stub listening on ${stub.url}`)
      const stop = () => void stub.close().then(() => process.exit(0))
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    },
    (error: unknown) => {
      console.error("Open-Meteo stub could not start:", error)
      process.exit(1)
    }
  )
}
