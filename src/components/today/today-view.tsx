"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { CircleAlert, Loader2, Sparkles } from "lucide-react"

import { formatUsdEstimate, modelLabel } from "@/components/add/cost-quote"
import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import type { WearActions } from "@/components/outfits/outfit-actions"
import { noteOutfitChange, useRefreshAfterOutfitChanges } from "@/components/outfits/outfit-changes"
import { useWearLogger } from "@/components/outfits/use-wear-logger"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { focusWasLost } from "@/lib/focus"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import { err, errorToast, type AppErrorPayload, type ErrorCode, type Result } from "@/lib/result"
import { useSavedOverlay, useServerCopy } from "@/lib/saved-since-read"
import { toastError } from "@/lib/toast-result"
import type { LogWearInput } from "@/lib/wear/contracts"

import { formatDegreeRange, formatTimeIn, plural } from "./format"
import { postSuggestOutfits } from "./suggest-api"
import { SuggestionCard } from "./suggestion-card"
import { useRefreshAfterHomeCityChange } from "./today-changes"
import type {
  SavedSuggestionDto,
  SaveSuggestedOutfitInput,
  SuggestedOutfitDto,
  TodaySuggestionDto,
  TodayViewData,
} from "./today-model"
import { WeatherCard } from "./weather-card"

export type SaveSuggestedOutfitAction = (input: SaveSuggestedOutfitInput) => Promise<Result<SavedSuggestionDto>>

export type TodayActions = WearActions & { saveSuggestedOutfit: SaveSuggestedOutfitAction }

export type SuggestOutfits = (options: { force?: boolean }) => Promise<Result<TodaySuggestionDto>>

export type TodayViewProps = {
  data: TodayViewData
  actions: TodayActions
  /** POST /api/outfits/suggest; tests pass a fake. */
  suggest?: SuggestOutfits
}

/** What the owner can do about a failed suggestion, after the server's own message. */
const SUGGEST_HINTS: Partial<Record<ErrorCode, string>> = {
  CONFIG: "Suggestions can run once the server's AI settings are fixed.",
  BUDGET_EXCEEDED: "Suggestions can run again when the monthly AI budget allows it.",
  CONFLICT: "Wait for it to finish, then reload this page to see the outfits.",
  UPSTREAM: "Try again in a few minutes.",
  UNAUTHENTICATED: "Sign in again, then come back to this page.",
}

/** The overlay key of one card: the suggestion and the outfit's place in it. */
function cardKey(analysisId: string, index: number): string {
  return `${analysisId}:${index}`
}

/** Whether a suggestion was chosen for the home city and the day the page shows. */
function isFor(suggestion: TodaySuggestionDto, data: Pick<TodayViewData, "place" | "today">): boolean {
  return suggestion.profileId === data.place.profileId && suggestion.date === data.today
}

/**
 * The newer of the server's suggestion and the one this tab asked for. An
 * asked one chosen for another home city or day (the city changed while it
 * ran, or a day passed) is not shown: its outfits do not apply here (D-206).
 */
function newest(
  data: Pick<TodayViewData, "place" | "today" | "suggestion">,
  asked: TodaySuggestionDto | undefined
): TodaySuggestionDto | null {
  const server = data.suggestion
  if (asked === undefined || !isFor(asked, data)) return server
  if (server === null) return asked
  return asked.createdAt >= server.createdAt ? asked : server
}

/** Turns a throw (offline, an action unknown after a redeploy) into the network error Result. */
async function settle<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call()
  } catch {
    return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
  }
}

type SuggestState =
  | { kind: "idle"; announced: string; for: TodaySuggestionDto | null }
  | { kind: "running" }
  | { kind: "failed"; error: AppErrorPayload }

function SuggestFailure({ error }: { error: AppErrorPayload }) {
  const hint = SUGGEST_HINTS[error.code]
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{errorToast(error).title}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {hint ? <p>{hint}</p> : null}
      </AlertDescription>
    </Alert>
  )
}

