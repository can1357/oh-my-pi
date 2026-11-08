import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Protocol } from "devtools-protocol";
import type { CDPSession, Frame, Page } from "puppeteer-core";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_SUMMARY_DESCRIPTION_BYTES = 160;
const MAX_SUMMARY_TOOLS = 16;
const MAX_EVENTS = 256;

const NO_WEBMCP_DOMAIN =
	"This browser has no native WebMCP: its DevTools protocol lacks the WebMCP domain (Chrome 147 lists page tools, Chrome 149 and newer also invoke them).";
const NO_WEBMCP_INVOKE = "This Chrome lists WebMCP tools but cannot invoke them; invoking needs Chrome 149 or newer.";
const WEBMCP_NOT_EXPOSED =
	"Chrome does not expose WebMCP to this page. It needs a secure context (https or localhost) and either the site's WebMCP origin trial or Chrome started with --enable-features=WebMCP (chrome://flags/#enable-webmcp-testing).";

/** Filters for WebMCP tool discovery. */
export interface WebMcpListOptions {
	/** Return full metadata only for tools with this exact name. */
	name?: string;
	/** Restrict discovery to one frame id. */
	frame?: string;
}

/** Options for invoking a WebMCP tool. */
export interface WebMcpInvokeOptions {
	/** Restrict invocation to one frame id. */
	frame?: string;
	/** Invocation timeout in milliseconds. */
	timeout?: number;
}

/** Options for reading the WebMCP catalog change log. */
export interface WebMcpEventsOptions {
	/** Return events whose sequence is greater than this cursor. */
	since?: number;
	/** Clear retained events after reading them. */
	clear?: boolean;
}

/** One untrusted page-provided WebMCP tool description. */
export interface WebMcpToolRecord {
	/** Page-defined tool name. */
	name: string;
	/** Page-defined tool description. */
	description: string;
	/** CDP identifier of the frame that owns the tool. */
	frameId: string;
	/** Origin of the owning frame. */
	origin: string;
	/** Page-defined JSON Schema, included only for exact-name discovery. */
	inputSchema?: unknown;
	/** Page-defined tool annotations, included only for exact-name discovery. */
	annotations?: unknown;
	/** Marks every page-provided field as untrusted content. */
	untrusted: true;
}

/** WebMCP discovery result. */
export interface WebMcpListResult {
	/** Whether Chrome exposes native WebMCP to the page. */
	status: "ready" | "unavailable";
	/** Matching page-provided tools. */
	tools: WebMcpToolRecord[];
	/** Whether the bounded summary omitted or shortened metadata. */
	truncated: boolean;
	/** Why Chrome offers the page no WebMCP, and what turns it on. */
	reason?: string;
	/** Marks every page-provided field as untrusted content. */
	untrusted: true;
}

/** Successful WebMCP invocation result. */
export interface WebMcpInvokeSuccess {
	/** Indicates successful page-tool execution. */
	ok: true;
	/** JSON-cloneable page-provided result. */
	result: unknown;
	/** Whether an oversized page result was represented by a preview. */
	truncated?: boolean;
	/** Original encoded result size when truncated. */
	originalBytes?: number;
	/** Marks the page-provided result as untrusted content. */
	untrusted: true;
}

/** Failed WebMCP invocation result. */
export interface WebMcpInvokeFailure {
	/** Indicates failed page-tool execution. */
	ok: false;
	/** Delimited page-provided or invocation error text. */
	error: string;
	/** Marks the error text as untrusted content. */
	untrusted: true;
}

/** Result of invoking one page-provided WebMCP tool. */
export type WebMcpInvokeResult = WebMcpInvokeSuccess | WebMcpInvokeFailure;

/** One catalog transition observed while polling WebMCP state. */
export interface WebMcpCatalogEvent {
	/** Monotonic per-tab event sequence. */
	sequence: number;
	/** Catalog transition kind. */
	type: "registered" | "updated" | "unregistered";
	/** Page-defined tool name. */
	name: string;
	/** CDP identifier of the owning frame. */
	frameId: string;
	/** Origin of the owning frame. */
	origin: string;
	/** Host timestamp when polling observed the transition. */
	timestamp: number;
	/** Marks page-provided event fields as untrusted content. */
	untrusted: true;
}

