// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { ItemDecision } from "@/lib/db/enums"
import type { PackingRowDto, RelocationItemRefDto, RelocationViewDto } from "@/lib/relocation/contracts"

import { makeRelocationResult } from "../../../test/relocation-fixtures"
import { PrintChecklist } from "./print-checklist"

// The paper copy of the packing checklist: decisions as they are now (D-181)
// and page breaks that let a long group flow (D-181).

const ITEM_IDS = Array.from({ length: 50 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)
const FIRST = ITEM_IDS[0] ?? ""

function makeView(decisions: Record<string, ItemDecision> = {}): RelocationViewDto {
  const result = makeRelocationResult(ITEM_IDS)
  const items: Record<string, RelocationItemRefDto> = Object.fromEntries(
    ITEM_IDS.map((id, index) => [
      id,
      {
        id,
        name: `Item ${index + 1}`,
        category: "outerwear",
        thumb: null,
        currentDecision: decisions[id] ?? "undecided",
        status: "confirmed",
        location: "bologna",
        collection: "clothing",
        exists: true,
      } satisfies RelocationItemRefDto,
    ])
  )
  let order = 0
  const packing: PackingRowDto[] = result.packing_checklist.flatMap((group) =>
    group.item_ids.map((itemId) => ({
      id: `00000000-0000-4000-9000-${String((order += 1)).padStart(12, "0")}`,
      group: group.group,
      label: items[itemId]?.name ?? "?",
      itemId,
      packed: false,
      sortOrder: order,
    }))
  )
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    createdAt: "2026-11-03T08:00:00.000Z",
    completedAt: "2026-11-03T08:04:00.000Z",
    status: "complete",
    model: "claude-sonnet-5-5",
    effort: "medium",
    promptVersion: "reloc-v4",
    estimatedCostUsd: 0.42,
    costUsd: 0.39,
    params: {
      climateProfileId: "00000000-0000-4000-8000-0000000000e1",
      dateFrom: "2026-11-03",
      dateTo: "2027-11-02",
      constraints: "",
      purchaseBudgetEur: 600,
      includeOnlyConfirmed: true,
      acceptPlaceholder: false,
    },
    months: [11, 12, 1],
    profile: { id: "00000000-0000-4000-8000-0000000000e1", city: "Hamburg", country: "Germany", isPlaceholder: false },
    destination: "hamburg",
    result,
    items,
    packing,
    addedGapKeys: [],
  }
}

afterEach(() => {
  cleanup()
})

describe("PrintChecklist", () => {
  it("lists items no longer brought apart, by the decisions as they are now (D-181)", () => {
    // Item 1: the AI brings it and packed it in the suitcase; the owner now donates it.
    render(<PrintChecklist view={makeView({ [FIRST]: "donate" })} />)

    const suitcase = screen.getByRole("region", { name: "Suitcase" })
    expect(within(suitcase).queryByText("Item 1")).toBeNull()
    const notBringing = screen.getByRole("region", { name: "Not bringing" })
    expect(within(notBringing).getByText("Item 1 (Yours: Donate · not coming)")).toBeTruthy()
    // Item 3, which the AI decided leave but packed anyway, goes there too.
    expect(within(notBringing).getByText("Item 3 (AI: Leave · not coming)")).toBeTruthy()
    // Item 2 is still coming.
    expect(within(screen.getByRole("region", { name: "Carry-on" })).getByText("Item 2")).toBeTruthy()
  })

  it("lets a long group flow onto the next sheet: rows and headings are kept whole, groups are not (D-181)", () => {
    const { container } = render(<PrintChecklist view={makeView()} />)
    const sections = [...container.querySelectorAll("section")]
    expect(sections.length).toBeGreaterThan(0)
    for (const section of sections) {
      expect(section.className).not.toContain("break-inside-avoid")
      expect(section.querySelector("h2")?.className).toContain("break-after-avoid")
    }
    const rows = [...container.querySelectorAll("li")]
    expect(rows.length).toBeGreaterThan(10)
    for (const row of rows) expect(row.className).toContain("break-inside-avoid")
  })
})
