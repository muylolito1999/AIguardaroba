"use server";

import { z } from "zod";

import { LINK_SEARCH_MAX, ShoppingItemUpdateSchema } from "@/components/shopping/shopping-model";
import { getDb } from "@/lib/db";
import { ShoppingItemInputSchema } from "@/lib/relocation/contracts";
import { ok } from "@/lib/result";
import {
  addShoppingItem as addShoppingItemService,
  deleteShoppingItem as deleteShoppingItemService,
  searchLinkableItems as searchLinkableItemsService,
  updateShoppingItem as updateShoppingItemService,
} from "@/server/services/shopping";

import { authedAction } from "./_wrap";

// The /shopping list. Each action returns what the list needs to update the
// row it holds; nothing is revalidated, because the page reads the list
// uncached in a Suspense child. Linking a row changes no item, so no wardrobe
// change is noted for it.

export const addShoppingItem = authedAction(
  ShoppingItemInputSchema,
  async (input) => ok(await addShoppingItemService(getDb(), input)),
  { name: "addShoppingItem" },
);

export const updateShoppingItem = authedAction(
  ShoppingItemUpdateSchema,
  async (input) => ok(await updateShoppingItemService(getDb(), input)),
  { name: "updateShoppingItem" },
);

export const deleteShoppingItem = authedAction(
  z.strictObject({ id: z.uuid() }),
  async ({ id }) => ok(await deleteShoppingItemService(getDb(), id)),
  { name: "deleteShoppingItem" },
);

/** The link picker's search; empty text lists the newest items. */
export const searchLinkableItems = authedAction(
  z.strictObject({ q: z.string().max(LINK_SEARCH_MAX) }),
  async ({ q }) => ok(await searchLinkableItemsService(getDb(), q)),
  { name: "searchLinkableItems" },
);
