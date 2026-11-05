CREATE TYPE "item_collection" AS ENUM('clothing', 'running');--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "collection" "item_collection" DEFAULT 'clothing'::"item_collection" NOT NULL;--> statement-breakpoint
CREATE INDEX "items_collection_idx" ON "items" ("collection");