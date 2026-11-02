"use client"

import { Camera, FolderOpen, Images, Upload } from "lucide-react"
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Each picker is a styled <label> around a visually hidden file input, so the
// input keeps its accessible name, a tap on the label opens the native picker
// (also on iOS), and keyboard users tab to the input itself. The label shows
// the focus ring for it.
const PICKER_LABEL = cn(
  "relative cursor-pointer",
  "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
)

type FilePickersProps = {
  onFiles: (files: File[]) => void
}

function takeFiles(event: ChangeEvent<HTMLInputElement>): File[] {
  const input = event.currentTarget
  const files = Array.from(input.files ?? [])
  // Clearing lets the same photo be picked again after a Remove.
  input.value = ""
  return files
}

export function FilePickers({ onFiles }: FilePickersProps) {
  const chooseRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    // React has no typed prop for webkitdirectory; the DOM property is standard
    // in every current browser.
    if (folderRef.current) folderRef.current.webkitdirectory = true
  }, [])

  useEffect(() => {
    // A photo dropped just outside the zone would otherwise make the browser
    // open it and leave the page, losing the queue.
    const preventFileDrop = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
    }
    window.addEventListener("dragover", preventFileDrop)
    window.addEventListener("drop", preventFileDrop)
    return () => {
      window.removeEventListener("dragover", preventFileDrop)
      window.removeEventListener("drop", preventFileDrop)
    }
  }, [])

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = takeFiles(event)
    if (files.length > 0) onFiles(files)
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    setDragging(true)
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) onFiles(files)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap">
        <label
          className={cn(
            buttonVariants({ size: "touch" }),
            PICKER_LABEL,
            "h-14 w-full text-base md:h-11 md:w-auto md:text-sm"
          )}
        >
          <Camera aria-hidden="true" className="size-5 md:size-4" />
          Take photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="sr-only"
            onChange={handleChange}
          />
        </label>
        <label className={cn(buttonVariants({ variant: "outline", size: "touch" }), PICKER_LABEL, "w-full md:w-auto")}>
          <Images aria-hidden="true" />
          Choose photos
          <input
            ref={chooseRef}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            className="sr-only"
            onChange={handleChange}
          />
        </label>
        <label
          className={cn(buttonVariants({ variant: "outline", size: "touch" }), PICKER_LABEL, "hidden md:inline-flex")}
        >
          <FolderOpen aria-hidden="true" />
          Import folder
          <input ref={folderRef} type="file" multiple className="sr-only" onChange={handleChange} />
        </label>
      </div>

      <button
        type="button"
        onClick={() => chooseRef.current?.click()}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        data-dragging={dragging || undefined}
        className={cn(
          "hidden min-h-36 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors outline-none md:flex",
          "text-muted-foreground hover:border-foreground/40 hover:bg-muted/50",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "data-dragging:border-foreground data-dragging:bg-muted data-dragging:text-foreground",
          // Children ignore the pointer so dragleave does not fire when crossing them.
          "[&>*]:pointer-events-none"
        )}
      >
        <Upload aria-hidden="true" className="size-6" />
        <span className="text-sm font-medium text-foreground">Drop photos here</span>
        <span className="text-sm">or press to choose files. JPEG, PNG, WebP and HEIC work.</span>
      </button>
    </div>
  )
}
