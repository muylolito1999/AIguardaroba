import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** The link back to /outfits from the builder and an outfit's page. */
export function BackToOutfits({ className }: { className?: string }) {
  return (
    <Link
      href="/outfits"
      className={cn(buttonVariants({ variant: "ghost", size: "touch" }), "-ml-3 self-start", className)}
    >
      <ArrowLeft aria-hidden />
      All outfits
    </Link>
  )
}
