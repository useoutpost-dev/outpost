CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`sandbox_id` text NOT NULL,
	`account_id` text,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`est_cost_usd` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_sandbox_ts_idx` ON `usage` (`sandbox_id`,`ts`);--> statement-breakpoint
CREATE INDEX `usage_ts_idx` ON `usage` (`ts`);