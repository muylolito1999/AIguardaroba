"use client"

import { useState } from "react"
import { CloudSun } from "lucide-react"

import { noteClimateProfileChange } from "@/components/relocate/run-changes"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { ClimateProfileDto } from "@/lib/relocation/contracts"

import type { ClimateActions } from "./climate-actions"
import { ClimateProfileEditor } from "./climate-profile-editor"

export type ClimateProfilesProps = {
  profiles: ClimateProfileDto[]
  actions: ClimateActions
}

/** Every climate profile as an editable card, in the server's order (the default first). */
export function ClimateProfiles({ profiles, actions }: ClimateProfilesProps) {
  const [shownProfiles, setShownProfiles] = useState(profiles)
  const [items, setItems] = useState(profiles)
  // A fresh read (a navigation or a refresh) replaces what this page holds.
  if (profiles !== shownProfiles) {
    setShownProfiles(profiles)
    setItems(profiles)
  }

  function saved(profile: ClimateProfileDto) {
    // /relocate lists the profiles; Back to it after this save reads them again.
    noteClimateProfileChange()
    setItems((current) =>
      current.map((item) => {
        if (item.id === profile.id) return profile
        // Only one profile is the default; the server cleared the others in the same step.
        return profile.isDefault && item.isDefault ? { ...item, isDefault: false } : item
      })
    )
  }

  if (items.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudSun />
          </EmptyMedia>
          <EmptyTitle>No climate profiles yet</EmptyTitle>
          <EmptyDescription>Run pnpm db:seed to add Hamburg and Bologna.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {items.map((profile) => (
        <ClimateProfileEditor key={profile.id} profile={profile} actions={actions} onSaved={saved} />
      ))}
    </div>
  )
}
