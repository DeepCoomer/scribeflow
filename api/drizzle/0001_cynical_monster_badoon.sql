CREATE INDEX "action_items_tenant_status_idx" ON "action_items" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "jobs_meeting_idx" ON "jobs" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meetings_tenant_created_idx" ON "meetings" USING btree ("tenant_id","created_at");