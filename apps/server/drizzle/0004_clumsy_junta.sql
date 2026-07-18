CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`credential_volume_ref` text,
	`encrypted_key` text,
	`encrypted_credentials` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_label_unique` ON `accounts` (`label`);