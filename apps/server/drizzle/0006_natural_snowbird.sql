CREATE TABLE `ports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sandbox_id` text NOT NULL,
	`port` integer NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ports_sandbox_port_uniq` ON `ports` (`sandbox_id`,`port`);
