"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useId, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react"
import { CircleAlert, History, Loader2, Play, Plus, RotateCcw, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { monthsInRange } from "@/lib/climate/range"
import {
  MAX_CONSTRAINTS_CHARS,
  RelocationParamsSchema,
  type ClimateProfileDto,
  type RelocationEstimateDto,
  type RelocationParamsInput,
} from "@/lib/relocation/contracts"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import { settle, type RelocationFormActions } from "./actions"
import {
  describeExcluded,
  formatDay,
  formatMonths,
  formatUsd,
  formatUsdEstimate,
  modelLabel,
  plural,
} from "./format"
import { noteRelocationRunChange } from "./run-changes"
import { useRelocationEstimate, type EstimateState } from "./use-relocation-estimate"

/** Example constraints from the spec; each chip appends its sentence. */
export const CONSTRAINT_EXAMPLES = [
  { label: "Bike commute", text: "I commute by bike every day." },
  { label: "Business-casual office", text: "My office dress code is business casual." },
  {
    label: "2 × 23 kg suitcases, 2 boxes later",
    text: "I can take 2 suitcases of 23 kg and ship 2 boxes later.",
  },
] as const

export const EXAMPLE_BUDGET_EUR = 600

export type RelocationFormProps = {
  /** Default profile first (listClimateProfiles). */
  profiles: ClimateProfileDto[]
  /** Today and a year later minus a day, computed once on the server (defaultRelocationDates). */
  defaultDates: { dateFrom: string; dateTo: string }
  actions: RelocationFormActions
}

type BudgetInput = { ok: true; value: number | null } | { ok: false; message: string }

function parseBudget(text: string): BudgetInput {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: "Enter whole euros, or leave it empty for no budget." }
  return { ok: true, value: Number(trimmed) }
}

type FieldName = "climateProfileId" | "dateFrom" | "dateTo" | "constraints" | "purchaseBudgetEur"

/** The first message per field from a failed parse of the params. */
function fieldErrors(input: RelocationParamsInput): Partial<Record<FieldName, string>> {
  const parsed = RelocationParamsSchema.safeParse(input)
  if (parsed.success) return {}
  const errors: Partial<Record<FieldName, string>> = {}
  for (const issue of parsed.error.issues) {
    const field = issue.path[0]
    if (
      (field === "climateProfileId" ||
        field === "dateFrom" ||
        field === "dateTo" ||
        field === "constraints" ||
        field === "purchaseBudgetEur") &&
      errors[field] === undefined
    ) {
      errors[field] = issue.message
    }
  }
  return errors
}

/** Joins an example to the constraints on a new line. */
function appendConstraint(current: string, text: string): string {
  const trimmed = current.trimEnd()
  return trimmed === "" ? text : `${trimmed}\n${text}`
}

/** The months a valid range covers, for the hint under the dates. */
function coveredMonths(dateFrom: string, dateTo: string): number[] | null {
  try {
    return monthsInRange(dateFrom, dateTo)
  } catch {
    return null
  }
}

/**
 * Why Run cannot be pressed now, or null. Budget and empty-wardrobe checks use
 * only an estimate for the current inputs; the server checks both again.
 */
function runBlockedReason(options: {
  hasProfiles: boolean
  valid: boolean
  needsPlaceholderConsent: boolean
  estimate: EstimateState
}): string | null {
  if (!options.hasProfiles) return "There is no climate profile to plan for."
  if (!options.valid) return "Fix the fields marked above first."
  if (options.needsPlaceholderConsent) {
    return "This profile has placeholder climate data. Tick “Use the placeholder data anyway” to run on it."
  }
  const { estimate, fresh } = options.estimate
  if (!fresh || estimate === null) return null
  if (estimate.itemCount === 0) {
    const { pending, archived, unconfirmed, running } = estimate.excluded
    // Only running gear stood in the way: confirming or including tagged items cannot help (D-249).
    if (running > 0 && pending + archived + unconfirmed === 0) {
      return "Only running gear is in the wardrobe, which the analysis leaves out. Add or confirm some clothes first."
    }
    return "There are no items to analyse. Confirm some items first, or include tagged items."
  }
  if (estimate.tooLarge) {
    // The server refuses it too (D-175): the synthesis could not write the packing list in one part.
    return `Too many items to plan in one pass at ${estimate.effort} effort: the packing list would not fit in one part. Analyse fewer items, for example confirmed ones only, or set a lower analysis effort.`
  }
  if (estimate.budget.blocked) {
    return `Not enough AI budget left this month: about ${formatUsdEstimate(estimate.usd)} needed, ${formatUsd(
      estimate.budget.remainingUsd
    )} left of ${formatUsd(estimate.budget.budgetUsd)}.`
  }
  return null
}

