const DEFAULT_BASE_URL = "http://127.0.0.1:18086";
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const HARD_MAX_RESPONSE_BYTES = 4_194_304;
const DEFAULT_MAX_TEXT_CHARS = 65_536;
const HARD_MAX_TEXT_CHARS = 262_144;
const DEFAULT_MAX_TREE_NODES = 1_000;
const HARD_MAX_TREE_NODES = 5_000;
const DEFAULT_MAX_MESSAGES = 50;
const HARD_MAX_MESSAGES = 250;
const DEFAULT_MAX_MESSAGE_CHARS = 2_000;
const HARD_MAX_MESSAGE_CHARS = 16_384;

export type BrowserProvider = "slack" | "teams" | "discord" | "generic";

export interface IxBrowserContextClientOptions {
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

export interface BrowserContextCaptureOptions {
	lane: string;
	session: string;
	tabGroup?: string;
	includeChat?: boolean;
	maxTextChars?: number;
	maxTreeNodes?: number;
	maxMessages?: number;
	maxMessageChars?: number;
	signal?: AbortSignal;
}

export interface BrowserTabIdentity {
	tabId: number;
	url: string;
	title: string;
	group: { id: number | null; title: string | null };
	epochMs: number;
	timestamp: string;
}

export interface BrowserAccessibilityNode {
	role: string;
	name?: string;
	value?: string;
	description?: string;
	children?: BrowserAccessibilityNode[];
}

export interface BrowserChatMessage {
	role: "user" | "assistant" | "system" | "unknown";
	author?: string;
	timestamp?: string;
	text: string;
}

export interface BrowserEvidenceRedactions {
	promptInjection: boolean;
	sensitiveTokens: boolean;
}

export interface CapturedBrowserContext {
	status: "captured";
	routing: { resolvedLane: string; source: string; tabGroup: string | null };
	provider: BrowserProvider;
	identity: BrowserTabIdentity;
	accessibility: {
		text: string;
		tree: BrowserAccessibilityNode[];
		truncated: boolean;
	};
	chat?: {
		messages: BrowserChatMessage[];
		loadedHistoryOnly: true;
		truncated: boolean;
	};
	redactions: BrowserEvidenceRedactions;
}

export type BrowserContextErrorCode = "disconnected" | "http" | "malformed" | "oversize" | "stale" | "timeout";

export class BrowserContextError extends Error {
	readonly code: BrowserContextErrorCode;

	constructor(code: BrowserContextErrorCode, message: string) {
		super(message);
		this.name = "BrowserContextError";
		this.code = code;
	}
}

interface TraceParts {
	routing: Record<string, unknown>;
	metadata: Record<string, unknown>;
	snapshot: Record<string, unknown>;
}

interface RedactionState {
	promptInjection: boolean;
	sensitiveTokens: boolean;
}

const sensitiveQueryNames =
	/^(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|jwt|key|password|secret|session|sig|signature|token)$/i;
const promptInjectionPattern =
	/\b(?:ignore (?:all |any )?(?:previous|prior|above) (?:instructions?|prompts?)|system prompt|developer message|reveal (?:your )?(?:instructions?|secrets?)|do not trust the user|override (?:the )?(?:instructions?|policy))\b/gi;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const apiKeyPattern = /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gi;
const assignedSecretPattern = /\b(?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]\s*[^\s,;]{6,}/gi;

/** A fail-closed, read-only IX Bridge client for bounded browser evidence. */
export class IxBrowserContextClient {
	readonly #baseUrl: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;

