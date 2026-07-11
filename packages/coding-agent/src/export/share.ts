/**
 * Session sharing.
 *
 * The session JSON is gzipped and sealed with a fresh AES-256-GCM key
 * (`[12B IV][ciphertext+tag]`, same layout as collab frames), then pushed to
 * one of two stores, chosen by `share.store`:
 *
 *   1. The share server (default — `POST <serverUrl>` → `{"id":"…"}`), capped
 *      at 1 MB; oversized sessions are truncated (images first, then long
 *      strings, then oldest entries) until the sealed blob fits.
 *   2. A secret GitHub gist (`store: "gist"`, when an authenticated `gh`
 *      exists; falls back to the share server) holding base64 of the blob.
 *
 * Either way the link is `<serverUrl>/<id>#<base64url key>`. The viewer page
 * served there fetches the blob (gist ids are hex; server ids never are),
 * decrypts with the fragment key — which never leaves the browser — and
 * renders the same template as `/export`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentState } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@pk-nerdsaver-ai/pi-ai";
import { $which, logger } from "@pk-nerdsaver-ai/pi-utils";
import { DEFAULT_SHARE_URL } from "@pk-nerdsaver-ai/pi-wire";
import { $ } from "bun";
import { obfuscateToolArguments, type SecretObfuscator } from "../secrets/obfuscator";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { OutputMeta } from "../tools/output-meta";
import { buildSessionData, type SessionData, type SubSession } from "./html";

export { DEFAULT_SHARE_URL };

/** Hard cap for blobs accepted by the share server (mirrors relay shareMaxBytes). */
export const SERVER_MAX_SEALED_BYTES = 1_000_000;
/** Gist raw fetches cap at 10 MB; keep base64 (×4/3) comfortably under it. */
const GIST_MAX_SEALED_BYTES = 5_000_000;

const IV_LENGTH = 12;
const SHARE_KEY_BYTES = 32;
/** The viewer picks the gist file by this suffix. */
const GIST_FILENAME = "session.ompshare.txt";
/** Gist ids are hex; the relay never issues pure-hex ids, so the viewer can route on shape. */
const GIST_ID_RE = /^[0-9a-f]{20,64}$/;

/** Progressively harsher per-string caps applied when the sealed blob is over budget. */
const TEXT_CAPS = [32_768, 8_192, 2_048, 512];
/** 1×1 transparent GIF; stands in for stripped data-URL images so <img> tags stay valid. */
const BLANK_IMAGE_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const IMAGE_OMITTED_TEXT = "[image omitted from share]";

export type ShareStore = "blob" | "gist";

export interface ShareSessionOptions {
	/** Share server/viewer base URL; defaults to {@link DEFAULT_SHARE_URL}. */
	serverUrl?: string;
	/**
	 * Where to upload the sealed blob. `"blob"` (default) posts to the share
	 * server; `"gist"` pushes to a secret GitHub gist first (needs an
	 * authenticated `gh`) and falls back to the server.
	 */
	store?: ShareStore;
	/** Agent state for system prompt + tool descriptions in the snapshot. */
	state?: AgentState;
	/**
	 * Redacts the snapshot before sealing via a typed, per-field walk over the
	 * session (header title/cwd, system prompt, tool descriptions, entry summaries,
	 * labels, and message text — including tool-result output and `@file` mentions),
	 * so secrets that landed in persisted entries (tool outputs reading .env, etc.)
	 * never leave the machine. Inline image bytes are preserved (size-trimmed
	 * separately); opaque provider-replay blobs (`providerPayload`,
	 * `redactedThinking`, `compaction.preserveData`) and untyped extension payloads
	 * (`details`/`data`/`outputSchema`) are dropped rather than walked. Pass
	 * undefined to skip redaction entirely.
	 */
	obfuscator?: SecretObfuscator;
}

export interface ShareSessionResult {
	/** Viewer link: `<serverUrl>/<id>#<key>`. */
	url: string;
	method: "gist" | "server";
	/** Underlying gist URL (gist method only). */
	gistUrl?: string;
	/** True when content was trimmed to fit the upload budget. */
	truncated: boolean;
	sealedBytes: number;
}

