import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { CloudSun, Download, Gauge } from "lucide-react"

import { LogoutButton } from "@/components/auth/logout-button"
import { SECONDARY_NAV_LABEL } from "@/components/layout/nav-items"
import { PageHeader } from "@/components/layout/page-header"
import { SecondaryNavLinks } from "@/components/layout/secondary-nav-links"
import { IosInstallHint } from "@/components/pwa/ios-install-hint"
import { FeatureFlags, FeatureFlagsSkeleton } from "@/components/settings/feature-flags"
import { HomeProfile, HomeProfileSkeleton } from "@/components/settings/home-profile"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

export const metadata: Metadata = {
  title: "Settings",
}

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Your home city, appearance, data and account." />
      <div className="flex max-w-2xl flex-col gap-8">
        {/* The way to Today and Outfits on a phone, where the tab bar has no tab for them (D-218);
            AI usage, climate profiles and the export each have a link in their section below. */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-base font-semibold">{SECONDARY_NAV_LABEL}</h2>
            <p className="text-sm text-muted-foreground">
              Today&rsquo;s weather with three outfit ideas, and the outfits you saved.
            </p>
          </div>
          <SecondaryNavLinks />
        </section>

        <Separator />

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

        <Suspense fallback={<HomeProfileSkeleton />}>
          <HomeProfile />
        </Suspense>

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
            <h2 className="font-heading text-base font-semibold">Climate profiles</h2>
            <p className="text-sm text-muted-foreground">
              The monthly climate values the relocation plan reasons from, and which city it starts with.
            </p>
          </div>
          <Link
            href="/settings/climate"
            className={buttonVariants({ variant: "outline", size: "touch", className: "self-start" })}
          >
            <CloudSun aria-hidden />
            Climate profiles
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

        <Suspense fallback={<FeatureFlagsSkeleton />}>
          <FeatureFlags />
        </Suspense>

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
      </div>
    </>
  )
}
