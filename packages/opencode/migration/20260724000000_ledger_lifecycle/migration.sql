ALTER TABLE `memory_event` ADD COLUMN `supersedes_event_id` text;--> statement-breakpoint
ALTER TABLE `memory_event` ADD COLUMN `migration_receipt_id` text;--> statement-breakpoint
CREATE INDEX `memory_event_supersedes_idx` ON `memory_event` (`supersedes_event_id`);
