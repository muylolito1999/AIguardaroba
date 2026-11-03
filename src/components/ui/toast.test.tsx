// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { createToastManager, Toaster } from "./toast"

// Base UI 1.9 hides a collapsed toast's close button from assistive tech
// (aria-hidden, so the live region does not read "Close toast" with every
// toast) but left it in the tab order: axe's aria-hidden-focus. The wrapper
// takes it out of the tab order while it is hidden (D-182).

afterEach(() => {
  cleanup()
})

function closeButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="toast-close"]')]
}

describe("ToastClose", () => {
  it("is out of the tab order while hidden, and back in once the stack expands", async () => {
    const manager = createToastManager()
    render(<Toaster toastManager={manager} />)
    act(() => {
      manager.add({ title: "Saved", type: "success" })
      manager.add({ title: "Added", type: "success" })
    })
    await waitFor(() => expect(closeButtons()).toHaveLength(2))

    for (const button of closeButtons()) {
      expect(button.getAttribute("aria-hidden")).toBe("true")
      expect(button.tabIndex).toBe(-1)
    }

    // The pointer (or keyboard focus) entering the stack expands it.
    fireEvent.mouseEnter(screen.getByRole("region", { name: /Notifications/ }))
    await waitFor(() => expect(closeButtons()[0]?.getAttribute("aria-hidden")).toBe("false"))
    for (const button of closeButtons()) expect(button.tabIndex).toBe(0)

    const [first] = closeButtons()
    if (first === undefined) throw new Error("no close button")
    fireEvent.click(first)
    await waitFor(() => expect(closeButtons()).toHaveLength(1))
  })
})
