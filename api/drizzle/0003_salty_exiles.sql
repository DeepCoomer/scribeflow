ALTER TYPE "public"."job_status" ADD VALUE 'exhausted';--> statement-breakpoint
CREATE TABLE "speaker_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"speaker_label" text NOT NULL,
	"start_s" double precision NOT NULL,
	"end_s" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"start_s" double precision NOT NULL,
	"end_s" double precision NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "diarization_error" text;--> statement-breakpoint
ALTER TABLE "speaker_turns" ADD CONSTRAINT "speaker_turns_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_gaps" ADD CONSTRAINT "transcript_gaps_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;