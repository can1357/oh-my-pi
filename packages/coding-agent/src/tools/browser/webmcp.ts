import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { CDPSession, Frame, NewDocumentScriptEvaluation, Page, Realm, WebMCPTool } from "puppeteer-core";

declare module "puppeteer-core" {
	interface Frame {
		/** Puppeteer's page-main JavaScript realm, retained by omp's pinned runtime patch. */
		mainRealm(): Realm;
	}
}

const BRIDGE_KEY = "__ompWebMcpBridge_v1";
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_SUMMARY_DESCRIPTION_BYTES = 160;
const MAX_SUMMARY_TOOLS = 16;
const MAX_EVENTS = 256;

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
	/** Whether native CDP or the page-side registration mirror is available. */
	status: "ready" | "unavailable";
	/** Matching page-provided tools. */
	tools: WebMcpToolRecord[];
	/** Whether the bounded summary omitted or shortened metadata. */
	truncated: boolean;
	/** Explanation when no native or mirrored catalog is available. */
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

interface HookToolRecord {
	name: string;
	description: string;
	inputSchema?: unknown;
	annotations?: unknown;
}

interface HookSnapshot {
	nativeAvailable: boolean;
	tools: HookToolRecord[];
	origin: string;
}

interface CatalogEntry extends WebMcpToolRecord {
	frame: Frame;
	nativeTool?: WebMCPTool;
}

interface HookInvokeEnvelope {
	ok: boolean;
	encoded?: string;
	error?: string;
}

interface PageModelContextTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: unknown;
	execute?: (params: unknown, options?: { signal: AbortSignal }) => unknown | Promise<unknown>;
	handler?: (params: unknown, options?: { signal: AbortSignal }) => unknown | Promise<unknown>;
}

