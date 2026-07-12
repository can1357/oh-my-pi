/**
 * Capture workflow configuration, resolved from environment variables.
 * See docs/capture-to-agent.md for the full reference and an example .env.
 */
import * as path from "node:path";

import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";

export interface TelegramCaptureConfig {
	enabled: boolean;
	botToken?: string;
	webhookSecret?: string;
	/** Empty set means "deny all" — Telegram access is allowlist-only. */
	allowedChatIds: ReadonlySet<string>;
	/** Optional additional user filter; empty set means "any user in an allowed chat". */
	allowedUserIds: ReadonlySet<string>;
	defaultChatId?: string;
	/** Poll getUpdates instead of relying on an externally reachable webhook. */
	longPollEnabled: boolean;
}

export interface CaptureConfig {
	enabled: boolean;
	/** Root directory for the capture database and screenshot assets. */
	dataDir: string;
	assetRetentionDays: number;
	maxUploadBytes: number;
	defaultAgentRole: string;
	defaultRunnerId?: string;
	globalShortcut: string;
	/** Optional bearer token required on capture HTTP endpoints (in addition to loopback binding). */
	gatewayToken?: string;
	/**
	 * Auto-approve tool executions in capture sessions. Defaults to true because
	 * capture runs are headless (no overlay to answer approval prompts); disable
	 * to reject side-effecting tools instead.
	 */
	autoApprove: boolean;
	telegram: TelegramCaptureConfig;
}

function parseIdList(value: string | undefined): ReadonlySet<string> {
	if (!value) return new Set();
	return new Set(
		value
			.split(",")
			.map(part => part.trim())
			.filter(part => part.length > 0),
	);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === "") return fallback;
	return value === "1" || value.toLowerCase() === "true";
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_ASSET_RETENTION_DAYS = 14;
export const DEFAULT_MAX_UPLOAD_MB = 20;

export function loadCaptureConfig(env: Record<string, string | undefined> = Bun.env): CaptureConfig {
	const botToken = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
	const telegramEnabled = parseBoolean(env.TELEGRAM_CAPTURE_ENABLED, false) && botToken !== undefined;
	return {
		enabled: parseBoolean(env.CAPTURE_ENABLED, true),
		dataDir: env.CAPTURE_DATA_DIR?.trim() || path.join(getAgentDir(), "capture"),
		assetRetentionDays: parsePositiveNumber(env.CAPTURE_ASSET_RETENTION_DAYS, DEFAULT_ASSET_RETENTION_DAYS),
		maxUploadBytes: Math.floor(parsePositiveNumber(env.CAPTURE_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024),
		defaultAgentRole: env.CAPTURE_DEFAULT_AGENT_ROLE?.trim() || "task",
		defaultRunnerId: env.CAPTURE_DEFAULT_RUNNER_ID?.trim() || undefined,
		globalShortcut: env.CAPTURE_GLOBAL_SHORTCUT?.trim() || "Ctrl+Shift+Space",
		gatewayToken: env.CAPTURE_GATEWAY_TOKEN?.trim() || undefined,
		autoApprove: parseBoolean(env.CAPTURE_AUTO_APPROVE, true),
		telegram: {
			enabled: telegramEnabled,
			botToken,
			webhookSecret: env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
			allowedChatIds: parseIdList(env.TELEGRAM_ALLOWED_CHAT_IDS),
			allowedUserIds: parseIdList(env.TELEGRAM_ALLOWED_USER_IDS),
			defaultChatId: env.TELEGRAM_DEFAULT_CHAT_ID?.trim() || undefined,
			longPollEnabled: parseBoolean(env.TELEGRAM_LONG_POLL, true),
		},
	};
}