function quoteText(data: TodayViewData, again: boolean): string {
  const { quote, place } = data
  if (!quote.canSuggest) {
    return (
      `Three different outfits need more tagged items in ${place.city} or of unknown location: ` +
      "more tops, dresses, bottoms, shoes or outerwear to combine. Hats, scarves, gloves, socks, base layers and " +
      "accessories do not make another outfit. Tag or confirm more items first."
    )
  }
  const items = plural(quote.itemCount, "item", "items")
  const dropped =
    quote.droppedCount > 0 ? ` ${plural(quote.droppedCount, "item", "items")} that suit today least are left out.` : ""
  const action = again ? "Asks Claude for three new outfits" : "Claude picks three outfits"
  return (
    `${action} from your ${items} in ${place.city} or of unknown location, using ${modelLabel(quote.model)}. ` +
    `About ${formatUsdEstimate(quote.estimateUsd)} from your AI budget.${dropped}`
  )
}

/**
 * /today once the forecast is known: the weather card, then "Suggest
 * outfits" or today's three suggestions with Save and "Wore this today".
 *
 * A suggestion is a paid call, so it starts only from a click, never from an
 * effect: StrictMode's double effects and Next showing the kept page again
 * cannot start one. A ref ignores a second press while one runs, and the
 * server answers a stored suggestion for unchanged items without a call.
 * Leaving the page while it runs is safe: the request finishes, the server
 * stores the outfits, and the page shows them when it is shown again.
 *
 * Saves are shown over the server's copy until a copy read after them
 * arrives (D-180). The page reads itself again when shown after an item
 * change elsewhere in the tab (D-107), after an outfit change (a saved
 * outfit deleted on its page) and after a new home city.
 */