interface PageModelContext {
	registerTool?: (tool: PageModelContextTool, options?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
	unregisterTool?: (name: string) => unknown | Promise<unknown>;
	provideContext?: (context: unknown) => unknown | Promise<unknown>;
	getTools?: () => unknown | Promise<unknown>;
	executeTool?: (tool: PageModelContextTool, params?: unknown) => unknown | Promise<unknown>;
	addEventListener?: EventTarget["addEventListener"];
	removeEventListener?: EventTarget["removeEventListener"];
	dispatchEvent?: EventTarget["dispatchEvent"];
	ontoolchange?: ((event: Event) => void) | null;
}

interface PageWebMcpBridge {
	nativeAvailable: boolean;
	snapshot(): HookToolRecord[];
	invoke(name: string, params: unknown): Promise<unknown>;
	uninstall(): void;
}

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

function installPageHook(key: string): void {
	const realm = globalThis as typeof globalThis & Record<string, unknown>;
	if (realm[key]) return;

	const pageGlobals = globalThis as unknown as {
		navigator: { modelContext?: PageModelContext };
		document: { modelContext?: PageModelContext };
	};
	const nav = pageGlobals.navigator;
	const doc = pageGlobals.document;
	const existingContext = doc.modelContext ?? nav.modelContext;
	const nativeAvailable = existingContext !== undefined;
	const tools = new Map<string, PageModelContextTool>();
	const originalDescriptor = existingContext
		? Object.getOwnPropertyDescriptor(existingContext, "registerTool")
		: undefined;
	const originalUnregisterDescriptor = existingContext
		? Object.getOwnPropertyDescriptor(existingContext, "unregisterTool")
		: undefined;
	const originalRegister = existingContext?.registerTool?.bind(existingContext);
	const originalUnregister = existingContext?.unregisterTool?.bind(existingContext);
	const changeTarget = new EventTarget();
	let polyfillContext: PageModelContext | undefined;

	const cloneMetadata = (value: unknown): unknown => {
		if (value === undefined) return undefined;
		try {
			return JSON.parse(JSON.stringify(value)) as unknown;
		} catch {
			return undefined;
		}
	};
	const notify = (): void => {
		const event = new Event("toolchange");
		changeTarget.dispatchEvent(event);
		polyfillContext?.ontoolchange?.(event);
	};
	const remember = (tool: PageModelContextTool, signal?: AbortSignal): void => {
		if (typeof tool?.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
			throw new TypeError("WebMCP tool name must contain 1-128 ASCII letters, digits, '_', '-', or '.'");
		}
		if (typeof (tool.execute ?? tool.handler) !== "function") {
			throw new TypeError(`WebMCP tool ${JSON.stringify(tool.name)} requires an execute function`);
		}
		tools.set(tool.name, tool);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					if (tools.get(tool.name) === tool) {
						tools.delete(tool.name);
						notify();
					}
				},
				{ once: true },
			);
		}
		notify();
	};
	const registerTool = async (tool: PageModelContextTool, options?: { signal?: AbortSignal }): Promise<void> => {
		if (originalRegister) await originalRegister(tool, options);
		remember(tool, options?.signal);
	};
	const unregisterTool = async (name: string): Promise<void> => {
		if (originalUnregister) await originalUnregister(name);
		if (tools.delete(name)) notify();
	};

	if (existingContext) {
		try {
			Object.defineProperty(existingContext, "registerTool", {
				configurable: true,
				writable: true,
				value: registerTool,
			});
			if (originalUnregister) {
				Object.defineProperty(existingContext, "unregisterTool", {
					configurable: true,
					writable: true,
					value: unregisterTool,
				});
			}
		} catch {
			// Native CDP discovery remains authoritative when this object is not patchable.
		}
	} else {
		polyfillContext = {
			registerTool,
			unregisterTool,
			async provideContext(context: unknown): Promise<void> {
				const record = context && typeof context === "object" ? (context as Record<string, unknown>) : undefined;
				const provided = Array.isArray(context) ? context : record?.tools;
				if (!Array.isArray(provided)) throw new TypeError("provideContext() expects an array or { tools: [...] }");
				for (const tool of provided) await registerTool(tool as PageModelContextTool);
			},
			async getTools(): Promise<HookToolRecord[]> {
				return bridge.snapshot();
			},
			async executeTool(tool: PageModelContextTool, params?: unknown): Promise<unknown> {
				return await bridge.invoke(tool.name, params ?? {});
			},
			addEventListener: changeTarget.addEventListener.bind(changeTarget),
			removeEventListener: changeTarget.removeEventListener.bind(changeTarget),
			dispatchEvent: changeTarget.dispatchEvent.bind(changeTarget),
			ontoolchange: null,
		};
		for (const owner of [nav, doc]) {
			try {
				Object.defineProperty(owner, "modelContext", {
					configurable: true,
					enumerable: false,
					value: polyfillContext,
				});
			} catch {
				// A hostile or unusual page can make the host object non-configurable.
			}
		}
	}

	const bridge: PageWebMcpBridge = {
		nativeAvailable,
		snapshot(): HookToolRecord[] {
			return [...tools.values()]
				.map(tool => ({
					name: tool.name,
					description: typeof tool.description === "string" ? tool.description : "",
					inputSchema: cloneMetadata(tool.inputSchema),
					annotations: cloneMetadata(tool.annotations),
				}))
				.sort((left, right) => left.name.localeCompare(right.name));
		},
		async invoke(name: string, params: unknown): Promise<unknown> {
			const tool = tools.get(name);
			if (!tool) throw new Error(`No page-side WebMCP tool named ${JSON.stringify(name)}`);
			const execute = tool.execute ?? tool.handler;
			if (!execute) throw new Error(`WebMCP tool ${JSON.stringify(name)} has no execute function`);
			const controller = new AbortController();
			return await execute(params, { signal: controller.signal });
		},
		uninstall(): void {
			if (existingContext) {
				try {
					if (originalDescriptor) Object.defineProperty(existingContext, "registerTool", originalDescriptor);
					else delete existingContext.registerTool;
					if (originalUnregisterDescriptor) {
						Object.defineProperty(existingContext, "unregisterTool", originalUnregisterDescriptor);
					} else if (originalUnregister) {
						delete existingContext.unregisterTool;
					}
				} catch {
					// Best-effort cleanup for attached user tabs.
				}
			} else if (polyfillContext) {
				for (const owner of [nav, doc]) {
					try {
						if (owner.modelContext === polyfillContext) delete owner.modelContext;
					} catch {
						// Best-effort cleanup for attached user tabs.
					}
				}
			}
			delete realm[key];
		},
	};
	Object.defineProperty(realm, key, { configurable: true, enumerable: false, value: bridge });
}

