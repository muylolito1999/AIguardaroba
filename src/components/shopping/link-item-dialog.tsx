"use client"

import { useEffect, useId, useState, type RefObject } from "react"
import { Loader2, Search } from "lucide-react"

import { ItemPhoto } from "@/components/items/item-photo"
import { CATEGORY_LABELS } from "@/components/items/tag-options"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import { err, type Result } from "@/lib/result"

import type { SearchLinkableItemsAction } from "./shopping-actions"
import { LINK_SEARCH_MAX, type LinkableItemDto } from "./shopping-model"

/** Wait after the last keystroke before searching, so typing a word sends one request. */
export const LINK_SEARCH_DEBOUNCE_MS = 250

type SearchState =
  | { status: "loading" }
  | { status: "ready"; query: string; items: LinkableItemDto[] }
  | { status: "error"; message: string }

export type LinkItemDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The shopping list entry being linked, for the title. */
  itemType: string
  searchLinkableItems: SearchLinkableItemsAction
  /** Saves the link; resolves true when it was saved (the dialog is then closed by the caller). */
  onChoose: (item: LinkableItemDto) => Promise<boolean>
  /** Where focus returns when the dialog closes. */
  finalFocus?: RefObject<HTMLElement | null>
}

/** "Link to an item I own": a search over the owned, non-archived items, each shown with its thumb. */
export function LinkItemDialog({
  open,
  onOpenChange,
  itemType,
  searchLinkableItems,
  onChoose,
  finalFocus,
}: LinkItemDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent finalFocus={finalFocus} className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_1fr] sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle>Link {itemType} to an item you own</DialogTitle>
          <DialogDescription>
            For when you already have it. The item itself is not changed.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts with an empty search. */}
        <LinkItemSearch searchLinkableItems={searchLinkableItems} onChoose={onChoose} />
      </DialogContent>
    </Dialog>
  )
}

type LinkItemSearchProps = Pick<LinkItemDialogProps, "searchLinkableItems" | "onChoose">

function LinkItemSearch({ searchLinkableItems, onChoose }: LinkItemSearchProps) {
  const inputId = useId()
  const resultsId = useId()
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState<SearchState>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  const [choosing, setChoosing] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // The first list (empty text) loads at once; typing waits for a pause.
    const delay = query === "" && attempt === 0 ? 0 : LINK_SEARCH_DEBOUNCE_MS
    const timer = setTimeout(() => {
      setSearch({ status: "loading" })
      const request = async (): Promise<Result<LinkableItemDto[]>> => {
        try {
          return await searchLinkableItems({ q: query.trim() })
        } catch {
          return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
        }
      }
      void request().then((result) => {
        // A newer search (or closing the dialog) replaced this one.
        if (cancelled) return
        setSearch(
          result.ok
            ? { status: "ready", query: query.trim(), items: result.data }
            : { status: "error", message: result.error.message }
        )
      })
    }, delay)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, attempt, searchLinkableItems])

  async function choose(item: LinkableItemDto) {
    setChoosing(item.id)
    const linked = await onChoose(item)
    // On success the dialog closes and this component unmounts.
    if (!linked) setChoosing(null)
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          Search your items
        </label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={inputId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={LINK_SEARCH_MAX}
            autoComplete="off"
            placeholder="Name or type, e.g. boots"
            aria-controls={resultsId}
            className="h-11 pl-9"
          />
        </div>
      </div>

      <div id={resultsId} className="min-h-0 overflow-y-auto" aria-busy={search.status === "loading" || undefined}>
        {search.status === "loading" ? (
          <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Searching…
          </p>
        ) : search.status === "error" ? (
          <div className="flex flex-col items-start gap-2 py-2" role="alert">
            <p className="text-sm text-destructive-strong">{search.message}</p>
            <Button type="button" variant="outline" size="touch" onClick={() => setAttempt((count) => count + 1)}>
              Try again
            </Button>
          </div>
        ) : search.items.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground" role="status">
            {search.query === "" ? "You have no items to link yet." : `No items match “${search.query}”.`}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Your items">
            {search.items.map((item) => (
              <li key={item.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-14 w-full justify-start gap-3 px-2 py-1.5 text-left whitespace-normal"
                  onClick={() => void choose(item)}
                  disabled={choosing !== null}
                  focusableWhenDisabled
                  aria-busy={choosing === item.id || undefined}
                >
                  {/* Decorative next to the name; hidden so "No photo" does not join the button's name. */}
                  <span aria-hidden className="shrink-0">
                    <ItemPhoto image={item.thumb} alt="" className="size-11" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{item.name}</span>
                    {item.category !== null ? (
                      <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[item.category]}</span>
                    ) : null}
                  </span>
                  {choosing === item.id ? <Loader2 aria-hidden className="animate-spin" /> : null}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
