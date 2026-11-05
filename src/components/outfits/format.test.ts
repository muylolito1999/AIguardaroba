import { describe, expect, it } from "vitest"

import { itemProblemLabel } from "./format"

describe("itemProblemLabel", () => {
  const usable = { exists: true, status: "confirmed", collection: "clothing" } as const

  it("is null for a clothing item that exists and is not archived, or whose collection is unknown", () => {
    expect(itemProblemLabel(usable)).toBeNull()
    expect(itemProblemLabel({ ...usable, collection: null })).toBeNull()
  })

  it("names the first problem: deleted, then archived, then the collection the item moved to", () => {
    expect(itemProblemLabel({ exists: false, status: null, collection: null })).toBe("Deleted")
    expect(itemProblemLabel({ exists: true, status: "archived", collection: "running" })).toBe("Archived")
    expect(itemProblemLabel({ ...usable, collection: "running" })).toBe("Running gear")
  })
})
