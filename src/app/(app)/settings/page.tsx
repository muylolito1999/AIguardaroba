import type { Metadata } from "next"
import Link from "next/link"
import { Download, Gauge } from "lucide-react"

import { LogoutButton } from "@/components/auth/logout-button"
import { PageHeader } from "@/components/layout/page-header"
import { IosInstallHint } from "@/components/pwa/ios-install-hint"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

export const metadata: Metadata = {
  title: "Settings",
}

const COMING_SOON = [
  "Climate profiles",
]

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Appearance, installation and your account." />
      <div className="flex max-w-2xl flex-col gap-8">
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-base font-semibold">Appearance</h2>
            <p className="text-sm text-muted-foreground">
              Pick a theme, or follow your device setting.
            </p>
          </div>
          <ThemeToggle />
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-base font-semibold">AI usage</h2>
            <p className="text-sm text-muted-foreground">
              Claude spend this month and against the prepaid credit, by purpose and model.
            </p>
          </div>
          <Link
            href="/settings/usage"
            className={buttonVariants({ variant: "outline", size: "touch", className: "self-start" })}
          >
            <Gauge aria-hidden />
            AI usage
          </Link>
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-base font-semibold">Your data</h2>
            <p className="text-sm text-muted-foreground">
              Download your wardrobe as JSON and CSV, and your photos as ZIP files.
            </p>
          </div>
          <Link
            href="/settings/export"
            className={buttonVariants({ variant: "outline", size: "touch", className: "self-start" })}
          >
            <Download aria-hidden />
            Export your data
          </Link>
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <h2 className="font-heading text-base font-semibold">Install app</h2>
          <IosInstallHint />
          <p className="text-sm text-muted-foreground">
            On Android or desktop Chrome and Edge, choose Install app from the browser menu or the
            install icon in the address bar.
          </p>
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-base font-semibold">Account</h2>
            <p className="text-sm text-muted-foreground">
              Signing in keeps this device signed in for 30 days. Log out to end that session now.
            </p>
          </div>
          <LogoutButton className="self-start" />
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <h2 className="font-heading text-base font-semibold">Coming soon</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {COMING_SOON.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </section>
      </div>
    </>
  )
}
