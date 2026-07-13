CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer NOT NULL,
	`github_login` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