export function TodayView({ data, actions, suggest = postSuggestOutfits }: TodayViewProps) {
  const router = useRouter()
  const copy = useServerCopy(data)
  const [askedFor, setAsked] = useSavedOverlay<TodaySuggestionDto>(copy)
  const [savedIds, setSavedId] = useSavedOverlay<string>(copy)
  const [wornCards, setWorn] = useSavedOverlay<boolean>(copy)

  // Its own wear logs show through the overlay, so only a show after a change elsewhere reads again.
  useRefreshAfterItemChanges(data, copy.refresh, { refreshWhileShown: false })
  useRefreshAfterOutfitChanges(data, copy.refresh)
  useRefreshAfterHomeCityChange(data, copy.refresh)

  const suggestion = newest(data, askedFor.get("suggestion"))

  // Suggest outfits
  const [state, setState] = useState<SuggestState>({ kind: "idle", announced: "", for: null })
  const running = useRef(false)

  const runSuggest = async (force: boolean) => {
    if (running.current) return
    running.current = true
    setState({ kind: "running" })
    const result = await settle(() => suggest(force ? { force: true } : {}))
    running.current = false
    if (!result.ok) {
      setState({ kind: "failed", error: result.error })
      return
    }
    setAsked("suggestion", result.data)
    setState({ kind: "idle", announced: "Three outfits for today are ready.", for: result.data })
  }

  // Save
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set())
  const savingNow = useRef(new Set<string>())
  // The card whose Save just became "Open saved outfit".
  const focusOpenLink = useRef<string | null>(null)

  const save = async (current: TodaySuggestionDto, outfit: SuggestedOutfitDto) => {
    const key = cardKey(current.analysisId, outfit.index)
    if (savingNow.current.has(key)) return
    savingNow.current.add(key)
    setSaving(new Set(savingNow.current))
    const result = await settle(() =>
      actions.saveSuggestedOutfit({ analysisId: current.analysisId, index: outfit.index })
    )
    savingNow.current.delete(key)
    setSaving(new Set(savingNow.current))
    if (!result.ok) {
      toastError(result.error)
      // An item changed since: read the page again so the card shows which.
      if (result.error.code === "CONFLICT") copy.refresh()
      return
    }
    const { outfitId, alreadySaved } = result.data
    focusOpenLink.current = key
    setSavedId(key, outfitId)
    noteOutfitChange()
    toast.add({
      title: alreadySaved ? "Already saved" : "Outfit saved",
      description: `${outfit.title} is in your outfits.`,
      type: "success",
      actionProps: {
        children: "Open",
        className: "min-h-11 px-3",
        onClick: () => router.push(`/outfits/${outfitId}`),
      },
    })
  }

  // The Save button became a link to the outfit; focus follows it unless the owner moved on.
  useEffect(() => {
    const key = focusOpenLink.current
    if (key === null) return
    focusOpenLink.current = null
    const link = document.getElementById(`today-card-${key}-open`)
    if (link !== null && focusWasLost(document.activeElement)) link.focus()
  }, [savedIds])

  // Wore this today
  const [wearing, setWearing] = useState<string | null>(null)
  const wearingNow = useRef<string | null>(null)
  const { refresh } = copy
  const onCounts = useCallback(
    (_items: unknown, { shown }: { shown: boolean }) => {
      // Called once the server confirmed a log, or an Undo from the toast (wherever the owner is by then).
      const key = wearingNow.current
      if (key !== null) setWorn(key, true)
      // Hidden, the logger reads the page shown instead, and this one reads itself when shown again.
      if (shown) refresh()
    },
    [refresh, setWorn]
  )
  const { log } = useWearLogger({ logWear: actions.logWear, undoWear: actions.undoWear, onCounts })

  const wore = async (current: TodaySuggestionDto, outfit: SuggestedOutfitDto, savedOutfitId: string | null) => {
    const key = cardKey(current.analysisId, outfit.index)
    if (wearingNow.current !== null) return
    wearingNow.current = key
    setWearing(key)
    // A saved outfit is logged as that outfit, so its "Worn N times" counts it. One not saved yet is
    // still an outfit: asOutfit makes the server refuse running gear as it does for a saved one (D-250).
    const input: LogWearInput =
      savedOutfitId !== null
        ? { kind: "outfit", outfitId: savedOutfitId, weather: data.weather }
        : { kind: "items", itemIds: outfit.items.map((item) => item.itemId), weather: data.weather, asOutfit: true }
    const result = await log(input, { label: outfit.title })
    wearingNow.current = null
    setWearing(null)
    // Nothing new to log (already logged today): onCounts was not called.
    if (result !== null && result.logIds.length === 0) setWorn(key, true)
  }

  const again = suggestion !== null
  const isRunning = state.kind === "running"
  const status = isRunning
    ? "Choosing three outfits for today. This can take up to two minutes."
    : state.kind === "idle" && (state.for === null || isFor(state.for, data))
      ? state.announced
      : ""

  return (
    <div className="flex flex-col gap-6">
      <WeatherCard weather={data.weather} city={data.place.city} />

      <section aria-labelledby="today-outfits-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="today-outfits-heading" className="font-heading text-base font-semibold">
            Outfits for today
          </h2>
          {suggestion === null ? null : (
            <p className="text-sm text-muted-foreground">
              Chosen at {formatTimeIn(suggestion.createdAt, suggestion.weather.timezone)} from{" "}
              {plural(suggestion.itemCount, "item", "items")}, for a day that feels like{" "}
              {formatDegreeRange(suggestion.weather.apparentMinC, suggestion.weather.apparentMaxC)}.
            </p>
          )}
        </div>

        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            size="touch"
            variant={again ? "outline" : "default"}
            disabled={!data.quote.canSuggest || isRunning}
            focusableWhenDisabled
            aria-busy={isRunning || undefined}
            aria-describedby="today-suggest-cost"
            onClick={() => void runSuggest(again)}
          >
            {isRunning ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
            {again ? "Suggest again" : "Suggest outfits"}
          </Button>
          <p id="today-suggest-cost" className="text-sm text-pretty text-muted-foreground">
            {quoteText(data, again)}
          </p>
          {/* Always in the page, so screen readers announce the text when it changes. */}
          <p role="status" className="text-sm">
            {status}
          </p>
        </div>

        {state.kind === "failed" ? <SuggestFailure error={state.error} /> : null}

        {suggestion === null ? null : (
          // Room below the last cards, so they scroll clear of the toasts: the Undo of a wear stays for
          // 10 minutes in the bottom corner, where the last card's Save and "Wore this today" end up.
          <ul aria-label="Suggested outfits" className="grid gap-4 pb-32 lg:grid-cols-3 print:pb-0">
            {suggestion.outfits.map((outfit) => {
              const key = cardKey(suggestion.analysisId, outfit.index)
              const savedOutfitId = savedIds.get(key) ?? outfit.savedOutfitId
              return (
                <li key={key} className="min-w-0">
                  <SuggestionCard
                    outfit={outfit}
                    cardId={`today-card-${key}`}
                    savedOutfitId={savedOutfitId}
                    wornToday={wornCards.get(key) ?? outfit.wornToday}
                    saving={saving.has(key)}
                    wearing={wearing === key}
                    onSave={() => void save(suggestion, outfit)}
                    onWore={() => void wore(suggestion, outfit, savedOutfitId)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
