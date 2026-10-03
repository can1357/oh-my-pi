import * as path from "node:path";
import { getBaseConfigRoot } from "@oh-my-pi/pi-utils";
import type { LocalEndpointRegistry } from "../ipc/local-endpoint-registry";

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
	maxRequestBytes: 256 * 1024,
	maxResponseBytes: 256 * 1024,
};

export function mailboxSlug(cwd: string): string {
	return (
		path
			.basename(cwd)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32)
			.replace(/-+$/g, "") || "omp"
	);
}

export function mailboxAddress(cwd: string, id: string): string {
	return `${mailboxSlug(cwd)}-${id.replaceAll("-", "").slice(-8)}`;
}

export function mailboxConversationSuffix(sessionId: string): string {
	return sessionId.replaceAll("-", "").slice(-8);
}

export const MAILBOX_ADDRESS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}(?:\.[0-9a-f]{8})?$/;

export interface MailboxTargetSnapshot {
	conversation: string | null;
	title: string | null;
	busy: boolean;
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
