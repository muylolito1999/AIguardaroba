// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ItemCollection } from "@/lib/db/enums"

import { CollectionSwitch } from "./collection-switch"
import type { FiltersChange } from "./use-wardrobe-filters"

afterEach(cleanup)

function renderSwitch(value: ItemCollection) {
  const onChange = vi.fn<(change: FiltersChange) => void>()
  render(<CollectionSwitch value={value} onChange={onChange} />)
  const group = screen.getByRole("group", { name: "Show" })
  return {
    onChange,
    clothes: within(group).getByRole("button", { name: "Clothes" }),
    running: within(group).getByRole("button", { name: "Running" }),
  }
}

describe("CollectionSwitch", () => {
  it("is a named group of two options with the current view pressed", () => {
    const { clothes, running } = renderSwitch("clothing")
    expect(within(screen.getByRole("group", { name: "Show" })).getAllByRole("button")).toHaveLength(2)
    expect(clothes.getAttribute("aria-pressed")).toBe("true")
    expect(running.getAttribute("aria-pressed")).toBe("false")
    cleanup()

    const other = renderSwitch("running")
    expect(other.clothes.getAttribute("aria-pressed")).toBe("false")
    expect(other.running.getAttribute("aria-pressed")).toBe("true")
  })

  it("changes only the collection, so search, filters and sort are kept", () => {
    const { onChange, running } = renderSwitch("clothing")
    fireEvent.click(running)
    expect(onChange).toHaveBeenCalledTimes(1)
    // A partial change: useWardrobeFilters merges it into the current filters.
    expect(onChange).toHaveBeenCalledWith({ collection: "running" })
    cleanup()

    const back = renderSwitch("running")
    fireEvent.click(back.clothes)
    expect(back.onChange).toHaveBeenCalledWith({ collection: "clothing" })
  })

  it("ignores a press on the pressed option, so a view is always chosen", () => {
    const { onChange, clothes, running } = renderSwitch("clothing")
    fireEvent.click(clothes)
    expect(onChange).not.toHaveBeenCalled()
    expect(clothes.getAttribute("aria-pressed")).toBe("true")
    expect(running.getAttribute("aria-pressed")).toBe("false")
  })

  it("uses the comfortable touch size", () => {
    const { clothes, running } = renderSwitch("clothing")
    for (const button of [clothes, running]) {
      expect(button.getAttribute("data-size")).toBe("touch")
      expect(button.className).toContain("h-11")
    }
  })
})
