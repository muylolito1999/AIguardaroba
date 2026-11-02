"use client"

import { put } from "@vercel/blob/client"

import { prepareImage } from "@/lib/images/client-pipeline"
import { startTaggingBatch } from "@/server/actions/items"

import { createAddApi } from "./add-api"
import { AddFlowView, type AddFlowProps } from "./add-flow-view"
import type { AddFlowDeps } from "./use-add-flow"

export type { AddFlowProps } from "./add-flow-view"

const DEPS: AddFlowDeps = {
  prepareImage,
  // Bound so the browser's fetch keeps window as its receiver.
  api: createAddApi({ fetch: (input, init) => fetch(input, init), putBlob: put }),
  startTaggingBatch,
}

/** The /add page's client flow: pick photos, upload them, tag them. */
export function AddFlow(props: AddFlowProps) {
  return <AddFlowView {...props} deps={DEPS} />
}
