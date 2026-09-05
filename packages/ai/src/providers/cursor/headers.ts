import { Buffer } from "node:buffer";
import { arch, platform } from "node:process";
import { CURSOR_IDE_COMMIT, CURSOR_IDE_VERSION, type CursorMachineIdentity } from "./identity";

export const RUN_INFERENCE_PATH = "/aiserver.v1.InferenceService/RunInference";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HTTP2_FORBIDDEN_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"http2-settings",
]);
const CURSOR_RESERVED_HEADERS = new Set([
	"authorization",
	"connect-accept-encoding",
	"connect-content-encoding",
	"connect-protocol-version",
	"content-length",
	"content-type",
	"cookie",
	"host",
	"te",
	"user-agent",
	"x-amzn-trace-id",
	"x-client-key",
	"x-cursor-checksum",
	"x-cursor-client-arch",
	"x-cursor-client-commit",
	"x-cursor-client-device-type",
	"x-cursor-client-os",
	"x-cursor-client-type",
	"x-cursor-client-version",
	"x-cursor-streaming",
	"x-cursor-timezone",
	"x-ghost-mode",
	"x-new-onboarding-completed",
	"x-request-id",
]);

export interface CursorInferenceHeaderOptions {
	readonly token: string;
	readonly ghostMode: boolean;
	readonly identity: CursorMachineIdentity;
	readonly requestId: string;
	readonly clientKey: string;
	readonly callerHeaders?: Record<string, string>;
	readonly nowMs?: number;
	readonly timezone?: string;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
}

function assertHeaderValue(name: string, value: string): void {
	if (value.includes("\r") || value.includes("\n")) throw new Error(`${name} contains a line break`);
}

export function sanitizeCursorCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const field = name.toLowerCase();
		if (field.startsWith(":")) continue;
		if (HTTP2_FORBIDDEN_HEADERS.has(field) || CURSOR_RESERVED_HEADERS.has(field)) continue;
		assertHeaderValue(`Cursor caller header ${field}`, value);
		sanitized[field] = value;
	}
	return sanitized;
}

/** Cursor 3.18.9's six-byte minute checksum, including JavaScript shift semantics. */
export function cursorChecksum(identity: CursorMachineIdentity, nowMs = Date.now()): string {
	const minute = Math.floor(nowMs / 1_000_000);
	const bytes = new Uint8Array([
		(minute >> 40) & 255,
		(minute >> 32) & 255,
		(minute >> 24) & 255,
		(minute >> 16) & 255,
		(minute >> 8) & 255,
		minute & 255,
	]);
	let previous = 165;
	for (let index = 0; index < bytes.length; index++) {
		const current = bytes[index];
		if (current === undefined) throw new Error("Cursor checksum input is incomplete");
		bytes[index] = ((current ^ previous) + (index % 256)) & 255;
		previous = bytes[index] ?? previous;
	}
	const prefix = Buffer.from(bytes).toString("base64");
	return identity.macMachineId === undefined
		? `${prefix}${identity.machineId}`
		: `${prefix}${identity.machineId}/${identity.macMachineId}`;
}

/** Exact application headers used by the pinned Cursor IDE managed-inference control. */
export function inferenceRequestHeaders(options: CursorInferenceHeaderOptions): Record<string, string> {
	assertHeaderValue("Cursor credential", options.token);
	assertHeaderValue("Cursor request id", options.requestId);
	assertHeaderValue("Cursor client key", options.clientKey);
	const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	assertHeaderValue("Cursor timezone", timezone);
	if (!/^[0-9a-f]{64}$/u.test(options.clientKey)) throw new Error("Cursor client key must be 32-byte lowercase hex");
	if (!UUID_PATTERN.test(options.requestId)) throw new Error("Cursor request id must be a UUID");
	return {
		...sanitizeCursorCallerHeaders(options.callerHeaders),
		":method": "POST",
		":path": RUN_INFERENCE_PATH,
		authorization: `Bearer ${options.token}`,
		cookie: `CursorCookie=Cookie-${options.token.slice(0, 15)}`,
		"connect-accept-encoding": "gzip",
		"connect-content-encoding": "gzip",
		"connect-protocol-version": "1",
		"content-type": "application/connect+proto",
		"user-agent": "connect-es/1.6.1",
		"x-amzn-trace-id": `Root=${options.requestId}`,
		"x-client-key": options.clientKey,
		"x-cursor-checksum": cursorChecksum(options.identity, options.nowMs),
		"x-cursor-client-arch": options.arch ?? arch,
		"x-cursor-client-commit": CURSOR_IDE_COMMIT,
		"x-cursor-client-device-type": "desktop",
		"x-cursor-client-os": options.platform ?? platform,
		"x-cursor-client-type": "ide",
		"x-cursor-client-version": CURSOR_IDE_VERSION,
		"x-cursor-streaming": "true",
		"x-cursor-timezone": timezone,
		"x-ghost-mode": String(options.ghostMode),
		"x-new-onboarding-completed": "false",
		"x-request-id": options.requestId,
	};
}