/** WebMCP catalog events newer than the requested cursor. */
export interface WebMcpEventsResult {
	/** Matching catalog transitions. */
	events: WebMcpCatalogEvent[];
	/** Latest per-tab event sequence. */
	cursor: number;
	/** Whether older retained events were omitted. */
	truncated: boolean;
	/** Marks page-provided event fields as untrusted content. */
	untrusted: true;
}

interface IdentifiedFrame extends Frame {
	_id: string;
}

type CatalogEntry = WebMcpToolRecord & {
	/** CDP session of the frame that registered the tool. */
	session: CDPSession;
};

function frameId(frame: Frame): string {
	const id = (frame as IdentifiedFrame)._id;
	return typeof id === "string" && id.length > 0 ? id : frame.url();
}

function originForUrl(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "null";
	}
}

function untrustedBoundary(value: string): string {
	const nonce = crypto.randomUUID();
	const bounded = truncateHeadBytes(value, Math.floor(MAX_RESULT_BYTES / 2)).text;
	return `[BEGIN UNTRUSTED WEBMCP CONTENT ${nonce}]\n${bounded}\n[END UNTRUSTED WEBMCP CONTENT ${nonce}]`;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Whether `method` failed because the browser does not implement it. Chrome's method-not-found message names the
 * method; other failures of the same command can also say "wasn't found" about a frame or tool.
 */
function isMissingCommand(error: unknown, method: string): boolean {
	return error instanceof Error && error.message.includes(`'${method}' wasn't found`);
}

function boundedResult(value: unknown): WebMcpInvokeSuccess {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new Error(`WebMCP result is not JSON-serializable: ${errorText(error)}`);
	}
	if (encoded === undefined) encoded = "null";
	const bytes = Buffer.byteLength(encoded, "utf8");
	if (bytes <= MAX_RESULT_BYTES) {
		return { ok: true, result: JSON.parse(encoded) as unknown, untrusted: true };
	}
	const preview = truncateHeadBytes(encoded, Math.floor(MAX_RESULT_BYTES / 4)).text;
	return {
		ok: true,
		result: {
			preview: untrustedBoundary(preview),
			truncated: true,
			originalBytes: bytes,
		},
		truncated: true,
		originalBytes: bytes,
		untrusted: true,
	};
}

/**
 * The tools registered in the root frame of one CDP session, or `undefined` when the browser has no WebMCP domain.
 * `WebMCP.enable` replays the root frame's tools as `toolsAdded` before it answers, also on a session where the
 * domain is already enabled, so each call reads the current registrations, back/forward cache restores included.
 */
async function rootFrameTools(
	session: CDPSession,
	signal: AbortSignal | undefined,
): Promise<Protocol.WebMCP.Tool[] | undefined> {
	const tools: Protocol.WebMCP.Tool[] = [];
	const onAdded = (event: Protocol.WebMCP.ToolsAddedEvent): void => {
		tools.push(...event.tools);
	};
	session.on("WebMCP.toolsAdded", onAdded);
	try {
		await untilAborted(signal, () => session.send("WebMCP.enable"));
		return tools;
	} catch (error) {
		if (isMissingCommand(error, "WebMCP.enable")) return undefined;
		throw error;
	} finally {
		session.off("WebMCP.toolsAdded", onAdded);
	}
}

/** Invoke one tool through Chrome's WebMCP domain and wait for its response; aborting cancels the invocation. */
async function invokeNative(
	entry: CatalogEntry,
	input: object,
	signal: AbortSignal | undefined,
): Promise<Protocol.WebMCP.ToolRespondedEvent> {
	signal?.throwIfAborted();
	const { session } = entry;
	const early = new Map<string, Protocol.WebMCP.ToolRespondedEvent>();
	const { promise, resolve } = Promise.withResolvers<Protocol.WebMCP.ToolRespondedEvent>();
	let invocationId: string | undefined;
	const onResponded = (event: Protocol.WebMCP.ToolRespondedEvent): void => {
		if (invocationId === undefined) early.set(event.invocationId, event);
		else if (event.invocationId === invocationId) resolve(event);
	};
	session.on("WebMCP.toolResponded", onResponded);
	try {
		({ invocationId } = await session.send("WebMCP.invokeTool", {
			frameId: entry.frameId,
			toolName: entry.name,
			input,
		}));
		const id = invocationId;
		try {
			// An abort while the invocation was being started still cancels it once its id is known.
			signal?.throwIfAborted();
			return early.get(id) ?? (await untilAborted(signal, promise));
		} catch (error) {
			if (signal?.aborted) {
				await session.send("WebMCP.cancelInvocation", { invocationId: id }).catch(() => undefined);
			}
			throw error;
		}
	} finally {
		session.off("WebMCP.toolResponded", onResponded);
	}
}