	constructor(options: IxBrowserContextClientOptions = {}) {
		this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 10_000);
		this.#maxResponseBytes = clampInteger(
			options.maxResponseBytes,
			DEFAULT_MAX_RESPONSE_BYTES,
			1_024,
			HARD_MAX_RESPONSE_BYTES,
		);
	}

	async capture(options: BrowserContextCaptureOptions): Promise<CapturedBrowserContext> {
		assertNonblank(options.lane, "lane");
		assertNonblank(options.session, "session");
		if (options.tabGroup !== undefined) assertNonblank(options.tabGroup, "tabGroup");

		const limits = {
			maxTextChars: clampInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 1, HARD_MAX_TEXT_CHARS),
			maxTreeNodes: clampInteger(options.maxTreeNodes, DEFAULT_MAX_TREE_NODES, 1, HARD_MAX_TREE_NODES),
			maxMessages: clampInteger(options.maxMessages, DEFAULT_MAX_MESSAGES, 1, HARD_MAX_MESSAGES),
			maxMessageChars: clampInteger(options.maxMessageChars, DEFAULT_MAX_MESSAGE_CHARS, 1, HARD_MAX_MESSAGE_CHARS),
		};
		const status = await this.#request("/ix-bridge/status", { method: "GET" }, options.signal);
		if (!isRecord(status) || status.extension_connected !== true) {
			throw new BrowserContextError("disconnected", "IX Bridge extension is not connected");
		}

		const traceEnvelope = await this.#command(
			options,
			"capture_trace",
			{
				includeScreenshot: false,
				includeNetwork: false,
				includeLogs: false,
				includeScratch: false,
				includeSnapshot: true,
				snapshotInteractiveOnly: false,
				artifactTimeoutMs: Math.min(this.#timeoutMs, 10_000),
			},
			options.signal,
		);
		const trace = parseTrace(traceEnvelope);
		if (trace.metadata.session !== options.session) {
			throw new BrowserContextError("stale", "capture_trace session identity does not match the request");
		}
		const identity = parseIdentity(trace.metadata);
		assertSnapshotIdentity(identity, trace.snapshot);
		const provider = classifyBrowserProvider(identity.url);
		const redactions: RedactionState = { promptInjection: false, sensitiveTokens: false };
		const accessibility = parseAccessibility(trace.snapshot, limits.maxTextChars, limits.maxTreeNodes, redactions);
		if (accessibility.text.length === 0 && accessibility.tree.length === 0) {
			throw new BrowserContextError("malformed", "capture_trace contained no accessibility evidence");
		}

		let chat: CapturedBrowserContext["chat"];
		if (options.includeChat) {
			const expression = buildChatExtractionExpression(provider, limits.maxMessages, limits.maxMessageChars);
			if (expression) {
				const chatEnvelope = await this.#command(options, "evaluate", { expression }, options.signal);
				chat = parseChat(chatEnvelope, limits.maxMessages, limits.maxMessageChars, redactions);
			}
		}

		const tabsEnvelope = await this.#command(options, "list_tabs", {}, options.signal);
		assertCurrentIdentity(tabsEnvelope, identity);

		return {
			status: "captured",
			routing: parseRouting(trace.routing, options),
			provider,
			identity: { ...identity, url: redactUrl(identity.url), title: redactText(identity.title, redactions) },
			accessibility,
			...(chat ? { chat } : {}),
			redactions,
		};
	}

	async #command(
		options: BrowserContextCaptureOptions,
		action: "capture_trace" | "evaluate" | "list_tabs",
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		return this.#request(
			"/ix-bridge/command",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					lane: options.lane,
					session: options.session,
					...(options.tabGroup ? { tabGroup: options.tabGroup } : {}),
					action,
					args,
				}),
			},
			signal,
		);
	}

	async #request(path: string, init: RequestInit, parentSignal?: AbortSignal): Promise<unknown> {
		const controller = new AbortController();
		const abort = () => controller.abort(parentSignal?.reason);
		if (parentSignal?.aborted) abort();
		else parentSignal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error("IX Bridge request timed out")), this.#timeoutMs);
		try {
			const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, signal: controller.signal });
			if (!response.ok) throw new BrowserContextError("http", `IX Bridge returned HTTP ${response.status}`);
			const text = await readBoundedResponse(response, this.#maxResponseBytes);
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new BrowserContextError("malformed", "IX Bridge returned malformed JSON");
			}
		} catch (error) {
			if (controller.signal.aborted && !(error instanceof BrowserContextError)) {
				throw new BrowserContextError("timeout", "IX Bridge request timed out or aborted");
			}
			throw error;
		} finally {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", abort);
		}
	}
}

export function classifyBrowserProvider(rawUrl: string): BrowserProvider {
	try {
		const host = new URL(rawUrl).hostname.toLowerCase();
		if (host === "slack.com" || host.endsWith(".slack.com")) return "slack";
		if (host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com")) return "teams";
		if (host === "discord.com" || host.endsWith(".discord.com")) return "discord";
	} catch {
		// A malformed URL is classified generic, but capture identity validation still requires a string.
	}
	return "generic";
}

export function redactUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		url.username = "";
		url.password = "";
		for (const name of [...url.searchParams.keys()]) {
			if (sensitiveQueryNames.test(name)) url.searchParams.set(name, "[REDACTED]");
		}
		return url.toString();
	} catch {
		return "[REDACTED INVALID URL]";
	}
}

