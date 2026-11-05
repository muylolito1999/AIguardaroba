ALTER TABLE "login_attempts" ADD COLUMN "prefix_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "login_attempts_prefix_hash_attempted_at_idx" ON "login_attempts" ("prefix_hash","attempted_at");--> statement-breakpoint
CREATE INDEX "login_attempts_attempted_at_idx" ON "login_attempts" ("attempted_at");