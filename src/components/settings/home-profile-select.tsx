"use client"

import { useId, useRef, useState } from "react"

import { noteHomeCityChange } from "@/components/today/today-changes"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { toast } from "@/components/ui/toast"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import { err, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"
import type { HomeCitySettingsDto } from "@/server/services/settings"

export type SetHomeProfileAction = (input: { profileId: string }) => Promise<Result<HomeCitySettingsDto>>

export type HomeProfileSelectProps = {
  settings: HomeCitySettingsDto
  setHomeProfile: SetHomeProfileAction
}

/**
 * The home city select. A choice is saved at once; while it saves the
 * select shows it and is disabled, and a refusal puts the saved city back.
 * A /today that Next keeps hidden reads itself again when shown after a
 * change (noteHomeCityChange).
 */
export function HomeProfileSelect({ settings, setHomeProfile }: HomeProfileSelectProps) {
  const id = useId()
  const [saved, setSaved] = useState(settings.homeProfileId)
  const [shown, setShown] = useState(settings.homeProfileId)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)

  const choose = async (profileId: string) => {
    if (busy.current || profileId === "" || profileId === saved) return
    busy.current = true
    setShown(profileId)
    setPending(true)
    let result: Result<HomeCitySettingsDto>
    try {
      result = await setHomeProfile({ profileId })
    } catch {
      result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
    }
    busy.current = false
    setPending(false)
    if (!result.ok) {
      setShown(saved)
      toastError(result.error)
      return
    }
    setSaved(result.data.homeProfileId)
    setShown(result.data.homeProfileId)
    noteHomeCityChange()
    const city = result.data.options.find((option) => option.id === result.data.homeProfileId)?.city
    toast.add({ title: city === undefined ? "Home city saved" : `Home city: ${city}`, type: "success" })
  }

  if (settings.options.length === 0) {
    return <p className="text-sm text-muted-foreground">No city is available. Run pnpm db:seed to add Bologna and Hamburg.</p>
  }

  const chosen = settings.options.find((option) => option.id === shown)
  return (
    <Field className="max-w-xs">
      <FieldLabel htmlFor={id}>Home city</FieldLabel>
      <NativeSelect
        id={id}
        value={shown ?? ""}
        disabled={pending}
        aria-describedby={`${id}-status`}
        onChange={(event) => void choose(event.target.value)}
        className="w-full [&_select]:h-11"
      >
        {shown === null ? (
          <NativeSelectOption value="" disabled>
            Choose a city
          </NativeSelectOption>
        ) : null}
        {settings.options.map((option) => (
          <NativeSelectOption key={option.id} value={option.id}>
            {option.city}, {option.country}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription id={`${id}-status`} role="status">
        {pending && chosen !== undefined ? `Saving ${chosen.city}…` : ""}
      </FieldDescription>
    </Field>
  )
}
