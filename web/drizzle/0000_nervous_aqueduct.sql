CREATE TABLE `annotation_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`annotation_id` text NOT NULL,
	`video_id` text NOT NULL,
	`author_email` text NOT NULL,
	`author_name` text NOT NULL,
	`taxonomy_version` text NOT NULL,
	`revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`annotation_id`) REFERENCES `annotations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `annotation_snapshots_video_idx` ON `annotation_snapshots` (`video_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `annotation_snapshots_annotation_revision_idx` ON `annotation_snapshots` (`annotation_id`,`revision`);--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`author_email` text NOT NULL,
	`author_name` text NOT NULL,
	`taxonomy_version` text DEFAULT 'V0.2' NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`analysis_title` text DEFAULT '' NOT NULL,
	`commercial_intent` text DEFAULT '' NOT NULL,
	`creative_theme` text DEFAULT '' NOT NULL,
	`synopsis` text DEFAULT '' NOT NULL,
	`thinking_chain` text DEFAULT '' NOT NULL,
	`shot_commentary` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`submitted_at` text,
	`deleted_at` text,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `annotations_video_author_idx` ON `annotations` (`video_id`,`author_email`);--> statement-breakpoint
CREATE INDEX `annotations_video_status_idx` ON `annotations` (`video_id`,`status`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_object_idx` ON `audit_logs` (`object_type`,`object_id`);--> statement-breakpoint
CREATE TABLE `field_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`annotation_id` text NOT NULL,
	`field_code` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`annotation_id`) REFERENCES `annotations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_answers_annotation_code_idx` ON `field_answers` (`annotation_id`,`field_code`);--> statement-breakpoint
CREATE TABLE `shots` (
	`id` text PRIMARY KEY NOT NULL,
	`annotation_id` text NOT NULL,
	`order_index` integer NOT NULL,
	`group_name` text DEFAULT '' NOT NULL,
	`shot_number` text DEFAULT '' NOT NULL,
	`start_time` text DEFAULT '' NOT NULL,
	`end_time` text DEFAULT '' NOT NULL,
	`shot_size` text DEFAULT '' NOT NULL,
	`camera_angle` text DEFAULT '' NOT NULL,
	`camera_movement` text DEFAULT '' NOT NULL,
	`visual_content` text DEFAULT '' NOT NULL,
	`dialogue` text DEFAULT '' NOT NULL,
	`voiceover` text DEFAULT '' NOT NULL,
	`screen_text` text DEFAULT '' NOT NULL,
	`sound_effect` text DEFAULT '' NOT NULL,
	`music` text DEFAULT '' NOT NULL,
	`creative_comment` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`annotation_id`) REFERENCES `annotations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shots_annotation_order_idx` ON `shots` (`annotation_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_key` text DEFAULT 'AD_VIDEO' NOT NULL,
	`title` text NOT NULL,
	`brand` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'UPLOADING' NOT NULL,
	`rights_confirmed` integer DEFAULT false NOT NULL,
	`created_by_email` text NOT NULL,
	`created_by_name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `videos_status_idx` ON `videos` (`status`);--> statement-breakpoint
CREATE INDEX `videos_created_at_idx` ON `videos` (`created_at`);