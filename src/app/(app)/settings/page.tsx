import type { Metadata } from "next"

import { PageHeader } from "@/components/layout/page-header"
import { IosInstallHint } from "@/components/pwa/ios-install-hint"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { Separator } from "@/components/ui/separator"

export const metadata: Metadata = {
  title: "Settings",
}

const COMING_SOON = [
  "AI usage and costs",
  "Export (JSON, CSV and photos)",
  "Climate profiles",
  "Log out",
]

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Appearance, installation and more." />
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
          <h2 className="font-heading text-base font-semibold">Install app</h2>
          <IosInstallHint />
          <p className="text-sm text-muted-foreground">
            On Android or desktop Chrome and Edge, choose Install app from the browser menu or the
            install icon in the address bar.
          </p>
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
