ALTER TYPE "public"."meeting_status" ADD VALUE 'transcribing' BEFORE 'partial';--> statement-breakpoint
CREATE TABLE "rate_limiter_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"chunk_idx" integer DEFAULT 0 NOT NULL,
	"speaker" text,
	"start_s" double precision NOT NULL,
	"end_s" double precision NOT NULL,
	"text" text NOT NULL,
	"words_jsonb" jsonb
);
--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_segments_meeting_start_idx" ON "transcript_segments" USING btree ("meeting_id","start_s");--> statement-breakpoint
CREATE INDEX "transcript_segments_meeting_chunk_idx" ON "transcript_segments" USING btree ("meeting_id","chunk_idx");