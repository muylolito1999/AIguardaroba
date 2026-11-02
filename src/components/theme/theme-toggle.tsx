"use client"

import { useSyncExternalStore } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

type ThemeValue = (typeof THEMES)[number]["value"]

function isThemeValue(value: string | undefined): value is ThemeValue {
  return THEMES.some((option) => option.value === value)
}

const subscribeToNothing = () => () => {}

/** False on the server and during hydration, true afterwards, without a setState-in-effect. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  )
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  const hydrated = useHydrated()
  // The stored choice lives in localStorage, so the server cannot know it; show
  // nothing pressed until hydration to keep server and client markup identical.
  const value: ThemeValue[] = hydrated && isThemeValue(theme) ? [theme] : []

  return (
    <ToggleGroup
      aria-label="Theme"
      variant="outline"
      size="touch"
      spacing={0}
      value={value}
      onValueChange={(next) => {
        // Pressing the active item would empty a single-select group; keep the current theme instead.
        const [selected] = next
        if (isThemeValue(selected)) setTheme(selected)
      }}
      className={className}
    >
      {THEMES.map(({ value: optionValue, label, icon: Icon }) => (
        <ToggleGroupItem
          key={optionValue}
          value={optionValue}
          className={cn(
            "flex-auto gap-1.5 px-2 text-xs",
            // A filled segment marks the choice clearly; the default muted tint is near-invisible in light mode.
            "aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 aria-pressed:hover:text-primary-foreground",
            "focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          )}
        >
          <Icon />
          <span>{label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
