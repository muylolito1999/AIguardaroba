"use client"

import { useId, useRef, useState, type KeyboardEvent, type Ref } from "react"
import { Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { COLOR_HEX, TAG_LIMITS } from "@/lib/items/contracts"

import type { ColorEntry } from "./tag-form-model"

// Chip lists for colours (name plus swatch) and materials. Every chip action is
// a real button or input, so the lists work with a keyboard and a screen
// reader; removing a chip puts focus back in the add field so the next edit can
// follow at once.

/** A neutral starting swatch for a new colour; the owner adjusts it with the picker. */
const NEW_COLOR_HEX = "#808080"

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value)
  else if (ref) ref.current = value
}

function stopEnterSubmit(event: KeyboardEvent<HTMLInputElement>, add: () => void): void {
  // Enter adds the chip instead of submitting the whole tag form.
  if (event.key === "Enter") {
    event.preventDefault()
    add()
  }
}

type ChipListProps<T> = {
  /** id of the visible label that names the list and the add field. */
  labelId: string
  value: T[]
  onChange: (next: T[]) => void
  onBlur?: () => void
  invalid?: boolean
  /** ids of hints and errors that describe the add field. */
  describedBy?: string
  /** react-hook-form's field ref, so a validation error can focus the add field. */
  inputRef?: Ref<HTMLInputElement>
  disabled?: boolean
}

function useAddField(inputRef: Ref<HTMLInputElement> | undefined) {
  const localRef = useRef<HTMLInputElement | null>(null)
  const setInput = (element: HTMLInputElement | null) => {
    localRef.current = element
    assignRef(inputRef, element)
  }
  const focusInput = () => localRef.current?.focus()
  return { setInput, focusInput }
}