/** Build the snapshot that gets sealed and uploaded, redacted when an obfuscator is provided. */
export function buildShareSnapshot(sm: SessionManager, options?: ShareSessionOptions): SessionData {
	const data = buildSessionData(sm, options?.state);
	return options?.obfuscator?.hasSecrets() ? redactSessionDataForShare(options.obfuscator, data) : data;
}

/**
 * Redact secrets from a share snapshot. A share blob leaves the machine, so
 * every text-bearing field is rewritten through the obfuscator. The walk is
 * typed end-to-end (no generic object traversal): inline image bytes are left
 * intact (size-trimmed later by {@link stripImagePayloads}) and opaque,
 * untyped payloads we cannot redact field-by-field (`compaction.preserveData`,
 * extension `details`/`data`, `mode_change.data`, structured output schemas)
 * are dropped so they cannot leak.
 */
function redactShareHeader(o: SecretObfuscator, header: SessionHeader | null): SessionHeader | null {
	if (!header) return header;
	return {
		...header,
		title: header.title === undefined ? undefined : o.obfuscate(header.title),
		cwd: o.obfuscate(header.cwd),
	};
}

function redactSessionDataForShare(o: SecretObfuscator, data: SessionData): SessionData {
	return {
		...data,
		header: redactShareHeader(o, data.header),
		systemPrompt: data.systemPrompt === undefined ? undefined : o.obfuscate(data.systemPrompt),
		tools: data.tools?.map(tool => ({ ...tool, description: o.obfuscate(tool.description) })),
		entries: data.entries.map(entry => redactShareEntry(o, entry)),
		subSessions: data.subSessions
			? Object.fromEntries(
					Object.entries(data.subSessions).map(([key, sub]) => [key, redactShareSubSession(o, sub)]),
				)
			: data.subSessions,
	};
}

function redactShareSubSession(o: SecretObfuscator, sub: SubSession): SubSession {
	return {
		...sub,
		header: redactShareHeader(o, sub.header),
		entries: sub.entries.map(entry => redactShareEntry(o, entry)),
	};
}

function redactShareEntry(o: SecretObfuscator, entry: SessionEntry): SessionEntry {
	switch (entry.type) {
		case "message":
			return { ...entry, message: redactShareMessage(o, entry.message) };
		case "compaction":
			return {
				...entry,
				summary: o.obfuscate(entry.summary),
				shortSummary: entry.shortSummary === undefined ? undefined : o.obfuscate(entry.shortSummary),
				details: undefined,
				preserveData: undefined,
			};
		case "branch_summary":
			return { ...entry, summary: o.obfuscate(entry.summary), details: undefined };
		case "custom_message":
			return { ...entry, content: redactShareContent(o, entry.content), details: undefined };
		case "custom":
			return { ...entry, data: undefined };
		case "mode_change":
			return { ...entry, data: undefined };
		case "session_init":
			return {
				...entry,
				systemPrompt: o.obfuscate(entry.systemPrompt),
				task: o.obfuscate(entry.task),
				outputSchema: undefined,
			};
		case "label":
			return { ...entry, label: entry.label === undefined ? undefined : o.obfuscate(entry.label) };
		default:
			return entry;
	}
}

function redactShareContent(
	o: SecretObfuscator,
	content: string | (TextContent | ImageContent)[],
): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return o.obfuscate(content);
	return content.map(block => (block.type === "text" ? { ...block, text: o.obfuscate(block.text) } : block));
}

/** Redact freeform strings in tool output metadata (source path/URL, diagnostics); numeric truncation info is preserved. */
function redactShareOutputMeta(o: SecretObfuscator, meta: OutputMeta | undefined): OutputMeta | undefined {
	if (!meta) return meta;
	return {
		...meta,
		source: meta.source ? { ...meta.source, value: o.obfuscate(meta.source.value) } : meta.source,
		diagnostics: meta.diagnostics
			? {
					summary: o.obfuscate(meta.diagnostics.summary),
					messages: meta.diagnostics.messages.map(message => o.obfuscate(message)),
				}
			: meta.diagnostics,
	};
}

