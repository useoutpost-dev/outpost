CREATE TABLE `sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text,
	`volume_ref` text,
	`account_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_name_unique` ON `sandboxes` (`name`);