function parseTrace(envelope: unknown): TraceParts {
	if (!isRecord(envelope)) throw new BrowserContextError("malformed", "capture_trace envelope must be an object");
	const routing = isRecord(envelope.routing) ? envelope.routing : {};
	const payload = unwrapPayload(envelope);
	if (!isRecord(payload) || !isRecord(payload.metadata) || !isRecord(payload.snapshot)) {
		throw new BrowserContextError("malformed", "capture_trace metadata or snapshot is missing");
	}
	if (payload.success !== undefined && payload.success !== true) {
		throw new BrowserContextError("malformed", "capture_trace reported failure");
	}
	return { routing, metadata: payload.metadata, snapshot: payload.snapshot };
}

function parseIdentity(metadata: Record<string, unknown>): BrowserTabIdentity {
	const tabId = metadata.tabId;
	const url = metadata.url;
	const title = metadata.title;
	const groupId = metadata.groupId;
	const groupTitle = metadata.groupTitle;
	const epochMs = metadata.timestamp;
	if (
		typeof tabId !== "number" ||
		!Number.isSafeInteger(tabId) ||
		typeof url !== "string" ||
		typeof title !== "string"
	) {
		throw new BrowserContextError("malformed", "capture_trace tab identity is malformed");
	}
	if (groupId !== undefined && groupId !== null && !Number.isSafeInteger(groupId)) {
		throw new BrowserContextError("malformed", "capture_trace group identity is malformed");
	}
	if (groupTitle !== undefined && groupTitle !== null && typeof groupTitle !== "string") {
		throw new BrowserContextError("malformed", "capture_trace group title is malformed");
	}
	if (
		typeof epochMs !== "number" ||
		!Number.isSafeInteger(epochMs) ||
		epochMs <= 0 ||
		epochMs > 8_640_000_000_000_000
	) {
		throw new BrowserContextError("malformed", "capture_trace timestamp is malformed");
	}
	return {
		tabId,
		url,
		title,
		group: {
			id: typeof groupId === "number" ? groupId : null,
			title: typeof groupTitle === "string" ? groupTitle : null,
		},
		epochMs,
		timestamp: new Date(epochMs).toISOString(),
	};
}

function assertSnapshotIdentity(identity: BrowserTabIdentity, snapshot: Record<string, unknown>): void {
	if (snapshot.url !== identity.url || snapshot.title !== identity.title) {
		throw new BrowserContextError("stale", "capture_trace snapshot identity does not match metadata");
	}
}

function assertCurrentIdentity(envelope: unknown, identity: BrowserTabIdentity): void {
	const payload = unwrapPayload(envelope);
	if (!isRecord(payload) || !Array.isArray(payload.tabs)) {
		throw new BrowserContextError("malformed", "list_tabs response is malformed");
	}
	const tab = payload.tabs.find(item => isRecord(item) && item.tabId === identity.tabId);
	if (
		!isRecord(tab) ||
		tab.active !== true ||
		tab.url !== identity.url ||
		tab.title !== identity.title ||
		(tab.groupId ?? null) !== identity.group.id ||
		(tab.groupTitle ?? null) !== identity.group.title
	) {
		throw new BrowserContextError("stale", "Browser tab identity changed during capture");
	}
}

function parseAccessibility(
	snapshot: Record<string, unknown>,
	maxTextChars: number,
	maxTreeNodes: number,
	redactions: RedactionState,
): CapturedBrowserContext["accessibility"] {
	if (typeof snapshot.text !== "string" || !Array.isArray(snapshot.tree)) {
		throw new BrowserContextError("malformed", "Accessibility snapshot is malformed");
	}
	const redactedText = redactText(snapshot.text, redactions);
	const text = redactedText.slice(0, maxTextChars);
	const budget = { nodes: maxTreeNodes, chars: maxTextChars, truncated: false };
	const tree: BrowserAccessibilityNode[] = [];
	for (const rawNode of snapshot.tree) {
		const node = parseTreeNode(rawNode, budget, redactions, 0);
		if (node) tree.push(node);
		if (budget.nodes === 0 || budget.chars === 0) {
			budget.truncated = true;
			break;
		}
	}
	return { text, tree, truncated: redactedText.length > text.length || budget.truncated };
}

function parseTreeNode(
	raw: unknown,
	budget: { nodes: number; chars: number; truncated: boolean },
	redactions: RedactionState,
	depth: number,
): BrowserAccessibilityNode | undefined {
	if (!isRecord(raw) || typeof raw.role !== "string") return undefined;
	if (depth >= 64) {
		budget.truncated = true;
		return undefined;
	}
	if (budget.nodes <= 0 || budget.chars <= 0) {
		budget.truncated = true;
		return undefined;
	}
	budget.nodes -= 1;
	const node: BrowserAccessibilityNode = { role: takeBounded(redactText(raw.role, redactions), budget) };
	for (const key of ["name", "value", "description"] as const) {
		if (typeof raw[key] === "string") node[key] = takeBounded(redactText(raw[key], redactions), budget);
	}
	if (Array.isArray(raw.children)) {
		const children: BrowserAccessibilityNode[] = [];
		for (const child of raw.children) {
			const parsed = parseTreeNode(child, budget, redactions, depth + 1);
			if (parsed) children.push(parsed);
			if (budget.nodes === 0 || budget.chars === 0) break;
		}
		if (children.length > 0) node.children = children;
	}
	return node;
}

