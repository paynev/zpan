PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `cloud_traffic_reports`;--> statement-breakpoint
DROP TABLE `download_tasks`;--> statement-breakpoint
DROP TABLE `downloaders`;--> statement-breakpoint
DROP TABLE `invite_codes`;--> statement-breakpoint
DROP TABLE `license_bindings`;--> statement-breakpoint
DROP TABLE `org_quota_entitlements`;--> statement-breakpoint
DROP TABLE `org_quotas`;--> statement-breakpoint
DROP TABLE `remote_download_usage_reports`;--> statement-breakpoint
DROP TABLE `site_invitations`;--> statement-breakpoint
DROP TABLE `storage_usage_breakdowns`;--> statement-breakpoint
DROP TABLE `storage_usage_ledger`;--> statement-breakpoint
DROP TABLE `team_invite_links`;--> statement-breakpoint
DROP TABLE `webhook_events`;--> statement-breakpoint
DROP TABLE `x402_capacity_purchase_intents`;--> statement-breakpoint
DROP TABLE `deviceCode`;--> statement-breakpoint
DROP TABLE `downloader_bootstrap_credentials`;--> statement-breakpoint
DROP TABLE `invitation`;--> statement-breakpoint
DROP TABLE `member`;--> statement-breakpoint
DROP TABLE `oauthAccessToken`;--> statement-breakpoint
DROP TABLE `oauthClient`;--> statement-breakpoint
DROP TABLE `oauthClientAssertion`;--> statement-breakpoint
DROP TABLE `oauthClientRegistration`;--> statement-breakpoint
DROP TABLE `oauthClientResource`;--> statement-breakpoint
DROP TABLE `oauthConsent`;--> statement-breakpoint
DROP TABLE `oauthJwtRevocation`;--> statement-breakpoint
DROP TABLE `oauthPushedAuthorizationRequest`;--> statement-breakpoint
DROP TABLE `oauthRefreshToken`;--> statement-breakpoint
DROP TABLE `oauthResource`;--> statement-breakpoint
DROP TABLE `organization`;--> statement-breakpoint
DROP TABLE `image_hostings`;--> statement-breakpoint
DROP TABLE `image_hosting_configs`;--> statement-breakpoint
DROP INDEX `audit_events_org_created_idx`;--> statement-breakpoint
ALTER TABLE `audit_events` DROP COLUMN `org_id`;--> statement-breakpoint
DROP TABLE `background_jobs`;--> statement-breakpoint
DROP INDEX `user_username_unique`;--> statement-breakpoint
ALTER TABLE `user` DROP COLUMN `username`;--> statement-breakpoint
ALTER TABLE `user` DROP COLUMN `display_username`;--> statement-breakpoint
DROP INDEX `matters_webdav_path_idx`;--> statement-breakpoint
DROP INDEX `matters_webdav_children_idx`;--> statement-breakpoint
DROP INDEX `matters_list_page_idx`;--> statement-breakpoint
DROP INDEX `matters_trash_page_idx`;--> statement-breakpoint
CREATE INDEX `matters_webdav_path_idx` ON `matters` (`parent`,`name`,`status`,`trashed_at`,`purged_at`);--> statement-breakpoint
CREATE INDEX `matters_webdav_children_idx` ON `matters` (`parent`,`status`,`trashed_at`,`purged_at`,"dirtype" desc,`name`);--> statement-breakpoint
CREATE INDEX `matters_list_page_idx` ON `matters` (`parent`,`status`,`trashed_at`,`purged_at`,"dirtype" desc,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `matters_trash_page_idx` ON `matters` (`status`,`purged_at`,`trashed_at`,`created_at`,`id`);--> statement-breakpoint
-- matters_active_name_uniq was created by raw SQL (migration 0009/0047), so drizzle
-- does not track it. Rebuild it without org_id to preserve the "one active name per
-- folder" invariant in the single-admin namespace.
DROP INDEX `matters_active_name_uniq`;--> statement-breakpoint
ALTER TABLE `matters` DROP COLUMN `org_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `matters_active_name_uniq`
  ON `matters` (`parent`, LOWER(`name`))
  WHERE `status` = 'active' AND `trashed_at` IS NULL;--> statement-breakpoint
DROP INDEX `object_upload_sessions_object_idx`;--> statement-breakpoint
CREATE INDEX `object_upload_sessions_object_idx` ON `object_upload_sessions` (`object_id`);--> statement-breakpoint
ALTER TABLE `object_upload_sessions` DROP COLUMN `org_id`;--> statement-breakpoint
DROP INDEX `stats_rollups_hourly_bucket_metric_dim_uniq`;--> statement-breakpoint
CREATE UNIQUE INDEX `stats_rollups_hourly_bucket_metric_dim_uniq` ON `stats_rollups_hourly` (`bucket_start`,`metric_key`,`dimension_key`,`dimension_value`);--> statement-breakpoint
ALTER TABLE `stats_rollups_hourly` DROP COLUMN `org_id`;--> statement-breakpoint
DROP INDEX `webdav_dead_properties_resource_prop_uniq`;--> statement-breakpoint
DROP INDEX `webdav_dead_properties_resource_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `webdav_dead_properties_resource_prop_uniq` ON `webdav_dead_properties` (`resource_path`,`namespace`,`name`);--> statement-breakpoint
CREATE INDEX `webdav_dead_properties_resource_idx` ON `webdav_dead_properties` (`resource_path`);--> statement-breakpoint
ALTER TABLE `webdav_dead_properties` DROP COLUMN `org_id`;--> statement-breakpoint
DROP INDEX `webdav_locks_resource_idx`;--> statement-breakpoint
CREATE INDEX `webdav_locks_resource_idx` ON `webdav_locks` (`resource_path`);--> statement-breakpoint
ALTER TABLE `webdav_locks` DROP COLUMN `org_id`;--> statement-breakpoint
ALTER TABLE `shares` DROP COLUMN `org_id`;--> statement-breakpoint
ALTER TABLE `storages` DROP COLUMN `custom_host`;--> statement-breakpoint
ALTER TABLE `storages` DROP COLUMN `egress_credit_billing_enabled`;--> statement-breakpoint
ALTER TABLE `storages` DROP COLUMN `egress_credit_unit_bytes`;--> statement-breakpoint
ALTER TABLE `storages` DROP COLUMN `egress_credit_per_unit`;--> statement-breakpoint
ALTER TABLE `session` DROP COLUMN `active_organization_id`;--> statement-breakpoint
PRAGMA foreign_keys=ON;