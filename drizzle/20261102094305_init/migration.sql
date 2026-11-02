CREATE TYPE "ai_call_status" AS ENUM('success', 'invalid_output', 'max_tokens', 'refusal', 'error');--> statement-breakpoint
CREATE TYPE "ai_purpose" AS ENUM('tagging', 'relocation_chunk', 'relocation_repair', 'relocation_synthesis', 'outfit_suggestion', 'shopping', 'smoke_test');--> statement-breakpoint
CREATE TYPE "analysis_kind" AS ENUM('relocation', 'outfit_suggestion', 'shopping');--> statement-breakpoint
CREATE TYPE "analysis_part_kind" AS ENUM('chunk', 'synthesis');--> statement-breakpoint
CREATE TYPE "analysis_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "batch_status" AS ENUM('in_progress', 'canceling', 'ended', 'processed');--> statement-breakpoint
CREATE TYPE "formality" AS ENUM('athletic', 'casual', 'smart_casual', 'business', 'formal');--> statement-breakpoint
CREATE TYPE "image_kind" AS ENUM('original', 'processed', 'nobg', 'thumb');--> statement-breakpoint
CREATE TYPE "item_category" AS ENUM('outerwear', 'top', 'bottom', 'dress', 'shoes', 'gloves', 'hat_beanie', 'scarf', 'base_layer', 'accessory', 'bag', 'other');--> statement-breakpoint
CREATE TYPE "item_condition" AS ENUM('new', 'good', 'worn', 'needs_repair');--> statement-breakpoint
CREATE TYPE "item_decision" AS ENUM('bring', 'leave', 'donate', 'sell', 'undecided');--> statement-breakpoint
CREATE TYPE "item_location" AS ENUM('bologna', 'hamburg', 'in_transit', 'unknown');--> statement-breakpoint
CREATE TYPE "item_status" AS ENUM('pending_tagging', 'tagged', 'confirmed', 'archived');--> statement-breakpoint
CREATE TYPE "outfit_slot" AS ENUM('outerwear', 'base_layer', 'top', 'bottom', 'shoes', 'hat', 'gloves', 'scarf', 'accessory');--> statement-breakpoint
CREATE TYPE "outfit_source" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TYPE "packing_group" AS ENUM('suitcase', 'carry_on', 'ship_later', 'wear_on_travel_day');--> statement-breakpoint
CREATE TYPE "part_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "shopping_status" AS ENUM('todo', 'bought', 'skipped');--> statement-breakpoint
CREATE TABLE "ai_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"anthropic_batch_id" text NOT NULL UNIQUE,
	"purpose" "ai_purpose" NOT NULL,
	"model" text NOT NULL,
	"status" "batch_status" DEFAULT 'in_progress'::"batch_status" NOT NULL,
	"item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"request_count" integer NOT NULL,
	"estimated_cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"purpose" "ai_purpose" NOT NULL,
	"status" "ai_call_status" NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_1h_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"pricing_tier" text,
	"is_batch" boolean DEFAULT false NOT NULL,
	"cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"request_id" text,
	"stop_reason" text,
	"error_code" text,
	"error_message" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"item_id" uuid,
	"analysis_id" uuid
);
--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "analysis_kind" NOT NULL,
	"status" "analysis_status" DEFAULT 'pending'::"analysis_status" NOT NULL,
	"climate_profile_id" uuid,
	"date_from" date,
	"date_to" date,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"model" text NOT NULL,
	"effort" text,
	"prompt_version" text NOT NULL,
	"input_snapshot_hash" text,
	"cache_key" text,
	"input_snapshot" jsonb,
	"result" jsonb,
	"estimated_cost_usd" numeric(12,6),
	"cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"error" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analysis_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"analysis_id" uuid NOT NULL,
	"kind" "analysis_part_kind" NOT NULL,
	"part_index" integer NOT NULL,
	"status" "part_status" DEFAULT 'pending'::"part_status" NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "analysis_parts_analysis_id_kind_part_index_unique" UNIQUE("analysis_id","kind","part_index")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"home_profile_id" uuid,
	"default_item_location" "item_location" DEFAULT 'bologna'::"item_location" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_single_row_check" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "climate_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL UNIQUE,
	"city" text NOT NULL,
	"country" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"timezone" text NOT NULL,
	"source" text NOT NULL,
	"months" jsonb NOT NULL,
	"wind_notes" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_placeholder" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "climate_profiles_months_check" CHECK (CASE WHEN jsonb_typeof("months") = 'array' THEN jsonb_array_length("months") = 12 ELSE false END)
);
--> statement-breakpoint
CREATE TABLE "item_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"item_id" uuid NOT NULL,
	"kind" "image_kind" NOT NULL,
	"blob_url" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_images_item_id_kind_unique" UNIQUE("item_id","kind")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "item_status" DEFAULT 'pending_tagging'::"item_status" NOT NULL,
	"location" "item_location" DEFAULT 'bologna'::"item_location" NOT NULL,
	"decision" "item_decision" DEFAULT 'undecided'::"item_decision" NOT NULL,
	"name" text,
	"category" "item_category",
	"subcategory" text,
	"colors" text[] DEFAULT '{}'::text[] NOT NULL,
	"color_hex" text[] DEFAULT '{}'::text[] NOT NULL,
	"material_guess" text,
	"materials" text[] DEFAULT '{}'::text[] NOT NULL,
	"warmth_level" integer,
	"waterproof" boolean,
	"windproof" boolean,
	"insulated" boolean,
	"breathable" boolean,
	"seasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"formality" "formality",
	"pattern" text,
	"fit" text,
	"condition" "item_condition",
	"brand" text,
	"size" text,
	"description" text,
	"notes" text DEFAULT '' NOT NULL,
	"purchase_price" numeric(10,2),
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"purchase_date" date,
	"ai_raw" jsonb,
	"ai_model" text,
	"ai_prompt_version" text,
	"ai_confidence" jsonb,
	"image_hash" text NOT NULL UNIQUE,
	"source_hash" text UNIQUE,
	"user_edited_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"wear_count" integer DEFAULT 0 NOT NULL,
	"last_worn_at" timestamp with time zone,
	"tagging_error" text,
	"tagging_batch_id" uuid,
	CONSTRAINT "items_warmth_level_check" CHECK ("warmth_level" BETWEEN 1 AND 5),
	CONSTRAINT "items_seasons_check" CHECK ("seasons" <@ ARRAY['winter', 'spring', 'summer', 'autumn']::text[]),
	CONSTRAINT "items_wear_count_check" CHECK ("wear_count" >= 0),
	CONSTRAINT "items_tagged_complete_check" CHECK ("status" NOT IN ('tagged', 'confirmed') OR ("category" IS NOT NULL AND "warmth_level" IS NOT NULL AND "waterproof" IS NOT NULL AND "windproof" IS NOT NULL AND "insulated" IS NOT NULL AND "formality" IS NOT NULL AND "condition" IS NOT NULL AND cardinality("seasons") > 0))
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"key_hash" text NOT NULL,
	"success" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outfit_items" (
	"outfit_id" uuid,
	"item_id" uuid,
	"slot" "outfit_slot" NOT NULL,
	CONSTRAINT "outfit_items_pkey" PRIMARY KEY("outfit_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "outfits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"occasion" text,
	"weather_min_c" numeric(4,1),
	"weather_max_c" numeric(4,1),
	"rain_ok" boolean DEFAULT false NOT NULL,
	"source" "outfit_source" DEFAULT 'user'::"outfit_source" NOT NULL,
	"rating" integer,
	"notes" text DEFAULT '' NOT NULL,
	"ai_reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outfits_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "packing_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"analysis_id" uuid NOT NULL,
	"item_id" uuid,
	"label" text NOT NULL,
	"packed" boolean DEFAULT false NOT NULL,
	"group" "packing_group" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"analysis_id" uuid,
	"item_type" text NOT NULL,
	"category" "item_category",
	"priority" integer DEFAULT 2 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"specs" jsonb DEFAULT '[]' NOT NULL,
	"budget_hint_eur" numeric(10,2),
	"quantity" integer DEFAULT 1 NOT NULL,
	"est_price_min_eur" numeric(10,2),
	"est_price_max_eur" numeric(10,2),
	"buy_timing" text,
	"status" "shopping_status" DEFAULT 'todo'::"shopping_status" NOT NULL,
	"linked_item_id" uuid,
	"gap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_list_items_analysis_id_gap_key_unique" UNIQUE("analysis_id","gap_key"),
	CONSTRAINT "shopping_list_items_priority_check" CHECK ("priority" BETWEEN 1 AND 3),
	CONSTRAINT "shopping_list_items_quantity_check" CHECK ("quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "wear_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"item_id" uuid,
	"outfit_id" uuid,
	"worn_on" date NOT NULL,
	"weather_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wear_logs_target_check" CHECK ("item_id" IS NOT NULL OR "outfit_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "ai_batches_status_idx" ON "ai_batches" ("status");--> statement-breakpoint
CREATE INDEX "ai_calls_created_at_idx" ON "ai_calls" ("created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_purpose_created_at_idx" ON "ai_calls" ("purpose","created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_item_id_idx" ON "ai_calls" ("item_id");--> statement-breakpoint
CREATE INDEX "ai_calls_analysis_id_idx" ON "ai_calls" ("analysis_id");--> statement-breakpoint
CREATE INDEX "analyses_cache_key_idx" ON "analyses" ("cache_key");--> statement-breakpoint
CREATE INDEX "analyses_kind_created_at_idx" ON "analyses" ("kind","created_at");--> statement-breakpoint
CREATE INDEX "analyses_climate_profile_id_idx" ON "analyses" ("climate_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "climate_profiles_single_default_idx" ON "climate_profiles" ("is_default") WHERE "is_default";--> statement-breakpoint
CREATE INDEX "items_status_idx" ON "items" ("status");--> statement-breakpoint
CREATE INDEX "items_category_idx" ON "items" ("category");--> statement-breakpoint
CREATE INDEX "items_location_idx" ON "items" ("location");--> statement-breakpoint
CREATE INDEX "items_decision_idx" ON "items" ("decision");--> statement-breakpoint
CREATE INDEX "items_created_at_idx" ON "items" ("created_at");--> statement-breakpoint
CREATE INDEX "items_tagging_batch_id_idx" ON "items" ("tagging_batch_id");--> statement-breakpoint
CREATE INDEX "login_attempts_key_hash_attempted_at_idx" ON "login_attempts" ("key_hash","attempted_at");--> statement-breakpoint
CREATE INDEX "outfit_items_item_id_idx" ON "outfit_items" ("item_id");--> statement-breakpoint
CREATE INDEX "packing_checklist_items_analysis_id_idx" ON "packing_checklist_items" ("analysis_id");--> statement-breakpoint
CREATE INDEX "packing_checklist_items_item_id_idx" ON "packing_checklist_items" ("item_id");--> statement-breakpoint
CREATE INDEX "shopping_list_items_linked_item_id_idx" ON "shopping_list_items" ("linked_item_id");--> statement-breakpoint
CREATE INDEX "wear_logs_item_id_idx" ON "wear_logs" ("item_id");--> statement-breakpoint
CREATE INDEX "wear_logs_outfit_id_idx" ON "wear_logs" ("outfit_id");--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_item_id_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_analysis_id_analyses_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_climate_profile_id_climate_profiles_id_fkey" FOREIGN KEY ("climate_profile_id") REFERENCES "climate_profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "analysis_parts" ADD CONSTRAINT "analysis_parts_analysis_id_analyses_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_home_profile_id_climate_profiles_id_fkey" FOREIGN KEY ("home_profile_id") REFERENCES "climate_profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "item_images" ADD CONSTRAINT "item_images_item_id_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_tagging_batch_id_ai_batches_id_fkey" FOREIGN KEY ("tagging_batch_id") REFERENCES "ai_batches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "outfit_items" ADD CONSTRAINT "outfit_items_outfit_id_outfits_id_fkey" FOREIGN KEY ("outfit_id") REFERENCES "outfits"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outfit_items" ADD CONSTRAINT "outfit_items_item_id_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "packing_checklist_items" ADD CONSTRAINT "packing_checklist_items_analysis_id_analyses_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "packing_checklist_items" ADD CONSTRAINT "packing_checklist_items_item_id_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_analysis_id_analyses_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_linked_item_id_items_id_fkey" FOREIGN KEY ("linked_item_id") REFERENCES "items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wear_logs" ADD CONSTRAINT "wear_logs_item_id_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wear_logs" ADD CONSTRAINT "wear_logs_outfit_id_outfits_id_fkey" FOREIGN KEY ("outfit_id") REFERENCES "outfits"("id") ON DELETE CASCADE;