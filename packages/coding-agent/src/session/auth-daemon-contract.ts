import { isAbsolute } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";
import { listProvidersWithEnvKey } from "@oh-my-pi/pi-ai/env-api-key";
import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry";
import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import { isRecord } from "@oh-my-pi/pi-utils";

export const AUTH_DAEMON_KIND = "auth";
export const AUTH_DAEMON_VERSION = 1;
export const AUTH_DAEMON_KEY = "store";
export const AUTH_DAEMON_METHOD_LENGTH = 128;

/** Built-in model and auth-only providers; extension credentials stay with their callbacks. */
export const AUTH_DAEMON_PROVIDERS: ReadonlySet<string> = new Set([
	...PROVIDER_REGISTRY.map(provider => provider.id),
	...authProviders().map(provider => provider.id),
	...listProvidersWithEnvKey(),
]);

/** Only sent as the first frame of the native IPC tunnel, never on the control connection. */
export interface AuthDaemonBinding {
	dbPath: string;
	encrypt: boolean | "auto";
	broker: null | {
		url: string;
		token: string;
		cachePath: string;
		ttlMs: number;
		accountPool: { provider: string; accounts?: string[]; apiKeys?: boolean }[];
	};
	retryUnreachableBroker: boolean;
	accountPolicies: AuthAccountPolicies;
	defaultReservePct: number;
	unpausedProviders: string[];
}

const AccountSelector = type({
	"email?": "string > 0",
	"accountId?": "string > 0",
	"projectId?": "string > 0",
	"orgId?": "string > 0",
	"+": "reject",
});
const FiniteNumber = type("number").narrow(Number.isFinite);
const AccountPolicy = type({
	provider: "string > 0",
	account: AccountSelector,
	"priority?": FiniteNumber,
	"reservePct?": "0 <= number <= 100",
	"reclaimAbovePct?": FiniteNumber,
	"+": "reject",
});
const AccountPoolEntry = type({
	provider: "string > 0",
	"accounts?": "string[]",
	"apiKeys?": "boolean",
	"+": "reject",
});
const BrokerBinding = type({
	url: "string > 0",
	token: "string > 0",
	cachePath: "string",
	ttlMs: type("number >= 0").narrow(Number.isFinite),
	accountPool: AccountPoolEntry.array(),
	"+": "reject",
});
const Binding = type({
	dbPath: "string > 0",
	encrypt: "boolean | 'auto'",
	broker: BrokerBinding.or("null"),
	retryUnreachableBroker: "boolean",
	accountPolicies: AccountPolicy.array(),
	defaultReservePct: FiniteNumber,
	unpausedProviders: type("1 <= string <= 128")
		.array()
		.narrow(providers => providers.length <= 128),
	"+": "reject",
});

export function parseAuthDaemonBinding(value: unknown): AuthDaemonBinding | undefined {
	const binding = Binding(value);
	// Schema errors can contain the rejected secret-bearing input; never relay or log them.
	if (
		binding instanceof type.errors ||
		!isAbsolute(binding.dbPath) ||
		(binding.broker !== null && binding.broker.ttlMs > 0 && !isAbsolute(binding.broker.cachePath))
	) {
		return undefined;
	}
	return binding;
}

export type AuthDaemonPacket =
	| { type: "bind"; id: number; binding: AuthDaemonBinding }
	| { type: "request"; id: number; method: string; params?: unknown };

export type AuthDaemonIncoming =
	| { type: "bind"; id: number; binding: unknown }
	| Extract<AuthDaemonPacket, { type: "request" }>;

export type AuthDaemonReply =
	| { type: "bound"; id: number }
	| { type: "bind-error"; id: number; kind: "config" | "storage" }
	| { type: "bind-error"; id: number; kind: "broker"; status?: number }
	| { type: "result"; id: number; value: unknown }
	| { type: "request-error"; id: number; kind: "unknown-method" | "failed" };

export type AuthDaemonDownPacket = AuthDaemonReply | { event: "generation" };

function hasEnvelope(value: unknown): value is Record<string, unknown> & { id: number } {
	return isRecord(value) && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0;
}