function redactShareMessage(o: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				...message,
				providerPayload: undefined,
				content: redactShareContent(o, message.content),
			} as AgentMessage;
		case "custom":
		case "hookMessage":
			return { ...message, details: undefined, content: redactShareContent(o, message.content) } as AgentMessage;
		case "toolResult":
			return {
				...message,
				details: undefined,
				content: redactShareContent(o, message.content) as (TextContent | ImageContent)[],
			};
		case "assistant":
			// Drop opaque provider-replay state (encrypted reasoning / native history) the viewer
			// never reads and we cannot redact field-by-field: `providerPayload` and any
			// `redactedThinking` blocks.
			return {
				...message,
				providerPayload: undefined,
				errorMessage: message.errorMessage === undefined ? undefined : o.obfuscate(message.errorMessage),
				content: message.content.flatMap((block): AssistantMessage["content"] => {
					if (block.type === "redactedThinking") return [];
					if (block.type === "text") return [{ ...block, text: o.obfuscate(block.text) }];
					if (block.type === "thinking") return [{ ...block, thinking: o.obfuscate(block.thinking) }];
					if (block.type === "toolCall") {
						return [
							{
								...block,
								arguments: obfuscateToolArguments(o, block.arguments),
								intent: block.intent === undefined ? undefined : o.obfuscate(block.intent),
								rawBlock: block.rawBlock === undefined ? undefined : o.obfuscate(block.rawBlock),
							},
						];
					}
					return [block];
				}),
			};
		case "bashExecution":
			return {
				...message,
				command: o.obfuscate(message.command),
				output: o.obfuscate(message.output),
				meta: redactShareOutputMeta(o, message.meta),
			};
		case "pythonExecution":
			return {
				...message,
				code: o.obfuscate(message.code),
				output: o.obfuscate(message.output),
				meta: redactShareOutputMeta(o, message.meta),
			};
		case "branchSummary":
			return { ...message, summary: o.obfuscate(message.summary) };
		case "compactionSummary":
			return {
				...message,
				providerPayload: undefined,
				summary: o.obfuscate(message.summary),
				shortSummary: message.shortSummary === undefined ? undefined : o.obfuscate(message.shortSummary),
				blocks:
					message.blocks === undefined
						? undefined
						: (redactShareContent(o, message.blocks) as (TextContent | ImageContent)[]),
			};
		case "fileMention":
			return {
				...message,
				files: message.files.map(file => ({
					...file,
					path: o.obfuscate(file.path),
					content: o.obfuscate(file.content),
				})),
			};
		default:
			return message;
	}
}

/** Share the session; uploads to the share server unless `options.store` is `"gist"`. */
export async function shareSession(sm: SessionManager, options?: ShareSessionOptions): Promise<ShareSessionResult> {
	const data = buildShareSnapshot(sm, options);
	const keyBytes = new Uint8Array(SHARE_KEY_BYTES);
	crypto.getRandomValues(keyBytes);
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
	const keyText = Buffer.from(keyBytes).toString("base64url");
	const base = normalizeShareServerUrl(options?.serverUrl);

	if (options?.store === "gist") {
		const forGist = await sealToFit(key, data, GIST_MAX_SEALED_BYTES);
		const gist = await tryCreateGist(forGist.sealed);
		if (gist) {
			return {
				url: `${base}/${gist.id}#${keyText}`,
				method: "gist",
				gistUrl: gist.url,
				truncated: forGist.truncated,
				sealedBytes: forGist.sealed.byteLength,
			};
		}
		// gh unusable or gist creation failed — fall back to the share server.
		return shareViaServer(key, data, base, keyText, forGist);
	}

	return shareViaServer(key, data, base, keyText);
}

/** Strip trailing slashes so `<base>/<id>` composes cleanly. */
export function normalizeShareServerUrl(serverUrl?: string): string {
	const base = (serverUrl ?? DEFAULT_SHARE_URL).trim().replace(/\/+$/, "");
	return base || DEFAULT_SHARE_URL;
}

interface SealedSession {
	sealed: Uint8Array<ArrayBuffer>;
	truncated: boolean;
}

