CREATE TABLE `memory_event` (
  `event_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `session_id` text NOT NULL,
  `session_sequence` integer NOT NULL,
  `project_sequence` integer NOT NULL,
  `timestamp` integer NOT NULL,
  `kind` text NOT NULL,
  `scope` text NOT NULL,
  `target` text NOT NULL,
  `operation` text NOT NULL,
  `identity_key` text NOT NULL,
  `content` text NOT NULL,
  `source_turn` text,
  `writer` text NOT NULL,
  `base_revision` text,
  `policy_version` text NOT NULL DEFAULT '1',
  `status` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `memory_event_project_idx` ON `memory_event` (`project_id`, `project_sequence`);--> statement-breakpoint
CREATE INDEX `memory_event_session_idx` ON `memory_event` (`session_id`, `session_sequence`);--> statement-breakpoint
CREATE INDEX `memory_event_identity_idx` ON `memory_event` (`identity_key`, `project_id`, `target`);--> statement-breakpoint
CREATE INDEX `memory_event_status_idx` ON `memory_event` (`status`);--> statement-breakpoint
CREATE INDEX `memory_event_timestamp_idx` ON `memory_event` (`timestamp`);