export function parseAuthDaemonPacket(value: unknown): AuthDaemonIncoming | undefined {
	if (!hasEnvelope(value)) return undefined;
	const fields = Object.keys(value).length;
	if (value.type === "bind" && fields === 3 && Object.hasOwn(value, "binding")) {
		return { type: "bind", id: value.id, binding: value.binding };
	}
	if (
		value.type === "request" &&
		typeof value.method === "string" &&
		value.method.length > 0 &&
		value.method.length <= AUTH_DAEMON_METHOD_LENGTH &&
		(fields === 3 || (fields === 4 && Object.hasOwn(value, "params")))
	) {
		return { type: "request", id: value.id, method: value.method, params: value.params };
	}
	return undefined;
}

/** Hybrid auth stores negate local row IDs to distinguish them from broker rows. */
export function isAuthDaemonCredentialId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
}

/** Maximum caller-supplied session ID length before adding the lease's private namespace. */
export const MAX_AUTH_DAEMON_SESSION_ID_LENGTH = 1024;

export function isAuthDaemonHttpStatus(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

export function parseAuthDaemonDownPacket(value: unknown): AuthDaemonDownPacket | undefined {
	if (isRecord(value) && value.event === "generation" && Object.keys(value).length === 1) {
		return { event: "generation" };
	}
	if (!hasEnvelope(value)) return undefined;
	const { type, id, kind, status } = value;
	const fields = Object.keys(value).length;
	switch (type) {
		case "bound":
			return fields === 2 ? { type, id } : undefined;
		case "bind-error":
			if ((kind === "config" || kind === "storage") && fields === 3) return { type, id, kind };
			if (kind === "broker") {
				if (fields === 3) return { type, id, kind };
				if (fields === 4 && isAuthDaemonHttpStatus(status)) return { type, id, kind, status };
			}
			return undefined;
		case "result":
			return fields === 3 && Object.hasOwn(value, "value") ? { type, id, value: value.value } : undefined;
		case "request-error":
			return fields === 3 && (kind === "unknown-method" || kind === "failed") ? { type, id, kind } : undefined;
		default:
			return undefined;
	}
}

const MAX_FRAME_BYTES = 1024 * 1024;
export const AUTH_DAEMON_QUEUE_BYTES = 2 * MAX_FRAME_BYTES;
export const AUTH_DAEMON_QUEUE_LENGTH = 32;
/** Above the broker's own 30s initial snapshot retry budget. */
export const AUTH_DAEMON_BIND_TIMEOUT_MS = 60_000;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeAuthDaemonFrame(packet: AuthDaemonPacket | AuthDaemonDownPacket): Uint8Array {
	const json = JSON.stringify(packet);
	if (Buffer.byteLength(json) > MAX_FRAME_BYTES) throw new Error("Daemon auth frame exceeds its byte limit");
	return Buffer.from(`${json}\n`);
}

/** Delimited UTF-8 JSON; bound a partial frame before growing the buffer. */
export class AuthDaemonFrameDecoder {
	#partial = new Uint8Array(0);
	#length = 0;

	push(chunk: Uint8Array, onFrame: (value: unknown, size: number) => boolean): void {
		const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		let offset = 0;
		while (offset < bytes.length) {
			const end = bytes.indexOf(0x0a, offset);
			const part = bytes.subarray(offset, end === -1 ? bytes.length : end);
			const size = this.#length + part.length;
			if (size > MAX_FRAME_BYTES) throw new Error("Daemon auth frame exceeds its byte limit");
			if (end === -1 || this.#length > 0) {
				if (size > this.#partial.length) {
					const grown = new Uint8Array(Math.min(MAX_FRAME_BYTES, Math.max(size, this.#partial.length * 2)));
					grown.set(this.#partial.subarray(0, this.#length));
					this.#partial = grown;
				}
				this.#partial.set(part, this.#length);
				this.#length = size;
				if (end === -1) return;
			}
			const frame = this.#length > 0 ? this.#partial.subarray(0, size) : part;
			this.#length = 0;
			if (!onFrame(JSON.parse(decoder.decode(frame)), size)) return;
			offset = end + 1;
		}
	}

	clear(): void {
		this.#partial = new Uint8Array(0);
		this.#length = 0;
	}
}
