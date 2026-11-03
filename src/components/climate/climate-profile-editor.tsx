"use client"

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Loader2, Save, Star } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { focusWasLost } from "@/lib/focus"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ClimateProfileDto } from "@/lib/relocation/contracts"
import { err, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"

import type { ClimateActions } from "./climate-actions"
import {
  checkDraft,
  CLIMATE_FIELDS,
  CLIMATE_NOTES_MAX,
  draftChanged,
  profileToDraft,
  type CellDraft,
  type ClimateField,
  type ProfileDraft,
} from "./climate-model"
import { cellInputId, ClimateTable } from "./climate-table"

/** The seed's reference profile (D-057): `pnpm db:seed` restores its values and makes it the default. */
const SEEDED_REFERENCE_SLUG = "hamburg"

/** Runs an action; a rejected call (offline, an action unknown after a redeploy) becomes a network error. */
async function settle<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call()
  } catch {
    return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
  }
}

export type ClimateProfileEditorProps = {
  profile: ClimateProfileDto
  actions: ClimateActions
  /** The server saved the profile (values or the default flag). */
  onSaved: (profile: ClimateProfileDto) => void
}

/** One profile's card: what it is, the 12-month table, both notes, Save and Set as default. */
export function ClimateProfileEditor({ profile, actions, onSaved }: ClimateProfileEditorProps) {
  const id = useId()
  const headingId = `${id}-heading`
  const [draft, setDraft] = useState<ProfileDraft>(() => profileToDraft(profile))
  const [shownProfile, setShownProfile] = useState(profile)
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set())
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settingDefault, setSettingDefault] = useState(false)
  const defaultHintRef = useRef<HTMLParagraphElement>(null)
  // "Set as default" leaves once the profile is the default; the hint below it
  // then says what changed and keeps focus in this card (D-172). A layout
  // effect, so it runs once the button is gone, and only when focus was lost.
  const focusHintNext = useRef(false)
  useLayoutEffect(() => {
    if (!focusHintNext.current || !profile.isDefault) return
    focusHintNext.current = false
    if (focusWasLost(document.activeElement)) defaultHintRef.current?.focus()
  }, [profile])

  // Newer server data (a fresh read, or this card's own save) replaces an
  // unedited draft; edits in progress stay and are compared with the new values.
  if (profile !== shownProfile) {
    if (!draftChanged(draft, shownProfile)) setDraft(profileToDraft(profile))
    setShownProfile(profile)
  }

  const check = useMemo(() => checkDraft(draft), [draft])
  const changed = draftChanged(draft, profile)
  const busy = saving || settingDefault
  const isReference = profile.slug === SEEDED_REFERENCE_SLUG

  function changeCell(index: number, field: ClimateField, cell: CellDraft) {
    setDraft((current) => ({
      ...current,
      months: current.months.map((month, position) =>
        position === index ? { ...month, cells: { ...month.cells, [field]: cell } } : month
      ),
    }))
  }

  function leaveRow(month: number) {
    setTouched((current) => (current.has(month) ? current : new Set(current).add(month)))
  }

  async function save() {
    if (busy || !changed) return
    if (check.update === null) {
      setSubmitted(true)
      const firstInvalid = check.months.findIndex((month) => month.errors.length > 0)
      const month = draft.months[firstInvalid]
      const field = check.months[firstInvalid]?.invalidFields[0] ?? CLIMATE_FIELDS[0]
      if (month !== undefined) document.getElementById(cellInputId(id, month.month, field))?.focus()
      return
    }
    setSaving(true)
    const update = check.update
    const result = await settle(() => actions.updateClimateProfile({ id: profile.id, ...update }))
    setSaving(false)
    if (!result.ok) {
      toastError(result.error)
      return
    }
    const saved = result.data
    setDraft(profileToDraft(saved))
    setTouched(new Set())
    setSubmitted(false)
    onSaved(saved)
    const cleared = profile.isPlaceholder && !saved.isPlaceholder
    // The notes reach the relocation prompt as written; only the owner knows whether they still fit.
    const notesMentionPlaceholder = /placeholder/i.test(`${saved.windNotes} ${saved.notes}`)
    toast.add({
      title: `${saved.city} saved`,
      description: cleared
        ? `Every value is filled in, so it is no longer marked as placeholder data.${
            notesMentionPlaceholder ? " Its notes still mention placeholder data; edit them if they no longer fit." : ""
          }`
        : undefined,
      type: "success",
    })
  }

  async function makeDefault() {
    if (busy) return
    setSettingDefault(true)
    const result = await settle(() => actions.setDefaultClimateProfile({ id: profile.id }))
    setSettingDefault(false)
    if (!result.ok) {
      toastError(result.error)
      return
    }
    focusHintNext.current = true
    onSaved(result.data)
    toast.add({
      title: `${result.data.city} is the default`,
      description: "The relocation form now starts with it.",
      type: "success",
    })
  }

  const errorCount = check.months.filter((month) => month.errors.length > 0).length

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={headingId} className="font-heading text-lg font-semibold">
            {profile.city}
          </h2>
          {profile.isDefault ? <Badge>Default</Badge> : null}
          {profile.isPlaceholder ? <Badge variant="outline">Placeholder</Badge> : null}
          {!profile.isPlaceholder && !profile.complete ? <Badge variant="outline">Incomplete</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">{profile.country}</p>
        <p className="text-sm text-muted-foreground text-pretty">Source: {profile.source}</p>
        {profile.isPlaceholder ? (
          <p className="text-sm text-pretty">
            These values are not complete yet. Fill in every month and save; the placeholder mark then goes away.
          </p>
        ) : null}
        {isReference ? (
          <p className="text-sm text-pretty">
            Reference values for the relocation plan. Running pnpm db:seed restores these reference values.
          </p>
        ) : null}
      </div>

      <ClimateTable
        idPrefix={id}
        city={profile.city}
        months={draft.months}
        checks={check.months}
        showErrors={(month) => submitted || touched.has(month)}
        onCellChange={changeCell}
        onRowBlur={leaveRow}
        disabled={saving}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-wind`} className="text-sm font-medium">
            Wind notes
          </label>
          <Textarea
            id={`${id}-wind`}
            value={draft.windNotes}
            onChange={(event) => setDraft((current) => ({ ...current, windNotes: event.target.value }))}
            maxLength={CLIMATE_NOTES_MAX}
            disabled={saving}
            className="min-h-20"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-notes`} className="text-sm font-medium">
            Notes
          </label>
          <Textarea
            id={`${id}-notes`}
            value={draft.notes}
            onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
            maxLength={CLIMATE_NOTES_MAX}
            disabled={saving}
            className="min-h-20"
          />
        </div>
      </div>

      {submitted && errorCount > 0 ? (
        <p className="text-sm text-destructive-strong" role="alert">
          {errorCount === 1 ? "One month needs" : `${errorCount} months need`} fixing before this can be saved.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="touch"
          onClick={() => void save()}
          disabled={!changed || busy}
          focusableWhenDisabled
          aria-busy={saving || undefined}
        >
          {saving ? <Loader2 aria-hidden className="animate-spin" /> : <Save aria-hidden />}
          {saving ? "Saving…" : "Save"}
        </Button>
        {profile.isDefault ? null : (
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void makeDefault()}
            disabled={busy}
            focusableWhenDisabled
            aria-busy={settingDefault || undefined}
            aria-describedby={`${id}-default-hint`}
          >
            {settingDefault ? <Loader2 aria-hidden className="animate-spin" /> : <Star aria-hidden />}
            Set as default
          </Button>
        )}
      </div>
      <p
        id={`${id}-default-hint`}
        ref={defaultHintRef}
        tabIndex={-1}
        className="-mt-1 text-sm text-muted-foreground text-pretty outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {profile.isDefault
          ? "The relocation form starts with this profile."
          : "The default is the profile the relocation form starts with."}{" "}
        Running pnpm db:seed makes Hamburg the default again.
      </p>
    </section>
  )
}
