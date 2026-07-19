CREATE TYPE "public"."speaker_source" AS ENUM('default', 'user', 'calendar', 'voiceprint');--> statement-breakpoint
CREATE TABLE "meeting_speakers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"speaker_label" text NOT NULL,
	"display_name" text NOT NULL,
	"user_id" uuid,
	"source" "speaker_source" DEFAULT 'default' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_speakers" ADD CONSTRAINT "meeting_speakers_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_speakers" ADD CONSTRAINT "meeting_speakers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_speakers_meeting_label_idx" ON "meeting_speakers" USING btree ("meeting_id","speaker_label");