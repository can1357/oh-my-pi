import * as path from "node:path";
import { getBaseConfigRoot, slugify } from "@oh-my-pi/pi-utils";
import type { LocalEndpointRegistry } from "../ipc/local-endpoint-registry";
import { sanitizeAgentId } from "../task/name-generator";

export const MAILBOX_PROTOCOL_VERSION = 1;
export const MAILBOX_MAX_BODY_BYTES = 128 * 1024;

export function mailboxRegistryDir(): string {
	return path.join(getBaseConfigRoot(), "run", "irc-peers");
}

export const MAILBOX_REGISTRY: LocalEndpointRegistry = {
	get dir() {
		return mailboxRegistryDir();
	},
	pipePrefix: "omp-irc",
	version: MAILBOX_PROTOCOL_VERSION,
	maxRequestBytes: 1024 * 1024,
	maxResponseBytes: 1024 * 1024,
};

export function mailboxSlug(cwd: string): string {
	return slugify(path.basename(cwd), { maxLength: 32 }) || "omp";
}

export function mailboxAddress(cwd: string, id: string): string {
	return `${mailboxSlug(cwd)}-${id.replaceAll("-", "").slice(-8)}`;
}

export function mailboxConversationSuffix(sessionId: string): string {
	return sessionId.replaceAll("-", "").slice(-8);
}

export const MAILBOX_ADDRESS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}(?:\.[0-9a-f]{8})?$/;

/** Peer aliases reuse local agent-id sanitization and cannot be canonical addresses. */
export function normalizePeerAlias(value: string): string | null {
	if (MAILBOX_ADDRESS_PATTERN.test(value)) return null;
	const alias = sanitizeAgentId(value);
	return alias && !MAILBOX_ADDRESS_PATTERN.test(alias) ? alias : null;
}

export interface MailboxTargetSnapshot {
	conversation: string | null;
	title: string | null;
	busy: boolean;
	alias: string | null;
	/** Conversation workspace; null → use the process cwd. */
	cwd: string | null;
}

export interface MailboxSnapshot {
	address: string;
	id: string;
	pid: number;
	cwd: string;
	startedAt: number;
	targets: MailboxTargetSnapshot[];
}

export type MailboxDeliverError = "invalid_sender" | "unknown_target" | "not_receiving" | "body_too_large";
