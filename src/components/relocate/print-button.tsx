"use client"

import { Printer } from "lucide-react"

import { Button } from "@/components/ui/button"

/** Opens the browser's print dialog; hidden on paper itself. */
export function PrintButton() {
  return (
    <Button type="button" size="touch" onClick={() => window.print()} className="print:hidden">
      <Printer aria-hidden />
      Print
    </Button>
  )
}
