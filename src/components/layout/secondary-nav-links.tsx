import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"

import { SECONDARY_NAV, SECONDARY_NAV_LABEL } from "./nav-items"

type SecondaryNavLinksProps = {
  className?: string
}

/**
 * Today and Outfits as buttons, for phones: the tab bar keeps its five tabs and
 * the sidebar that lists them is hidden below md (D-218). Plain links styled
 * as buttons; Base UI's Button would give the anchors a button role.
 */
export function SecondaryNavLinks({ className }: SecondaryNavLinksProps) {
  return (
    <nav aria-label={SECONDARY_NAV_LABEL} className={className}>
      <ul className="flex flex-wrap gap-2">
        {SECONDARY_NAV.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link href={href} className={buttonVariants({ variant: "outline", size: "touch" })}>
              <Icon aria-hidden />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