/** Seal `data`, trimming content until the sealed blob fits `maxBytes`. Exported for tests. */
export async function sealToFit(key: CryptoKey, data: SessionData, maxBytes: number): Promise<SealedSession> {
	let sealed = await sealSessionData(key, data);
	if (sealed.byteLength <= maxBytes) return { sealed, truncated: false };

	// Work on a deep copy; the caller may re-fit the original at another budget.
	const working = structuredClone(data);
	stripImagePayloads(working);
	sealed = await sealSessionData(key, working);
	if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };

	for (const cap of TEXT_CAPS) {
		capLongStrings(working, cap);
		sealed = await sealSessionData(key, working);
		if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };
	}

	// Last resort: drop oldest entries (orphaned children render as roots).
	while (working.entries.length > 4) {
		working.entries = working.entries.slice(Math.ceil(working.entries.length / 2));
		sealed = await sealSessionData(key, working);
		if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };
	}

	throw new Error(`Session too large to share: ${sealed.byteLength} bytes sealed exceeds the ${maxBytes} byte limit`);
}

/** `[12B IV][AES-256-GCM(gzip(JSON))]` — decrypted and gunzipped by share-loader.js. */
async function sealSessionData(key: CryptoKey, data: SessionData): Promise<Uint8Array<ArrayBuffer>> {
	const compressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(data)));
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressed));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Replace inline image payloads (image blocks + data: URLs) with tiny placeholders, in place. */
function stripImagePayloads(value: unknown): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			if (isRecord(item) && item.type === "image" && typeof item.data === "string" && item.data.length > 1024) {
				value[i] = { type: "text", text: IMAGE_OMITTED_TEXT };
				continue;
			}
			stripImagePayloads(item);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const k in value) {
		const v = value[k];
		if (typeof v === "string") {
			if (v.length > 1024 && v.startsWith("data:")) value[k] = BLANK_IMAGE_DATA_URL;
			continue;
		}
		stripImagePayloads(v);
	}
}

/** Truncate every string longer than `cap`, in place. */
function capLongStrings(value: unknown, cap: number): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			if (typeof item === "string" && item.length > cap) value[i] = `${item.slice(0, cap)}\n…[truncated for share]`;
			else capLongStrings(item, cap);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const k in value) {
		const v = value[k];
		if (typeof v === "string") {
			if (v.length > cap) value[k] = `${v.slice(0, cap)}\n…[truncated for share]`;
			continue;
		}
		capLongStrings(v, cap);
	}
}

/** Create a secret gist holding base64 of the sealed blob; null when `gh` is unusable. */
async function tryCreateGist(sealed: Uint8Array): Promise<{ id: string; url: string } | null> {
	if (!$which("gh")) return null;
	const auth = await $`gh auth status`.quiet().nothrow();
	if (auth.exitCode !== 0) {
		logger.debug("share: gh present but not authenticated; falling back to share server");
		return null;
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-share-"));
	try {
		const file = path.join(dir, GIST_FILENAME);
		await Bun.write(file, Buffer.from(sealed).toString("base64"));
		const result = await $`gh gist create --public=false ${file}`.quiet().nothrow();
		if (result.exitCode !== 0) {
			logger.warn("share: gist creation failed; falling back to share server", {
				stderr: result.stderr.toString("utf-8").trim().slice(0, 500),
			});
			return null;
		}
		const url = result.text().trim().split("\n").pop()?.trim() ?? "";
		const id = url.split("/").pop() ?? "";
		if (!GIST_ID_RE.test(id)) {
			logger.warn("share: could not parse gist id from gh output", { url });
			return null;
		}
		return { id, url };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/** Seal to the server cap (reusing `preFit` when it already fits) and upload. */
async function shareViaServer(
	key: CryptoKey,
	data: SessionData,
	base: string,
	keyText: string,
	preFit?: SealedSession,
): Promise<ShareSessionResult> {
	const forServer =
		preFit && preFit.sealed.byteLength <= SERVER_MAX_SEALED_BYTES
			? preFit
			: await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);
	const id = await uploadToServer(forServer.sealed, base);
	return {
		url: `${base}/${id}#${keyText}`,
		method: "server",
		truncated: forServer.truncated,
		sealedBytes: forServer.sealed.byteLength,
	};
}

/** POST the sealed blob to the share server; returns the assigned id. */
async function uploadToServer(sealed: Uint8Array, base: string): Promise<string> {
	let res: Response;
	try {
		res = await fetch(base, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: sealed,
		});
	} catch (err) {
		throw new Error(`Share upload to ${base} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
		throw new Error(`Share upload to ${base} failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
	}
	const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
	const id = body && typeof body.id === "string" ? body.id : "";
	if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) {
		throw new Error(`Share upload to ${base} failed: server returned no usable id`);
	}
	return id;
}