/** Colour names with their swatches; at most TAG_LIMITS.colorsMax, dominant colour first. */
export function ColorChips({
  labelId,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  inputRef,
  disabled,
}: ChipListProps<ColorEntry>) {
  const [draftName, setDraftName] = useState("")
  const [draftHex, setDraftHex] = useState(NEW_COLOR_HEX)
  const [problem, setProblem] = useState<string | null>(null)
  const { setInput, focusInput } = useAddField(inputRef)
  const problemId = useId()
  const swatchId = useId()
  const full = value.length >= TAG_LIMITS.colorsMax

  function add() {
    const name = draftName.trim()
    if (name === "") return setProblem("Type a colour name first.")
    if (name.length > TAG_LIMITS.listEntryMax) {
      return setProblem(`Use at most ${TAG_LIMITS.listEntryMax} characters.`)
    }
    if (value.some((entry) => entry.name.trim().toLowerCase() === name.toLowerCase())) {
      return setProblem(`“${name}” is already listed.`)
    }
    if (full) return setProblem(`Use at most ${TAG_LIMITS.colorsMax} colours.`)
    onChange([...value, { name, hex: draftHex.toLowerCase() }])
    setDraftName("")
    setDraftHex(NEW_COLOR_HEX)
    setProblem(null)
  }

  function remove(index: number) {
    onChange(value.filter((_, position) => position !== index))
    setProblem(null)
    focusInput()
  }

  function recolor(index: number, hex: string) {
    onChange(value.map((entry, position) => (position === index ? { ...entry, hex: hex.toLowerCase() } : entry)))
  }

  const addDescribedBy = [describedBy, problem ? problemId : undefined].filter(Boolean).join(" ") || undefined

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul aria-labelledby={labelId} className="flex flex-wrap gap-2">
          {value.map((entry, index) => (
            <li
              key={`${entry.name}-${index}`}
              className="flex h-11 items-center gap-1 rounded-full border bg-background text-sm"
            >
              <input
                type="color"
                // An invalid stored hex still needs a value the picker accepts.
                value={COLOR_HEX.test(entry.hex) ? entry.hex : "#000000"}
                onChange={(event) => recolor(index, event.target.value)}
                onBlur={onBlur}
                disabled={disabled}
                aria-label={`Swatch for ${entry.name}`}
                className="size-11 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-1.5 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border [&::-webkit-color-swatch-wrapper]:p-0"
              />
              <span className="max-w-40 truncate">{entry.name}</span>
              {index === 0 ? <span className="text-xs text-muted-foreground">(main)</span> : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-touch"
                className="rounded-full"
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={`Remove ${entry.name}`}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No colours yet.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={setInput}
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value)
            if (problem) setProblem(null)
          }}
          onKeyDown={(event) => stopEnterSubmit(event, add)}
          onBlur={onBlur}
          placeholder={full ? "Remove a colour to add another" : "Add a colour, e.g. navy"}
          aria-label="New colour name"
          aria-describedby={addDescribedBy}
          aria-invalid={invalid || problem !== null || undefined}
          maxLength={TAG_LIMITS.listEntryMax + 10}
          disabled={disabled || full}
          className="h-11 min-w-0 flex-1 basis-40"
        />
        <label htmlFor={swatchId} className="sr-only">
          Swatch for the new colour
        </label>
        <input
          id={swatchId}
          type="color"
          value={draftHex}
          onChange={(event) => setDraftHex(event.target.value)}
          disabled={disabled || full}
          className="size-11 shrink-0 cursor-pointer rounded-lg border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button type="button" variant="outline" size="touch" onClick={add} disabled={disabled || full}>
          <Plus aria-hidden />
          Add colour
        </Button>
      </div>
      {problem ? (
        <p id={problemId} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  )
}

type TextChipsProps = ChipListProps<string> & {
  /** Most entries allowed. */
  max: number
  /** Singular noun for button and announcement text, e.g. "material". */
  noun: string
  placeholder: string
}

/** A list of short text entries, such as materials. */
export function TextChips({
  labelId,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  inputRef,
  disabled,
  max,
  noun,
  placeholder,
}: TextChipsProps) {
  const [draft, setDraft] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const { setInput, focusInput } = useAddField(inputRef)
  const problemId = useId()
  const full = value.length >= max

  function add() {
    const entry = draft.trim()
    if (entry === "") return setProblem(`Type a ${noun} first.`)
    if (entry.length > TAG_LIMITS.listEntryMax) {
      return setProblem(`Use at most ${TAG_LIMITS.listEntryMax} characters.`)
    }
    if (value.some((existing) => existing.toLowerCase() === entry.toLowerCase())) {
      return setProblem(`“${entry}” is already listed.`)
    }
    if (full) return setProblem(`Use at most ${max}.`)
    onChange([...value, entry])
    setDraft("")
    setProblem(null)
  }

  function remove(index: number) {
    onChange(value.filter((_, position) => position !== index))
    setProblem(null)
    focusInput()
  }

  const addDescribedBy = [describedBy, problem ? problemId : undefined].filter(Boolean).join(" ") || undefined

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul aria-labelledby={labelId} className="flex flex-wrap gap-2">
          {value.map((entry, index) => (
            <li
              key={`${entry}-${index}`}
              className="flex h-11 items-center gap-1 rounded-full border bg-background pl-3 text-sm"
            >
              <span className="max-w-48 truncate">{entry}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-touch"
                className="rounded-full"
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={`Remove ${entry}`}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={setInput}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (problem) setProblem(null)
          }}
          onKeyDown={(event) => stopEnterSubmit(event, add)}
          onBlur={onBlur}
          placeholder={full ? `Remove a ${noun} to add another` : placeholder}
          aria-label={`New ${noun}`}
          aria-describedby={addDescribedBy}
          aria-invalid={invalid || problem !== null || undefined}
          maxLength={TAG_LIMITS.listEntryMax + 10}
          disabled={disabled || full}
          className="h-11 min-w-0 flex-1 basis-40"
        />
        <Button type="button" variant="outline" size="touch" onClick={add} disabled={disabled || full}>
          <Plus aria-hidden />
          Add {noun}
        </Button>
      </div>
      {problem ? (
        <p id={problemId} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  )
}
