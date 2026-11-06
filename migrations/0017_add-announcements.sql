CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `announcements_status_priority_idx` ON `announcements` (`status`,`priority`);--> statement-breakpoint
CREATE INDEX `announcements_published_idx` ON `announcements` (`published_at`);