/**
 * Per-tab WebMCP discovery, invocation, and catalog-event controller over Chrome's native WebMCP DevTools domain.
 * Construction only listens to the WebMCP events Puppeteer enables on the tab's session when it attaches; nothing
 * reaches the page until a call, which enables the domain on every CDP session serving the tab's frames.
 */
export class WebMcpController {
	readonly #page: Page;
	/** Tools announced on watched sessions, for frames `WebMCP.enable` does not replay. */
	readonly #announced = new Map<string, { tool: Protocol.WebMCP.Tool; session: CDPSession }>();
	/** Watched sessions and how to stop listening to each. */
	readonly #watched = new Map<CDPSession, () => void>();
	#catalog = new Map<string, CatalogEntry>();
	#events: WebMcpCatalogEvent[] = [];
	#sequence = 0;
	#droppedThrough = 0;

	constructor(page: Page) {
		this.#page = page;
		this.#watch(page.mainFrame().client);
	}

	/** Follow one session's tool announcements; Chrome replays only a session's root frame on `WebMCP.enable`. */
	#watch(session: CDPSession): void {
		if (this.#watched.has(session)) return;
		const onAdded = (event: Protocol.WebMCP.ToolsAddedEvent): void => {
			for (const tool of event.tools) this.#announced.set(`${tool.frameId}\u0000${tool.name}`, { tool, session });
		};
		const onRemoved = (event: Protocol.WebMCP.ToolsRemovedEvent): void => {
			for (const tool of event.tools) {
				const key = `${tool.frameId}\u0000${tool.name}`;
				if (this.#announced.get(key)?.session === session) this.#announced.delete(key);
			}
		};
		const forgetFrame = (frameId: string): void => {
			for (const [key, announced] of this.#announced) {
				if (announced.session === session && announced.tool.frameId === frameId) this.#announced.delete(key);
			}
		};
		// Chrome announces no removal when a frame loads another document; that document's tools follow this event.
		const onNavigated = (event: Protocol.Page.FrameNavigatedEvent): void => {
			if (event.type === "Navigation") forgetFrame(event.frame.id);
		};
		// Nor when a frame goes away, as a same-process iframe does when its parent navigates.
		const onDetached = (event: Protocol.Page.FrameDetachedEvent): void => forgetFrame(event.frameId);
		session.on("WebMCP.toolsAdded", onAdded);
		session.on("WebMCP.toolsRemoved", onRemoved);
		session.on("Page.frameNavigated", onNavigated);
		session.on("Page.frameDetached", onDetached);
		this.#watched.set(session, () => {
			session.off("WebMCP.toolsAdded", onAdded);
			session.off("WebMCP.toolsRemoved", onRemoved);
			session.off("Page.frameNavigated", onNavigated);
			session.off("Page.frameDetached", onDetached);
		});
	}

	/** Discover page-provided tools, omitting schemas unless an exact name is requested. */
	async list(options: WebMcpListOptions = {}, signal?: AbortSignal): Promise<WebMcpListResult> {
		const unavailable = await this.#refreshCatalog(signal);
		const availability = unavailable
			? { status: "unavailable" as const, reason: unavailable }
			: { status: "ready" as const };
		let entries = [...this.#catalog.values()];
		if (options.name !== undefined) entries = entries.filter(tool => tool.name === options.name);
		if (options.frame !== undefined) entries = entries.filter(tool => tool.frameId === options.frame);
		entries.sort((left, right) => left.name.localeCompare(right.name) || left.frameId.localeCompare(right.frameId));

		if (options.name !== undefined) {
			return {
				...availability,
				tools: entries.map(entry => this.#publicRecord(entry, true)),
				truncated: false,
				untrusted: true,
			};
		}

		const tools: WebMcpToolRecord[] = [];
		let bytes = 128;
		let truncated = false;
		for (const entry of entries) {
			if (tools.length >= MAX_SUMMARY_TOOLS) {
				truncated = true;
				break;
			}
			const description = truncateHeadBytes(entry.description, MAX_SUMMARY_DESCRIPTION_BYTES).text;
			if (description !== entry.description) truncated = true;
			const record: WebMcpToolRecord = {
				name: entry.name,
				description,
				frameId: entry.frameId,
				origin: entry.origin,
				untrusted: true,
			};
			const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
			if (bytes + recordBytes > MAX_SUMMARY_BYTES) {
				truncated = true;
				continue;
			}
			bytes += recordBytes;
			tools.push(record);
		}
		if (tools.length < entries.length) truncated = true;
		return {
			...availability,
			tools,
			truncated,
			untrusted: true,
		};
	}

	/** Invoke one page-provided tool and return a bounded JSON-cloneable result; aborting cancels the invocation. */
	async invoke(
		name: string,
		params: unknown,
		options: WebMcpInvokeOptions = {},
		signal?: AbortSignal,
	): Promise<WebMcpInvokeResult> {
		const unavailable = await this.#refreshCatalog(signal);
		if (unavailable) throw new ToolError(unavailable);
		const matches = [...this.#catalog.values()].filter(
			tool => tool.name === name && (options.frame === undefined || tool.frameId === options.frame),
		);
		if (matches.length === 0) {
			return {
				ok: false,
				error: untrustedBoundary(
					`No WebMCP tool named ${JSON.stringify(name)}${options.frame ? ` in frame ${JSON.stringify(options.frame)}` : ""}`,
				),
				untrusted: true,
			};
		}
		if (matches.length > 1) {
			return {
				ok: false,
				error: untrustedBoundary(
					`WebMCP tool ${JSON.stringify(name)} exists in multiple frames: ${matches.map(tool => tool.frameId).join(", ")}`,
				),
				untrusted: true,
			};
		}
		try {
			const response = await invokeNative(matches[0]!, this.#cloneInput(params), signal);
			if (response.status !== "Completed") {
				// Chrome reports a thrown page error with an empty `errorText` and the exception beside it.
				const error =
					response.errorText || response.exception?.description || `WebMCP invocation ${response.status}`;
				return { ok: false, error: untrustedBoundary(error), untrusted: true };
			}
			return boundedResult(response.output);
		} catch (error) {
			if (signal?.aborted) throw error;
			if (isMissingCommand(error, "WebMCP.invokeTool")) throw new ToolError(NO_WEBMCP_INVOKE);
			return { ok: false, error: untrustedBoundary(errorText(error)), untrusted: true };
		}
	}

	/** Poll catalog transitions observed since a prior cursor. */
	async events(options: WebMcpEventsOptions = {}, signal?: AbortSignal): Promise<WebMcpEventsResult> {
		await this.#refreshCatalog(signal);
		const since = typeof options.since === "number" && Number.isFinite(options.since) ? options.since : 0;
		const events = this.#events.filter(event => event.sequence > since);
		const truncated = since < this.#droppedThrough;
		const result = { events, cursor: this.#sequence, truncated, untrusted: true as const };
		if (options.clear) {
			this.#events = [];
			this.#droppedThrough = 0;
		}
		return result;
	}

	/** Stop following the tab's WebMCP announcements. */
	async dispose(): Promise<void> {
		for (const stop of this.#watched.values()) stop();
		this.#watched.clear();
		this.#announced.clear();
		this.#catalog.clear();
		this.#events = [];
		this.#droppedThrough = 0;
	}

	#publicRecord(entry: CatalogEntry, full: boolean): WebMcpToolRecord {
		return {
			name: entry.name,
			description: entry.description,
			frameId: entry.frameId,
			origin: entry.origin,
			...(full && entry.inputSchema !== undefined ? { inputSchema: entry.inputSchema } : {}),
			...(full && entry.annotations !== undefined ? { annotations: entry.annotations } : {}),
			untrusted: true,
		};
	}

	#cloneInput(params: unknown): object {
		if (params === undefined) return {};
		if (params === null || typeof params !== "object" || Array.isArray(params)) {
			throw new TypeError("WebMCP params must be a JSON object");
		}
		const encoded = JSON.stringify(params);
		if (encoded === undefined) throw new TypeError("WebMCP params must be JSON-serializable");
		const clone = JSON.parse(encoded) as unknown;
		if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
			throw new TypeError("WebMCP params must remain a JSON object after serialization");
		}
		return clone;
	}

	/** Re-read the native catalog, record its transitions, and return why the page can have no tools, if it can't. */
	async #refreshCatalog(signal: AbortSignal | undefined): Promise<string | undefined> {
		const page = this.#page;
		const frames = page.frames();
		const framesById = new Map(frames.map(frame => [frameId(frame), frame]));
		const mainSession = page.mainFrame().client;
		// Cross-origin iframes run in their own process and register their tools on their own session.
		const sessions = [...new Set([mainSession, ...frames.map(frame => frame.client)])];
		for (const session of sessions) this.#watch(session);
		// A session that serves no frame now (a removed or process-swapped iframe) is let go with its tools.
		const live = new Set(sessions);
		for (const [session, stop] of this.#watched) {
			if (live.has(session)) continue;
			stop();
			this.#watched.delete(session);
			for (const [key, announced] of this.#announced) if (announced.session === session) this.#announced.delete(key);
		}
		const reads = await Promise.allSettled(sessions.map(session => rootFrameTools(session, signal)));
		signal?.throwIfAborted();
		const main = reads[0]!;
		if (main.status === "rejected") throw main.reason;
		if (main.value === undefined) {
			this.#catalog.clear();
			return NO_WEBMCP_DOMAIN;
		}

		const next = new Map<string, CatalogEntry>();
		const add = (tool: Protocol.WebMCP.Tool, session: CDPSession): void => {
			const frame = framesById.get(tool.frameId);
			next.set(`${tool.frameId}\u0000${tool.name}`, {
				name: tool.name,
				description: tool.description,
				frameId: tool.frameId,
				origin: frame ? originForUrl(frame.url()) : "null",
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
				untrusted: true,
				session,
			});
		};
		sessions.forEach((session, index) => {
			const read = reads[index]!;
			if (read.status === "rejected") return;
			for (const tool of read.value ?? []) add(tool, session);
		});
		for (const { tool, session } of this.#announced.values()) {
			const frame = framesById.get(tool.frameId);
			const parent = frame?.parentFrame();
			if (parent && parent.client === session && frame?.client === session) add(tool, session);
		}

		for (const [key, entry] of next) {
			const previous = this.#catalog.get(key);
			if (!previous) this.#recordEvent("registered", entry);
			else if (this.#entryFingerprint(previous) !== this.#entryFingerprint(entry))
				this.#recordEvent("updated", entry);
		}
		for (const [key, entry] of this.#catalog) {
			if (!next.has(key)) this.#recordEvent("unregistered", entry);
		}
		this.#catalog = next;
		if (next.size > 0) return undefined;
		// omp's Puppeteer evaluates in its isolated world, where `in` sees the platform API without creating the
		// page's context or reading anything the page defined.
		const exposed = await untilAborted(signal, () =>
			page.mainFrame().evaluate(() => "modelContext" in document || "modelContext" in navigator),
		);
		return exposed ? undefined : WEBMCP_NOT_EXPOSED;
	}

	#entryFingerprint(entry: CatalogEntry): string {
		return JSON.stringify({
			name: entry.name,
			description: entry.description,
			frameId: entry.frameId,
			origin: entry.origin,
			inputSchema: entry.inputSchema,
			annotations: entry.annotations,
		});
	}

	#recordEvent(type: WebMcpCatalogEvent["type"], entry: CatalogEntry): void {
		this.#sequence += 1;
		this.#events.push({
			sequence: this.#sequence,
			type,
			name: entry.name,
			frameId: entry.frameId,
			origin: entry.origin,
			timestamp: Date.now(),
			untrusted: true,
		});
		if (this.#events.length > MAX_EVENTS) {
			const removed = this.#events.splice(0, this.#events.length - MAX_EVENTS);
			this.#droppedThrough = removed.at(-1)?.sequence ?? this.#droppedThrough;
		}
	}
}
