ALTER TYPE "outfit_slot" ADD VALUE 'mid_layer' BEFORE 'base_layer';--> statement-breakpoint
ALTER TYPE "outfit_slot" ADD VALUE 'socks' BEFORE 'shoes';--> statement-breakpoint
-- Hand-edited (D-254): item_category gains 'socks' by being recreated, in the
-- shape drizzle-kit itself uses for recreate_enum, not by ADD VALUE. The
-- migrator applies every pending migration in one transaction, and Postgres
-- refuses a value added by ADD VALUE until that transaction commits, so the
-- socks tagged base_layer could not be moved in the same run. While the two
-- columns are text, the UPDATEs use no enum value at all; the final casts use
-- a type created in this transaction, which Postgres allows.
ALTER TABLE "items" ALTER COLUMN "category" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ALTER COLUMN "category" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "item_category";--> statement-breakpoint
CREATE TYPE "item_category" AS ENUM('outerwear', 'top', 'bottom', 'dress', 'shoes', 'socks', 'gloves', 'hat_beanie', 'scarf', 'base_layer', 'accessory', 'bag', 'other');--> statement-breakpoint
UPDATE "items" SET "category" = 'socks', "updated_at" = now() WHERE "category" = 'base_layer' AND (coalesce("subcategory", '') ~* 'sock' OR coalesce("name", '') ~* 'sock');--> statement-breakpoint
UPDATE "shopping_list_items" SET "category" = 'socks' WHERE "category" = 'base_layer' AND "item_type" ~* 'sock';--> statement-breakpoint
ALTER TABLE "items" ALTER COLUMN "category" SET DATA TYPE "item_category" USING "category"::"item_category";--> statement-breakpoint
ALTER TABLE "shopping_list_items" ALTER COLUMN "category" SET DATA TYPE "item_category" USING "category"::"item_category";
