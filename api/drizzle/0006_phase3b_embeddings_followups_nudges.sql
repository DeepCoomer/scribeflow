-- Ticket 3.5 (D63): must run before the ADD COLUMN below. Requires the
-- pgvector/pgvector Postgres image (plain postgres:16-alpine has no such
-- extension available to CREATE) — see infra/compose.yml.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "meeting_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD COLUMN "last_nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
ALTER TABLE "meeting_followups" ADD CONSTRAINT "meeting_followups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_followups" ADD CONSTRAINT "meeting_followups_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_followups_meeting_idx" ON "meeting_followups" USING btree ("meeting_id");
--> statement-breakpoint
-- Ticket 3.5 (D63): HNSW over cosine distance for the RAG chat's retrieval
-- query (`ORDER BY embedding <=> $1 LIMIT k`). Not expressible through
-- drizzle-kit's index builder (no operator-class option), so it's hand-added
-- here instead of in schema.ts. NULL embeddings (not yet processed, or the
-- embedder never ran) are simply excluded from the index, same as any
-- partial-data index.
CREATE INDEX "transcript_segments_embedding_idx" ON "transcript_segments"
  USING hnsw ("embedding" vector_cosine_ops);