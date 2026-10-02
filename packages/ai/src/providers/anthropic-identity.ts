import * as nodeCrypto from "node:crypto";
import { getInstallId } from "@oh-my-pi/pi-utils";
import { claudeToolPrefix } from "./claude-code-fingerprint";

const CLAUDE_CLOAKING_USER_ID_REGEX =
	/^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a metadata id uses Claude Code's legacy cloaking shape. */
export function isClaudeCloakingUserId(userId: string): boolean {
	return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId);
}

function isClaudeJsonUserId(userId: string): boolean {
	if (userId.length === 0 || userId[0] !== "{") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("session_id" in parsed)) return false;
	return typeof parsed.session_id === "string" && parsed.session_id.length > 0;
}

/** Extract a stable session id from a supported Anthropic metadata user id. */
export function extractClaudeMetadataSessionId(userId: unknown): string | undefined {
	if (typeof userId !== "string") return undefined;
	if (isClaudeCloakingUserId(userId)) {
		return userId.slice(userId.lastIndexOf("_session_") + "_session_".length);
	}
	if (userId.length === 0 || userId[0] !== "{") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("session_id" in parsed)) return undefined;
	const sessionId = parsed.session_id;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/** Generate a legacy Claude Code cloaking metadata id. */
export function generateClaudeCloakingUserId(): string {
	const userHash = nodeCrypto.randomBytes(32).toString("hex");
	const accountId = nodeCrypto.randomUUID().toLowerCase();
	const sessionId = nodeCrypto.randomUUID().toLowerCase();
	return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "omp-claude-device-id-v1:";
const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "omp-claude-device-id-v2";

/** Derive the stable Claude device id for an installation and optional account. */
export function deriveClaudeDeviceId(installId: string, accountId?: string): string {
	const hash = new Bun.SHA256();
	if (accountId && accountId.length > 0) {
		return hash
			.update(CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN)
			.update("\0")
			.update(installId)
			.update("\0")
			.update(accountId)
			.digest("hex");
	}
	return hash.update(CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN).update(installId).digest("hex");
}

/** Read a non-empty string from provider metadata. */
export function readAnthropicMetadataString(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve the account id aliases accepted in Anthropic request metadata. */
export function readAnthropicMetadataAccountId(metadata: Record<string, unknown> | undefined): string | undefined {
	return (
		readAnthropicMetadataString(metadata, "account_uuid") ??
		readAnthropicMetadataString(metadata, "accountId") ??
		readAnthropicMetadataString(metadata, "account_id")
	);
}

function deriveClaudeDeviceIdFromInstallId(accountId?: string): string {
	return deriveClaudeDeviceId(getInstallId(), accountId);
}

function generateClaudeJsonUserId(sessionId?: string, accountId?: string): string {
	const userId: Record<string, string> = {
		device_id: deriveClaudeDeviceIdFromInstallId(accountId),
		session_id: sessionId ?? nodeCrypto.randomUUID().toLowerCase(),
	};
	if (accountId && accountId.length > 0) userId.account_uuid = accountId;
	return JSON.stringify(userId);
}

/** Resolve the provider-facing metadata user id for API-key or OAuth requests. */
export function resolveAnthropicMetadataUserId(
	userId: unknown,
	isOAuthToken: boolean,
	sessionId?: string,
	accountId?: string,
): string | undefined {
	if (typeof userId === "string") {
		if (!isOAuthToken || isClaudeCloakingUserId(userId) || isClaudeJsonUserId(userId)) {
			return userId;
		}
	}

	if (!isOAuthToken) return undefined;
	return generateClaudeJsonUserId(sessionId, accountId);
}

const ANTHROPIC_BUILTIN_TOOL_NAMES: Record<string, true> = {
	web_search: true,
	code_execution: true,
	text_editor: true,
	computer: true,
};

/** Apply Claude Code's wire-only tool prefix. */
export const applyClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (Object.hasOwn(ANTHROPIC_BUILTIN_TOOL_NAMES, name.toLowerCase())) return name;
	return `${claudeToolPrefix}${name}`;
};

/** Remove one Claude Code wire-only tool prefix. */
export const stripClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (!name.toLowerCase().startsWith(claudeToolPrefix.toLowerCase())) return name;
	return name.slice(claudeToolPrefix.length);
};
