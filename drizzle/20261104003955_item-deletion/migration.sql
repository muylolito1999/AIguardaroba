CREATE TABLE "blob_cleanup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"url" text NOT NULL UNIQUE,
	"item_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "blob_cleanup_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "deleted_items" (
	"item_id" uuid PRIMARY KEY,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
