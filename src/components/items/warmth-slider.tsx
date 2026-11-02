"use client"

import type { Ref } from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { WARMTH_LEVELS, type WarmthLevel } from "@/lib/items/contracts"

import { isWarmthLevel } from "./tag-form-model"
import { warmthDescription, WARMTH_RUBRIC } from "./tag-options"

type WarmthSliderProps = {
  /** id of the visible label; the thumb's input is named by it. */
  labelId: string
  value: WarmthLevel
  onChange: (value: WarmthLevel) => void
  onBlur?: () => void
  describedBy?: string
  inputRef?: Ref<HTMLInputElement>
  disabled?: boolean
}

/**
 * Warmth 1 to 5 with the rubric's words. Built from the Base UI parts rather
 * than ui/slider.tsx, which cannot label the thumb or set its value text; the
 * thumb's input reads "3 · Mid layer (sweater, light jacket)" to screen
 * readers, and the same words show under the track.
 */
export function WarmthSlider({
  labelId,
  value,
  onChange,
  onBlur,
  describedBy,
  inputRef,
  disabled,
}: WarmthSliderProps) {
  return (
    <div className="flex flex-col gap-2">
      <SliderPrimitive.Root
        value={value}
        min={WARMTH_LEVELS[0]}
        max={WARMTH_LEVELS[WARMTH_LEVELS.length - 1]}
        step={1}
        disabled={disabled}
        onValueChange={(next) => {
          // A single-thumb slider reports a number; anything else is ignored.
          if (typeof next === "number" && isWarmthLevel(next)) onChange(next)
        }}
        thumbAlignment="edge"
        // Root passes this to the thumb's input, so the visible label names it.
        aria-labelledby={labelId}
        className="w-full px-1"
      >
        {/* py-5 makes the whole 44 px band around the track respond to taps. */}
        <SliderPrimitive.Control className="relative flex w-full touch-none items-center py-5 select-none data-disabled:opacity-50">
          <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted select-none">
            <SliderPrimitive.Indicator className="h-full bg-primary select-none" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            inputRef={inputRef}
            onBlur={onBlur}
            getAriaValueText={(_formatted, level) =>
              isWarmthLevel(level) ? warmthDescription(level) : String(level)
            }
            aria-describedby={describedBy}
            className="relative block size-5 shrink-0 rounded-full border-2 border-primary bg-background shadow-sm ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-3 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden"
          />
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
      <ol aria-hidden className="flex justify-between px-1 text-xs text-muted-foreground tabular-nums">
        {WARMTH_LEVELS.map((level) => (
          <li key={level} className={level === value ? "font-semibold text-foreground" : undefined}>
            {level}
          </li>
        ))}
      </ol>
      <p className="text-sm">
        <span className="font-medium">{WARMTH_RUBRIC[value].label}</span>
        {WARMTH_RUBRIC[value].examples ? (
          <span className="text-muted-foreground"> · {WARMTH_RUBRIC[value].examples}</span>
        ) : null}
      </p>
    </div>
  )
}