async function hookSnapshot(frame: Frame): Promise<HookSnapshot> {
	return await frame.mainRealm().evaluate((key: string) => {
		const realm = globalThis as typeof globalThis & Record<string, unknown>;
		const bridge = realm[key] as PageWebMcpBridge | undefined;
		const pageLocation = globalThis as unknown as { location: { origin: string } };
		return {
			nativeAvailable: bridge?.nativeAvailable ?? false,
			tools: bridge?.snapshot() ?? [],
			origin: pageLocation.location.origin,
		};
	}, BRIDGE_KEY);
}

async function invokeHook(frame: Frame, name: string, params: unknown): Promise<HookInvokeEnvelope> {
	return await frame.mainRealm().evaluate(
		async (key: string, toolName: string, input: unknown) => {
			const realm = globalThis as typeof globalThis & Record<string, unknown>;
			const bridge = realm[key] as PageWebMcpBridge | undefined;
			if (!bridge) return { ok: false, error: "WebMCP page hook is unavailable" };
			try {
				const result = await bridge.invoke(toolName, input);
				const encoded = JSON.stringify(result === undefined ? null : result);
				return { ok: true, encoded };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		BRIDGE_KEY,
		name,
		params,
	);
}

/** Per-tab WebMCP discovery, invocation, and catalog-event controller. */
export class WebMcpController {
	readonly #page: Page;
	readonly #preload: NewDocumentScriptEvaluation;
	#nativeSupported: boolean;
	#catalog = new Map<string, CatalogEntry>();
	#events: WebMcpCatalogEvent[] = [];
	#sequence = 0;
	#droppedThrough = 0;

	constructor(page: Page, preload: NewDocumentScriptEvaluation, nativeSupported: boolean) {
		this.#page = page;
		this.#preload = preload;
		this.#nativeSupported = nativeSupported;
	}

	/** Discover page-provided tools, omitting schemas unless an exact name is requested. */
	async list(options: WebMcpListOptions = {}): Promise<WebMcpListResult> {
		await this.#refreshCatalog();
		let entries = [...this.#catalog.values()];
		if (options.name !== undefined) entries = entries.filter(tool => tool.name === options.name);
		if (options.frame !== undefined) entries = entries.filter(tool => tool.frameId === options.frame);
		entries.sort((left, right) => left.name.localeCompare(right.name) || left.frameId.localeCompare(right.frameId));

		if (options.name !== undefined) {
			return {
				status: this.#status(),
				tools: entries.map(entry => this.#publicRecord(entry, true)),
				truncated: false,
				...this.#reason(),
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
			status: this.#status(),
			tools,
			truncated,
			...this.#reason(),
			untrusted: true,
		};
	}

	/** Invoke one page-provided tool and return a bounded JSON-cloneable result. */
	async invoke(name: string, params: unknown, options: WebMcpInvokeOptions = {}): Promise<WebMcpInvokeResult> {
		await this.#refreshCatalog();
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
		const tool = matches[0]!;
		try {
			if (tool.nativeTool) {
				const result = await tool.nativeTool.execute(this.#cloneInput(params));
				if (result.status !== "Completed") {
					const detail = result.errorText ?? result.exception?.description ?? `WebMCP invocation ${result.status}`;
					return { ok: false, error: untrustedBoundary(detail), untrusted: true };
				}
				return boundedResult(result.output);
			}
			const response = await invokeHook(tool.frame, name, this.#cloneInput(params));
			if (!response.ok) {
				return {
					ok: false,
					error: untrustedBoundary(response.error ?? "WebMCP invocation failed"),
					untrusted: true,
				};
			}
			if (response.encoded === undefined) {
				return { ok: false, error: untrustedBoundary("WebMCP result was not JSON-serializable"), untrusted: true };
			}
			return boundedResult(JSON.parse(response.encoded) as unknown);
		} catch (error) {
			return { ok: false, error: untrustedBoundary(errorText(error)), untrusted: true };
		}
	}

	/** Poll catalog transitions observed since a prior cursor. */
	async events(options: WebMcpEventsOptions = {}): Promise<WebMcpEventsResult> {
		await this.#refreshCatalog();
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

	/** Remove the preload and restore any page API method wrapped by this controller. */
	async dispose(): Promise<void> {
		await this.#page.removeScriptToEvaluateOnNewDocument(this.#preload.identifier).catch(() => undefined);
		for (const frame of this.#page.frames()) {
			await frame
				.mainRealm()
				.evaluate((key: string) => {
					const realm = globalThis as typeof globalThis & Record<string, unknown>;
					(realm[key] as PageWebMcpBridge | undefined)?.uninstall();
				}, BRIDGE_KEY)
				.catch(() => undefined);
		}
		this.#catalog.clear();
		this.#events = [];
		this.#droppedThrough = 0;
	}

	#status(): "ready" | "unavailable" {
		return this.#nativeSupported || this.#catalog.size > 0 ? "ready" : "unavailable";
	}

	#reason(): { reason: string } | Record<string, never> {
		return this.#status() === "unavailable"
			? { reason: "Chrome WebMCP CDP is unavailable and no page-side tool registrations were observed." }
			: {};
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

	async #refreshCatalog(): Promise<void> {
		const next = new Map<string, CatalogEntry>();
		for (const frame of this.#page.frames()) {
			try {
				const snapshot = await hookSnapshot(frame);
				this.#nativeSupported ||= snapshot.nativeAvailable;
				const id = frameId(frame);
				for (const tool of snapshot.tools) {
					const entry: CatalogEntry = {
						name: tool.name,
						description: tool.description,
						frameId: id,
						origin: snapshot.origin,
						inputSchema: tool.inputSchema,
						annotations: tool.annotations,
						untrusted: true,
						frame,
					};
					next.set(`${id}\u0000${tool.name}`, entry);
				}
			} catch {
				// Detached or cross-process frames remain discoverable through native CDP events.
			}
		}

		if (this.#nativeSupported) {
			for (const tool of this.#page.webmcp.tools()) {
				const id = frameId(tool.frame);
				const entry: CatalogEntry = {
					name: tool.name,
					description: tool.description,
					frameId: id,
					origin: originForUrl(tool.frame.url()),
					inputSchema: tool.inputSchema,
					annotations: tool.annotations,
					untrusted: true,
					frame: tool.frame,
					nativeTool: tool,
				};
				next.set(`${id}\u0000${tool.name}`, entry);
			}
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

/** Install the WebMCP preload before navigation and probe native CDP support. */
export async function installWebMcp(page: Page): Promise<WebMcpController> {
	const preload = await page.evaluateOnNewDocument(installPageHook, BRIDGE_KEY);
	for (const frame of page.frames()) {
		await frame
			.mainRealm()
			.evaluate(installPageHook, BRIDGE_KEY)
			.catch(() => undefined);
	}

	let nativeSupported = false;
	let session: CDPSession | undefined;
	try {
		session = await page.createCDPSession();
		await Promise.race([
			session.send("WebMCP.enable"),
			Bun.sleep(1_000).then(() => {
				throw new Error("WebMCP CDP probe timed out");
			}),
		]);
		nativeSupported = true;
	} catch {
		nativeSupported = false;
	} finally {
		await session?.detach().catch(() => undefined);
	}
	return new WebMcpController(page, preload, nativeSupported);
}