/**
 * The relocation form: climate profile, dates, constraints, purchase budget
 * and the confirmed-only switch, with a live cost estimate. Run starts the
 * analysis (or opens an identical earlier one, D-028) and goes to its page.
 */
export function RelocationForm({ profiles, defaultDates, actions }: RelocationFormProps) {
  const router = useRouter()
  const baseId = useId()
  const id = (name: string) => `${baseId}-${name}`

  const defaultProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null
  const defaultProfileId = defaultProfile?.id ?? ""
  const [profileId, setProfileId] = useState(defaultProfileId)
  // Next keeps this form in a hidden <Activity> with its state; when the
  // default changes in Settings meanwhile, a form whose profile the owner has
  // not chosen follows it, as the Settings page promises (D-158).
  const [shownDefaultId, setShownDefaultId] = useState(defaultProfileId)
  const [profileChosen, setProfileChosen] = useState(false)
  const [dateFrom, setDateFrom] = useState(defaultDates.dateFrom)
  const [dateTo, setDateTo] = useState(defaultDates.dateTo)
  const [constraints, setConstraints] = useState("")
  const [budgetText, setBudgetText] = useState("")
  const [confirmedOnly, setConfirmedOnly] = useState(true)
  const [acceptPlaceholder, setAcceptPlaceholder] = useState(false)
  const [startingForce, setStartingForce] = useState(false)
  const [starting, startTransition] = useTransition()

  if (defaultProfileId !== shownDefaultId) {
    setShownDefaultId(defaultProfileId)
    if (!profileChosen) {
      setProfileId(defaultProfileId)
      // Consent belongs to one profile's placeholder data.
      setAcceptPlaceholder(false)
    }
  }
  // Set at the press, before React re-renders: a second press cannot slip in.
  const submitting = useRef(false)

  // Next keeps this page in a hidden <Activity> after Run navigates away; the
  // transition ends with the navigation, and this lets the next press through.
  useLayoutEffect(
    () => () => {
      submitting.current = false
    },
    []
  )

  const profile = profiles.find((candidate) => candidate.id === profileId) ?? null
  const placeholder = profile?.isPlaceholder ?? false
  const budget = parseBudget(budgetText)
  const budgetValue = budget.ok ? budget.value : null

  // One object per distinct set of inputs: the estimate hook's request key.
  const input = useMemo<RelocationParamsInput>(() => {
    const parsedBudget = parseBudget(budgetText)
    return {
      climateProfileId: profileId,
      dateFrom,
      dateTo,
      constraints,
      purchaseBudgetEur: parsedBudget.ok ? parsedBudget.value : null,
      includeOnlyConfirmed: confirmedOnly,
      acceptPlaceholder: placeholder && acceptPlaceholder,
    }
  }, [profileId, dateFrom, dateTo, constraints, budgetText, confirmedOnly, placeholder, acceptPlaceholder])
  const errors = useMemo(() => fieldErrors(input), [input])
  const budgetError = budget.ok ? errors.purchaseBudgetEur : budget.message
  const valid = budget.ok && Object.keys(errors).length === 0
  const params = valid ? input : null
  // The raw budget text is part of the key, so an invalid budget never reads as the empty one.
  const key = useMemo(() => JSON.stringify([input, budgetText]), [input, budgetText])
  const estimate = useRelocationEstimate(params, key, actions.estimateRelocation)

  const months = errors.dateFrom || errors.dateTo ? null : coveredMonths(dateFrom, dateTo)
  const needsPlaceholderConsent = placeholder && !acceptPlaceholder
  const blockedReason = runBlockedReason({ hasProfiles: profiles.length > 0, valid, needsPlaceholderConsent, estimate })
  const cached = estimate.fresh ? (estimate.estimate?.cached ?? null) : null

  function start(force: boolean) {
    if (submitting.current || params === null || blockedReason !== null) return
    submitting.current = true
    setStartingForce(force)
    const startParams = params
    startTransition(async () => {
      const result = await settle(() => actions.startRelocation({ params: startParams, force }))
      if (!result.ok) {
        submitting.current = false
        toastError(result.error)
        return
      }
      if (result.data.kind === "started") noteRelocationRunChange()
      const analysisId = result.data.analysisId
      // Its own transition after the await, so the button stays busy until the page changes.
      startTransition(() => router.push(`/relocate/${analysisId}`))
    })
  }

  function changeProfile(nextId: string) {
    setProfileId(nextId)
    setProfileChosen(true)
    // Consent is for one profile's placeholder data, not for the next one chosen.
    setAcceptPlaceholder(false)
  }

  const constraintsTooLong = (text: string) => appendConstraint(constraints, text).length > MAX_CONSTRAINTS_CHARS
  const blockedId = id("blocked")

  return (
    <section aria-labelledby={id("heading")} className="flex max-w-2xl flex-col gap-6">
      <h2 id={id("heading")} className="sr-only">
        New analysis
      </h2>

      <Field data-invalid={errors.climateProfileId ? true : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <FieldLabel htmlFor={id("profile")}>Climate profile</FieldLabel>
          {placeholder ? <Badge variant="outline">Placeholder data</Badge> : null}
        </div>
        <NativeSelect
          id={id("profile")}
          value={profileId}
          onChange={(event) => changeProfile(event.target.value)}
          disabled={profiles.length === 0}
          aria-invalid={errors.climateProfileId ? true : undefined}
          className="w-full [&_select]:h-11"
        >
          {profiles.length === 0 ? <NativeSelectOption value="">No climate profiles</NativeSelectOption> : null}
          {profiles.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.city}, {option.country}
              {option.isPlaceholder ? " (placeholder data)" : ""}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {errors.climateProfileId ? <FieldError>{errors.climateProfileId}</FieldError> : null}
      </Field>

      {placeholder && profile !== null ? (
        <Alert>
          <TriangleAlert aria-hidden />
          <AlertTitle>{profile.city} has placeholder climate data</AlertTitle>
          <AlertDescription>
            <p>
              Some values are estimated or missing, so the advice will be less reliable. Fill in the real
              values under{" "}
              <Link href="/settings/climate" className="font-medium text-foreground underline underline-offset-4">
                Settings, Climate profiles
              </Link>{" "}
              to fix this.
            </p>
            <label htmlFor={id("accept")} className="mt-2 flex min-h-11 items-center gap-3 text-foreground">
              <Checkbox
                id={id("accept")}
                checked={acceptPlaceholder}
                onCheckedChange={(checked) => setAcceptPlaceholder(checked)}
                aria-required="true"
              />
              <span className="text-sm font-medium">Use the placeholder data anyway</span>
            </label>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={errors.dateFrom ? true : undefined}>
          <FieldLabel htmlFor={id("from")}>Arrival</FieldLabel>
          <Input
            id={id("from")}
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            aria-invalid={errors.dateFrom ? true : undefined}
            className="h-11"
            required
          />
          {errors.dateFrom ? <FieldError>{errors.dateFrom}</FieldError> : null}
        </Field>
        <Field data-invalid={errors.dateTo ? true : undefined}>
          <FieldLabel htmlFor={id("to")}>Until</FieldLabel>
          <Input
            id={id("to")}
            type="date"
            value={dateTo}
            min={dateFrom}
            onChange={(event) => setDateTo(event.target.value)}
            aria-invalid={errors.dateTo ? true : undefined}
            aria-describedby={months === null ? undefined : id("months")}
            className="h-11"
            required
          />
          {errors.dateTo ? <FieldError>{errors.dateTo}</FieldError> : null}
        </Field>
        {months !== null ? (
          <p id={id("months")} className="text-sm text-muted-foreground sm:col-span-2">
            Covers {formatMonths(months)}
            {months.length >= 12 ? "" : ` (${plural(months.length, "month", "months")})`}.
          </p>
        ) : null}
      </div>

      <Field data-invalid={errors.constraints ? true : undefined}>
        <FieldLabel htmlFor={id("constraints")}>Your constraints</FieldLabel>
        <Textarea
          id={id("constraints")}
          value={constraints}
          onChange={(event) => setConstraints(event.target.value)}
          maxLength={MAX_CONSTRAINTS_CHARS}
          rows={4}
          placeholder="Commute, dress code, luggage, anything Claude should respect."
          aria-describedby={id("constraints-count")}
          aria-invalid={errors.constraints ? true : undefined}
        />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Example constraints">
            {CONSTRAINT_EXAMPLES.map((example) => (
              <Button
                key={example.label}
                type="button"
                variant="outline"
                size="touch"
                className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                disabled={constraints.includes(example.text) || constraintsTooLong(example.text)}
                // A chip disables itself when pressed: natively disabled, it
                // would drop keyboard focus to <body> (D-182).
                focusableWhenDisabled
                onClick={() => setConstraints((current) => appendConstraint(current, example.text))}
              >
                <Plus aria-hidden />
                {`${example.label} `}
                <span className="sr-only">(adds “{example.text}”)</span>
              </Button>
            ))}
          </div>
          <p id={id("constraints-count")} className="text-xs text-muted-foreground tabular-nums">
            {constraints.length.toLocaleString("en-US")} / {MAX_CONSTRAINTS_CHARS.toLocaleString("en-US")}
          </p>
        </div>
        {errors.constraints ? <FieldError>{errors.constraints}</FieldError> : null}
      </Field>

      <Field data-invalid={budgetError ? true : undefined}>
        <FieldLabel htmlFor={id("budget")}>Purchase budget (EUR)</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {/* Text, not a number field: a browser reports text a number field
              cannot read ("600€") as empty, which would silently mean no
              budget. parseBudget sees what was typed and says what is wrong. */}
          <Input
            id={id("budget")}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={budgetText}
            onChange={(event) => setBudgetText(event.target.value)}
            placeholder="No budget"
            aria-describedby={id("budget-hint")}
            aria-invalid={budgetError ? true : undefined}
            className="h-11 w-40"
          />
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => setBudgetText(String(EXAMPLE_BUDGET_EUR))}
            disabled={budgetValue === EXAMPLE_BUDGET_EUR}
            // Disabled by its own press; focus stays on it (D-182).
            focusableWhenDisabled
            aria-label={`Set the budget to €${EXAMPLE_BUDGET_EUR}`}
          >
            €{EXAMPLE_BUDGET_EUR}
          </Button>
        </div>
        {/* A plan's budget is what is left to spend from the day it is made:
            the shopping advice subtracts only purchases made under this plan
            (D-219), so a new plan must not repeat money already spent. */}
        <FieldDescription id={id("budget-hint")}>
          What you can still spend on new clothes from now on. Earlier purchases are not subtracted, so enter only what is
          left. Leave it empty for no budget.
        </FieldDescription>
        {budgetError ? <FieldError>{budgetError}</FieldError> : null}
      </Field>

      <Field orientation="horizontal" className="min-h-11 items-center justify-between gap-4">
        <FieldContent>
          <FieldLabel htmlFor={id("confirmed")}>Confirmed items only</FieldLabel>
          <FieldDescription id={id("confirmed-hint")}>
            Off: items with tags you have not confirmed are included and flagged.
          </FieldDescription>
        </FieldContent>
        <Switch
          id={id("confirmed")}
          checked={confirmedOnly}
          onCheckedChange={(checked) => setConfirmedOnly(checked)}
          aria-describedby={id("confirmed-hint")}
          className="after:-inset-y-3.5"
        />
      </Field>

      <EstimatePanel estimate={estimate} valid={valid} />

      {cached !== null ? (
        <section
          aria-labelledby={id("cached")}
          className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
        >
          <div className="flex items-start gap-2">
            <History aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-1">
              <h3 id={id("cached")} className="font-medium">
                Unchanged since {formatDay(cached.completedAt)}
              </h3>
              <p className="text-sm text-muted-foreground">
                The wardrobe, climate and settings match that run, so its result costs nothing to open.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/relocate/${cached.analysisId}`} className={buttonVariants({ size: "touch" })}>
              View result
            </Link>
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => start(true)}
              disabled={starting || blockedReason !== null}
              focusableWhenDisabled
              aria-describedby={blockedReason === null ? undefined : blockedId}
              aria-busy={(starting && startingForce) || undefined}
            >
              {starting && startingForce ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
              {starting && startingForce ? "Starting…" : "Re-run anyway"}
            </Button>
          </div>
        </section>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="touch"
            className="self-start"
            onClick={() => start(false)}
            disabled={starting || blockedReason !== null}
            focusableWhenDisabled
            aria-describedby={blockedReason === null ? undefined : blockedId}
            aria-busy={starting || undefined}
          >
            {starting ? <Loader2 aria-hidden className="animate-spin" /> : <Play aria-hidden />}
            {starting ? "Starting…" : "Run analysis"}
          </Button>
        </div>
      )}
      {blockedReason !== null ? (
        <p id={blockedId} className="flex items-start gap-2 text-sm text-muted-foreground">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {blockedReason}
        </p>
      ) : null}
    </section>
  )
}

function EstimateLines({ estimate }: { estimate: RelocationEstimateDto }) {
  const excluded = describeExcluded(estimate.excluded)
  const excludedTotal =
    estimate.excluded.pending + estimate.excluded.archived + estimate.excluded.unconfirmed + estimate.excluded.running
  return (
    <>
      <p className="font-medium">
        ≈ {formatUsdEstimate(estimate.usd)} with {modelLabel(estimate.model)} ·{" "}
        {plural(estimate.chunkCount + 1, "part", "parts")} · {plural(estimate.itemCount, "item", "items")}
      </p>
      <p className="text-sm text-muted-foreground">
        Likely between {formatUsdEstimate(estimate.lowUsd)} and {formatUsdEstimate(estimate.highUsd)} at{" "}
        {estimate.effort} effort. AI budget left this month: {formatUsd(estimate.budget.remainingUsd)} of{" "}
        {formatUsd(estimate.budget.budgetUsd)}.
      </p>
      {excluded !== null ? (
        <p className="text-sm text-muted-foreground">
          {excluded} {excludedTotal === 1 ? "is" : "are"} left out.
        </p>
      ) : null}
    </>
  )
}

/** The estimate for the current inputs; an older one stays dimmed while a new one loads. */
function EstimatePanel({ estimate, valid }: { estimate: EstimateState; valid: boolean }) {
  const stale = !estimate.fresh
  return (
    <section aria-label="Cost estimate" className="flex flex-col gap-1 rounded-xl bg-muted/50 p-4">
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        {!valid ? (
          <p className="text-sm text-muted-foreground">The estimate appears once the form is complete.</p>
        ) : estimate.error !== null ? (
          <p className="flex items-start gap-2 text-sm">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            No estimate: {estimate.error.message}
          </p>
        ) : estimate.estimate === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Estimating…
          </p>
        ) : (
          // An older estimate greys its main line rather than fading the panel:
          // muted text at 60 % opacity fell below AA contrast in the axe scan.
          <div className={cn("flex flex-col gap-1", stale && "text-muted-foreground")}>
            <EstimateLines estimate={estimate.estimate} />
          </div>
        )}
      </div>
      {valid && stale && estimate.estimate !== null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
          <Loader2 className="size-3 animate-spin" />
          Updating…
        </p>
      ) : null}
    </section>
  )
}