function parseChat(
	envelope: unknown,
	maxMessages: number,
	maxMessageChars: number,
	redactions: RedactionState,
): NonNullable<CapturedBrowserContext["chat"]> {
	const payload = unwrapPayload(envelope);
	const value = isRecord(payload) && "value" in payload ? payload.value : payload;
	if (!Array.isArray(value)) throw new BrowserContextError("malformed", "IX evaluate chat result is malformed");
	const messages: BrowserChatMessage[] = [];
	for (const raw of value.slice(0, maxMessages)) {
		if (!isRecord(raw) || typeof raw.text !== "string") continue;
		const role = raw.role;
		messages.push({
			role: role === "user" || role === "assistant" || role === "system" ? role : "unknown",
			...(typeof raw.author === "string" ? { author: redactText(raw.author, redactions).slice(0, 256) } : {}),
			...(typeof raw.timestamp === "string" ? { timestamp: raw.timestamp.slice(0, 128) } : {}),
			text: redactText(raw.text, redactions).slice(0, maxMessageChars),
		});
	}
	return { messages, loadedHistoryOnly: true, truncated: value.length > maxMessages };
}

function buildChatExtractionExpression(
	provider: BrowserProvider,
	maxMessages: number,
	maxMessageChars: number,
): string | undefined {
	const selector = {
		slack: '[data-qa="message_container"]',
		teams: '[data-tid="chat-pane-message"], [data-tid="message-body"]',
		discord: '[data-list-item-id^="chat-messages"], li[id^="chat-messages"]',
		generic: undefined,
	}[provider];
	if (!selector) return undefined;
	return `(() => { const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(-${maxMessages}); return nodes.map(node => { const author = node.querySelector('[data-qa="message_sender_name"], [data-tid="message-author-name"], [class*="username"]')?.textContent?.trim(); const time = node.querySelector('time')?.getAttribute('datetime') || undefined; const own = node.matches('[data-is-self="true"], [data-author-self="true"]') || node.querySelector('[data-is-self="true"], [data-author-self="true"]'); return { role: own ? 'user' : 'unknown', author, timestamp: time, text: (node.innerText || node.textContent || '').trim().slice(0, ${maxMessageChars}) }; }); })()`;
}

function parseRouting(
	routing: Record<string, unknown>,
	options: BrowserContextCaptureOptions,
): CapturedBrowserContext["routing"] {
	const resolvedLane = routing.resolved_lane ?? routing.resolvedLane ?? routing.lane;
	const source = routing.source;
	const tabGroup = routing.tab_group ?? routing.tabGroup;
	return {
		resolvedLane: typeof resolvedLane === "string" ? resolvedLane : options.lane,
		source: typeof source === "string" ? source : "ix-bridge",
		tabGroup: typeof tabGroup === "string" ? tabGroup : (options.tabGroup ?? null),
	};
}

function unwrapPayload(envelope: unknown): unknown {
	if (!isRecord(envelope)) return envelope;
	if ("data" in envelope) return envelope.data;
	if ("result" in envelope) return envelope.result;
	return envelope;
}

function redactText(text: string, state: RedactionState): string {
	let output = text.replace(promptInjectionPattern, () => {
		state.promptInjection = true;
		return "[REDACTED PROMPT INJECTION]";
	});
	for (const pattern of [jwtPattern, bearerPattern, apiKeyPattern, assignedSecretPattern]) {
		output = output.replace(pattern, () => {
			state.sensitiveTokens = true;
			return "[REDACTED SENSITIVE TOKEN]";
		});
	}
	return output;
}

function takeBounded(text: string, budget: { chars: number; truncated: boolean }): string {
	const result = text.slice(0, budget.chars);
	budget.chars -= result.length;
	if (result.length < text.length) budget.truncated = true;
	return result;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new BrowserContextError("oversize", "IX Bridge response exceeds the byte limit");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new BrowserContextError("oversize", "IX Bridge response exceeds the byte limit");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) throw new TypeError("Browser context limit must be finite");
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function assertNonblank(value: string, name: string): void {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonblank string`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
