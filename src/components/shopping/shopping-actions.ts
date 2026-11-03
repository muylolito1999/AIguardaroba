// The Server Actions /shopping calls, as plain function types. The page passes
// the real actions from src/server/actions/shopping.ts down as props, so these
// client components never import the action module and tests can hand in fakes.

import type { z } from "zod"

import type { ShoppingItemDto, ShoppingItemInputSchema } from "@/lib/relocation/contracts"
import type { Result } from "@/lib/result"

import type { LinkableItemDto, ShoppingItemUpdate } from "./shopping-model"

export type ShoppingItemFormInput = z.input<typeof ShoppingItemInputSchema>

export type AddShoppingItemAction = (input: ShoppingItemFormInput) => Promise<Result<ShoppingItemDto>>

export type UpdateShoppingItemAction = (input: ShoppingItemUpdate) => Promise<Result<ShoppingItemDto>>

export type DeleteShoppingItemAction = (input: { id: string }) => Promise<Result<{ deleted: true }>>

export type SearchLinkableItemsAction = (input: { q: string }) => Promise<Result<LinkableItemDto[]>>

export type ShoppingActions = {
  addShoppingItem: AddShoppingItemAction
  updateShoppingItem: UpdateShoppingItemAction
  deleteShoppingItem: DeleteShoppingItemAction
  searchLinkableItems: SearchLinkableItemsAction
}
