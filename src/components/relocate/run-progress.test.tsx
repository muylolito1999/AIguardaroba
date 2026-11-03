// @vitest-environment jsdom
import { Activity, StrictMode } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { shoppingListIsStale } from "@/components/shopping/shopping-changes"
import type { RelocationPartDto, RelocationRunDto } from "@/lib/relocation/contracts"
import { CONFIG_ERROR_MESSAGE, type AppErrorPayload } from "@/lib/result"

import { CONFLICT_RETRY_MS } from "./run-orchestrator"
import { RunProgress } from "./run-progress"

// RunProgress against a fake /api/analyses/[id]/parts/[partId]: every POST is
// recorded and stays open until the test answers it. Next keeps a hidden page
// in an <Activity> (node_modules/next/dist/docs/01-app/02-guides/
// preserving-ui-state.md), which the tests render directly.

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

const ANALYSIS_ID = "00000000-0000-4000-8000-0000000000b1"

function makeRun(chunks: number, overrides: Record<string, Partial<RelocationPartDto>> = {}): RelocationRunDto {
  const parts: RelocationPartDto[] = [
    ...Array.from({ length: chunks }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000c00${index}`,
      kind: "chunk" as const,
      partIndex: index,
      status: "pending" as const,
      itemCount: 50,
      costUsd: 0,
      attempts: 0,
      error: null,
    })),
    {
      id: "00000000-0000-4000-8000-00000000d000",
      kind: "synthesis" as const,
      partIndex: 0,
      status: "pending" as const,
      itemCount: chunks * 50,
      costUsd: 0,
      attempts: 0,
      error: null,
    },
  ]
  return {
    analysisId: ANALYSIS_ID,
    status: "running",
    parts: parts.map((part) => ({ ...part, ...overrides[part.id] })),
    estimatedCostUsd: 0.5,
    costUsd: 0,
  }
}

const SYNTHESIS_ID = "00000000-0000-4000-8000-00000000d000"
const chunkId = (index: number) => `00000000-0000-4000-8000-00000000c00${index}`

type OpenPost = { partId: string; resolve: (response: Response) => void }
type SentPost = { partId: string; body: unknown }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** A fake parts route that keeps the run's state and answers when told to. */
function fakeRoute(initial: RelocationRunDto) {
  let run = initial
  const open: OpenPost[] = []
  const sent: SentPost[] = []
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const partId = url.split("/").pop() ?? ""
    expect(url).toBe(`/api/analyses/${ANALYSIS_ID}/parts/${partId}`)
    expect(init?.method).toBe("POST")
    sent.push({ partId, body: JSON.parse(String(init?.body)) })
    return new Promise<Response>((resolve) => open.push({ partId, resolve }))
  })

  function take(partId: string): OpenPost {
    const index = open.findIndex((post) => post.partId === partId)
    const post = open[index]
    if (post === undefined) throw new Error(`No open request for ${partId}`)
    open.splice(index, 1)
    return post
  }

  return {
    fetchMock,
    sent: () => sent,
    openIds: () => open.map((post) => post.partId),
    async complete(partId: string) {
      run = {
        ...run,
        costUsd: run.costUsd + 0.05,
        parts: run.parts.map((part) => (part.id === partId ? { ...part, status: "complete", costUsd: 0.05 } : part)),
      }
      if (run.parts.every((part) => part.status === "complete")) run = { ...run, status: "complete" }
      take(partId).resolve(json({ ok: true, data: run }))
      await flush()
    },
    async fail(partId: string, error: AppErrorPayload, status: number) {
      take(partId).resolve(json({ ok: false, error }, status))
      await flush()
    },
  }
}

/** Lets fetch answers, p-limit's queue and React's updates settle. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  router.refresh.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function setup(run: RelocationRunDto) {
  const route = fakeRoute(run)
  vi.stubGlobal("fetch", route.fetchMock)
  return route
}

describe("RunProgress", () => {
  it("posts four chunks at a time, each once under StrictMode, then the synthesis, then shows the results", async () => {
    const route = setup(makeRun(5))
    render(
      <StrictMode>
        <RunProgress run={makeRun(5)} />
      </StrictMode>
    )
    await flush()

    expect(route.openIds()).toEqual([chunkId(0), chunkId(1), chunkId(2), chunkId(3)])
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("0 of 6 parts done")

    await route.complete(chunkId(2))
    expect(route.openIds()).toEqual([chunkId(0), chunkId(1), chunkId(3), chunkId(4)])
    for (const index of [0, 1, 3]) await route.complete(chunkId(index))
    expect(route.openIds()).toEqual([chunkId(4)])

    await route.complete(chunkId(4))
    expect(route.openIds()).toEqual([SYNTHESIS_ID])
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("5 of 6 parts done")
    expect(router.refresh).not.toHaveBeenCalled()

    await route.complete(SYNTHESIS_ID)
    expect(screen.getByRole("status").textContent).toBe("Analysis complete. Loading the results…")
    expect(router.refresh).toHaveBeenCalled()
    expect(route.fetchMock).toHaveBeenCalledTimes(6)
  })

  it("says a closed tab does not stop running parts, which finish on the server (D-167)", async () => {
    setup(makeRun(2))
    render(<RunProgress run={makeRun(2)} />)
    await flush()

    expect(
      screen.getByText(
        "You can open other pages meanwhile: running parts finish, and the rest start when you come back. Closing or reloading this tab does not stop parts already running; they finish on the server and show here when you come back."
      )
    ).toBeTruthy()
    expect(screen.queryByText(/stops the running parts/)).toBeNull()
  })

  it("tells a kept /shopping to read again once the run finishes, also while this page is hidden (D-173)", async () => {
    const route = setup(makeRun(1))
    const run = makeRun(1)
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <RunProgress run={run} />
      </Activity>
    )
    const view = render(ui("visible"))
    await flush()
    // A /shopping page shown before the run finished, with the previous run's budget.
    const shownList = {}
    expect(shoppingListIsStale(shownList)).toBe(false)

    await route.complete(chunkId(0))
    expect(shoppingListIsStale(shownList)).toBe(false)
    await flush()
    // The owner goes to /shopping while the synthesis runs; it finishes meanwhile.
    view.rerender(ui("hidden"))
    await flush()
    await route.complete(SYNTHESIS_ID)

    expect(shoppingListIsStale(shownList)).toBe(true)
  })

  it("shows a part as running elsewhere after CONFLICT and asks again 5 s later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const route = setup(makeRun(1))
    render(<RunProgress run={makeRun(1)} />)
    await flush()

    await route.fail(chunkId(0), { code: "CONFLICT", message: "This part is already running." }, 409)
    const parts = screen.getByRole("list", { name: "Parts" })
    expect(within(parts).getByText("Running elsewhere…")).toBeTruthy()
    expect(route.openIds()).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFLICT_RETRY_MS)
    })
    await flush()
    expect(route.openIds()).toEqual([chunkId(0)])

    await route.complete(chunkId(0))
    expect(route.openIds()).toEqual([SYNTHESIS_ID])
  })

  it("stops on a configuration error with a clear message, and Try again continues", async () => {
    const route = setup(makeRun(6))
    render(<RunProgress run={makeRun(6)} />)
    await flush()

    await route.fail(chunkId(0), { code: "CONFIG", message: CONFIG_ERROR_MESSAGE }, 500)
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("Configuration problem")
    expect(alert.textContent).toContain(CONFIG_ERROR_MESSAGE)
    expect(alert.textContent).toContain("AI settings")
    expect(screen.getByRole("status").textContent).toBe("Stopped: Configuration problem.")

    // Answers already on the way still count; nothing new starts.
    await route.complete(chunkId(1))
    expect(route.openIds()).toEqual([chunkId(2), chunkId(3)])
    expect(route.fetchMock).toHaveBeenCalledTimes(4)

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }))
    await flush()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(route.openIds()).toEqual([chunkId(2), chunkId(3), chunkId(0), chunkId(4)])
  })

  it("starts no new parts while Next keeps the page hidden, and continues when it is shown again", async () => {
    const route = setup(makeRun(6))
    const run = makeRun(6)
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <RunProgress run={run} />
      </Activity>
    )
    const view = render(ui("visible"))
    await flush()
    expect(route.openIds()).toHaveLength(4)

    view.rerender(ui("hidden"))
    await flush()
    for (const index of [0, 1, 2, 3]) await route.complete(chunkId(index))
    expect(route.openIds()).toEqual([])
    expect(route.fetchMock).toHaveBeenCalledTimes(4)

    view.rerender(ui("visible"))
    await flush()
    expect(route.openIds()).toEqual([chunkId(4), chunkId(5)])
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("4 of 7 parts done")
  })

  it("leaves a failed part alone until Retry, and Retry posts it again", async () => {
    const run = makeRun(2, { [chunkId(1)]: { status: "complete", costUsd: 0.05 } })
    const route = setup(run)
    render(<RunProgress run={run} />)
    await flush()

    await route.fail(chunkId(0), { code: "AI_TIMEOUT", message: "Claude took too long to answer." }, 504)
    const parts = screen.getByRole("list", { name: "Parts" })
    expect(within(parts).getByText("Claude took too long to answer.")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toBe("1 part failed. Retry to finish the analysis.")
    expect(route.openIds()).toEqual([])

    const retry = within(parts).getByRole("button", { name: "Retry part 1 of 2" })
    retry.focus()
    fireEvent.click(retry)
    await flush()
    expect(route.openIds()).toEqual([chunkId(0)])
    expect(within(parts).queryByText("Claude took too long to answer.")).toBeNull()
    // Only the Retry asks the server to run the failed part again (D-157).
    expect(route.sent()).toEqual([
      { partId: chunkId(0), body: {} },
      { partId: chunkId(0), body: { retry: true } },
    ])
    // The button left with the failure; focus went to the status line, not <body>.
    expect(retry.isConnected).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole("status"))
  })

  it("moves focus to the status line after Try again and after Retry failed parts", async () => {
    const route = setup(makeRun(3))
    render(<RunProgress run={makeRun(3)} />)
    await flush()

    await route.fail(chunkId(0), { code: "CONFIG", message: CONFIG_ERROR_MESSAGE }, 500)
    const tryAgain = within(screen.getByRole("alert")).getByRole("button", { name: "Try again" })
    tryAgain.focus()
    fireEvent.click(tryAgain)
    await flush()
    expect(tryAgain.isConnected).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole("status"))

    for (const index of [0, 1, 2]) {
      await route.fail(chunkId(index), { code: "AI_TIMEOUT", message: "Claude took too long to answer." }, 504)
    }
    const retryAll = screen.getByRole("button", { name: "Retry failed parts" })
    retryAll.focus()
    fireEvent.click(retryAll)
    await flush()
    expect(retryAll.isConnected).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole("status"))
    expect(route.openIds()).toEqual([chunkId(0), chunkId(1), chunkId(2)])
  })

  it("resumes a run that finished while away by refreshing at once", async () => {
    const run: RelocationRunDto = {
      ...makeRun(1, { [chunkId(0)]: { status: "complete" }, [SYNTHESIS_ID]: { status: "complete" } }),
      status: "complete",
    }
    const route = setup(run)
    render(<RunProgress run={run} />)
    await flush()
    expect(route.fetchMock).not.toHaveBeenCalled()
    expect(router.refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Show results" })).toBeTruthy()
  })
})
