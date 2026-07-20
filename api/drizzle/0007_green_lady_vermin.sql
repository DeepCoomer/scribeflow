CREATE TYPE "public"."bot_session_state" AS ENUM('spawning', 'joining', 'lobby', 'recording', 'leaving', 'done', 'not_admitted', 'denied', 'blocked', 'invalid_url', 'failed');--> statement-breakpoint
CREATE TABLE "bot_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"job_key" text NOT NULL,
	"meet_url" text NOT NULL,
	"container_id" text,
	"state" "bot_session_state" DEFAULT 'spawning' NOT NULL,
	"session_token" text NOT NULL,
	"segments_uploaded" integer DEFAULT 0 NOT NULL,
	"rejoined" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"error" text,
	"outcome_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_sessions_job_key_idx" ON "bot_sessions" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "bot_sessions_tenant_state_idx" ON "bot_sessions" USING btree ("tenant_id","state");