import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { setHomeProfile } from "@/server/actions/settings"
import { getHomeCitySettings } from "@/server/services/settings"

import { HomeProfileSelect } from "./home-profile-select"

// Settings, Home city: the city /today shows the weather and suggests outfits
// for. Read at request time inside the page's Suspense boundary (D-041).

function Intro() {
  return (
    <div className="flex flex-col gap-1">
      <h2 id="settings-home-city-heading" className="font-heading text-base font-semibold">
        Home city
      </h2>
      <p className="text-sm text-muted-foreground">
        Today shows this city&rsquo;s weather and suggests outfits from the items located there or of unknown
        location.
      </p>
    </div>
  )
}

export async function HomeProfile() {
  await verifySession()
  const settings = await getHomeCitySettings(getDb())
  return (
    <section className="flex flex-col gap-3" aria-labelledby="settings-home-city-heading">
      <Intro />
      <HomeProfileSelect settings={settings} setHomeProfile={setHomeProfile} />
    </section>
  )
}

export function HomeProfileSkeleton() {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="settings-home-city-heading" aria-busy="true">
      <Intro />
      <Skeleton className="h-11 w-full max-w-xs" />
    </section>
  )
}
