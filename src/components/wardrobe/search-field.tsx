"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ITEM_FILTER_LIMITS, normalizeSearchText } from "@/lib/items/filters"

/** Typing pause before the search goes to the URL. */
export const SEARCH_DEBOUNCE_MS = 300

type SearchFieldProps = {
  /** The search in the URL (or the one just requested). */
  value: string
  /** Called with the normalised text once typing pauses, or at once on clear. Must be stable. */
  onSearch: (q: string) => void
}

/**
 * The wardrobe search box. The typed text is local so typing never waits for
 * the server; it is sent to the URL after a 300 ms pause. When the URL's
 * search changes from outside (a reset, a revisit), the box follows it; when
 * the change is the echo of what was typed (perhaps without trailing spaces),
 * the box keeps the text as typed.
 */
export function SearchField({ value, onSearch }: SearchFieldProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(value)
  const [syncedValue, setSyncedValue] = useState(value)

  // React's "adjust state when a prop changes", during render.
  if (value !== syncedValue) {
    setSyncedValue(value)
    if (normalizeSearchText(text) !== value) setText(value)
  }

  // A pending search is dropped when the text changes again, when the URL
  // catches up, and when the page is hidden (Activity runs the cleanup), so
  // nothing fires from a page that is not on screen.
  useEffect(() => {
    const next = normalizeSearchText(text)
    if (next === value) return
    const timer = window.setTimeout(() => onSearch(next), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text, value, onSearch])

  function clear() {
    setText("")
    onSearch("")
  }

  return (
    <div role="search" className="relative min-w-0 flex-1">
      <label htmlFor={inputId} className="sr-only">
        Search your wardrobe
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        id={inputId}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={ITEM_FILTER_LIMITS.qMax}
        placeholder="Search name, colour, brand…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && text !== "") {
            // Handled here so Escape does not also close something around the toolbar.
            event.preventDefault()
            clear()
          } else if (event.key === "Enter") {
            // Search now instead of waiting for the pause.
            const next = normalizeSearchText(text)
            if (next !== value) onSearch(next)
          }
        }}
        // The browser's own clear button is hidden; the one below is labelled
        // and the same size on every platform.
        className="h-11 pr-11 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {text !== "" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Clear search"
          onClick={() => {
            clear()
            // The button leaves with the text; focus goes back to the box instead of the page.
            inputRef.current?.focus()
          }}
          className="absolute top-0 right-0"
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
