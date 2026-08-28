/**
 * Capability discovery — SKILL.md / MCP / extension adapters. READ-ONLY.
 *
 * The first *discovery* rung. Until now the capability graph
 * (`capability-graph.ts`) could only ingest hand-written
 * `CapabilityDescriptor.metadata`. This module turns a real `SKILL.md`
 * document (YAML-ish front matter + body), an MCP server manifest, or an
 * extension descriptor into normalized `CapabilityDescriptor`s plus dependency
 * edges, so `createCapabilityGraph` can see *actual* project/global skills
 * instead of inline test data.
 *
 * Scope (this file):
 *   - PURE parsing only: `parseSkillDocument(raw, context)` takes the *text* of
 *     a SKILL.md and a caller-supplied context (scope, source path). It
 *     performs NO filesystem access and NO execution — a later, thin caller
 *     owns reading files and feeding the text in.
 *   - Normalization into the existing `CapabilityDescriptor` shape, with edges
 *     embedded in `metadata` using the exact shorthand fields the graph
 *     already parses (`requires` / `validates` / `rollsBack` / `conflictsWith`
 *     / `commonlyUsedWith`).
 *   - A stable `revisionHash` (definition hashing) computed purely.
 *   - Structured diagnostics instead of throwing.
 *   - MCP/extension adapters over *injected* manifests (no network I/O here);
 *     the circuit breaker and session cache take an injectable clock so tests
 *     stay deterministic.
 *
 * Explicitly NOT here (later, human-gated):
 *   - Filesystem scanning of config directories (the caller does the I/O).
 *   - LLM-inferred dependencies (forbidden initially).
 *   - Any execution, ranking, or graph mutation.
 *
 * Discipline: additive (imports only *types* from `capability-orchestration`
 * and `capability-graph`), fail-open (never throws), not wired into
 * `memory-fabric/index.ts`.
 *
 * Honesty: we only read what the document declares. A dependency edge exists
 * only when the front matter explicitly declares it; nothing is inferred.
 */

import type { CapabilityEdgeKind } from "./capability-graph";
import type { CapabilityDescriptor } from "./capability-orchestration";

/** Where a discovered capability came from. The caller supplies this. */
export interface DiscoveryContext {
	/** Assigned scope for the discovered capability. */
	scope: "global" | "project" | "workspace";
	/** Optional path the document was read from (recorded, never opened here). */
	sourcePath?: string;
	/** Optional project id for project-scoped capabilities. */
	projectId?: string;
}

export type DiagnosticLevel = "error" | "warning" | "info";

export interface DiscoveryDiagnostic {
	level: DiagnosticLevel;
	message: string;
	sourcePath?: string;
}

/** A dependency edge derived purely from the document's front matter. */
export interface DiscoveredEdge {
	from: string;
	to: string;
	kind: CapabilityEdgeKind;
}

export interface SkillDiscoveryResult {
	/** The normalized node, or null when the document could not yield one. */
	node: CapabilityDescriptor | null;
	edges: DiscoveredEdge[];
	diagnostics: DiscoveryDiagnostic[];
}

export interface DiscoveryBatchResult {
	nodes: CapabilityDescriptor[];
	edges: DiscoveredEdge[];
	diagnostics: DiscoveryDiagnostic[];
}

/** Namespaces reserved for internal capabilities; skills may not impersonate them. */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
	"builtin",
	"tool",
	"skill",
	"agent",
	"mcp",
	"extension",
	"workflow",
	"resource",
	"sidecar",
	"subagent",
]);

/**
 * Front-matter key -> canonical graph shorthand field + edge kind. The parser
 * accepts a few spellings (camelCase, snake_case, kebab-case) of each.
 */
const EDGE_FIELD_SPECS: ReadonlyArray<{
	aliases: readonly string[];
	shorthandField: string;
	kind: CapabilityEdgeKind;
}> = [
	{ aliases: ["requires", "require", "requirements"], shorthandField: "requires", kind: "requires" },
	{ aliases: ["validates", "validate"], shorthandField: "validates", kind: "validates" },
	{
		aliases: ["rollsback", "rolls_back", "rolls-back", "rollback"],
		shorthandField: "rollsBack",
		kind: "rolls-back",
	},
	{
		aliases: ["conflictswith", "conflicts_with", "conflicts-with", "conflicts"],
		shorthandField: "conflictsWith",
		kind: "conflicts-with",
	},
	{
		aliases: ["commonlyusedwith", "commonly_used_with", "commonly-used-with", "usedwith"],
		shorthandField: "commonlyUsedWith",
		kind: "commonly-used-with",
	},
];

type FrontMatter = Record<string, string | string[]>;

/** Deterministic, dependency-free 32-bit FNV-1a hash rendered as 8-char hex. */
function fnv1aHex(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// 32-bit FNV prime multiply via shifts, kept in unsigned range.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function stripQuotes(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

function parseInlineArray(value: string): string[] {
	// "[a, b, c]" -> ["a","b","c"]; tolerant of trailing commas / empties.
	const inner = value.slice(1, -1).trim();
	if (inner.length === 0) return [];
	return inner
		.split(",")
		.map(item => stripQuotes(item))
		.filter(item => item.length > 0);
}

/**
 * Minimal, fail-open front-matter reader supporting the subset SKILL.md needs:
 * scalars (`key: value`), inline arrays (`key: [a, b]`), and block arrays
 * (`key:` then `  - item` lines). No external YAML dependency.
 */
function extractFrontMatter(raw: string): { frontMatter: FrontMatter | null; body: string } {
	const normalized = raw.replace(/^\uFEFF/, "");
	const match = normalized.match(/^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
	if (!match) return { frontMatter: null, body: normalized };

	const block = match[1];
	const body = match[2] ?? "";
	const frontMatter: FrontMatter = {};
	const lines = block.split(/\r?\n/);

	let currentArrayKey: string | null = null;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		if (/^\s*#/.test(line)) continue;

		const arrayItem = line.match(/^\s*-\s+(.*)$/);
		if (arrayItem && currentArrayKey) {
			const item = stripQuotes(arrayItem[1]);
			const list = frontMatter[currentArrayKey];
			if (item.length > 0 && Array.isArray(list)) list.push(item);
			continue;
		}

		const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
		if (!kv) continue;
		const key = kv[1].trim();
		const rawValue = kv[2].trim();

		if (rawValue.length === 0) {
			// Begin a block array (or an empty scalar if no items follow).
			currentArrayKey = key;
			frontMatter[key] = [];
			continue;
		}
		currentArrayKey = null;
		if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
			frontMatter[key] = parseInlineArray(rawValue);
		} else {
			frontMatter[key] = stripQuotes(rawValue);
		}
	}

	return { frontMatter, body };
}

function asString(value: string | string[] | undefined): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.length > 0) return value[0];
	return undefined;
}

function asArray(value: string | string[] | undefined): string[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
	return [];
}

function slug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isTruthyFlag(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const v = value.trim().toLowerCase();
	if (v === "true" || v === "yes" || v === "1" || v === "on") return true;
	if (v === "false" || v === "no" || v === "0" || v === "off") return false;
	return fallback;
}

const HIGH_RISK = new Set(["high", "critical"]);
const WRITE_MUTABILITY = new Set(["external-write", "destructive"]);

/**
 * Parse a single SKILL.md document into a normalized capability descriptor plus
 * its declared dependency edges. Pure and fail-open — any problem is reported as
 * a diagnostic and yields `node: null` rather than throwing.
 */
export function parseSkillDocument(raw: string, context: DiscoveryContext): SkillDiscoveryResult {
	const sourcePath = context?.sourcePath;
	const diagnostics: DiscoveryDiagnostic[] = [];
	const fail = (message: string, level: DiagnosticLevel = "error"): SkillDiscoveryResult => {
		diagnostics.push({ level, message, sourcePath });
		return { node: null, edges: [], diagnostics };
	};

	try {
		if (typeof raw !== "string" || raw.trim().length === 0) {
			return fail("empty or non-string document");
		}
		if (!context || (context.scope !== "global" && context.scope !== "project" && context.scope !== "workspace")) {
			return fail("missing or invalid discovery scope");
		}

		const { frontMatter } = extractFrontMatter(raw);
		if (!frontMatter) return fail("no YAML front matter found");

		const rawName = asString(frontMatter.name);
		if (!rawName || rawName.trim().length === 0) {
			return fail("front matter is missing a 'name'");
		}
		if (rawName.includes(":")) {
			const prefix = rawName.split(":", 1)[0].trim().toLowerCase();
			return fail(
				`skill name "${rawName}" uses a reserved/namespaced form; declare a plain name` +
					(RESERVED_NAMESPACES.has(prefix) ? ` (namespace "${prefix}" is reserved)` : ""),
			);
		}

		const id = `skill:${context.scope}:${slug(rawName)}`;
		if (slug(rawName).length === 0) {
			return fail(`skill name "${rawName}" produced an empty id after normalization`);
		}

		const description = asString(frontMatter.description) ?? "";
		if (description.length === 0) {
			diagnostics.push({ level: "warning", message: `skill "${id}" has no description`, sourcePath });
		}

		const tags = asArray(frontMatter.tags);
		const versionText = asString(frontMatter.version);
		const parsedVersion = versionText ? Number.parseInt(versionText, 10) : Number.NaN;
		const version = Number.isFinite(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1;

		const risk = (asString(frontMatter.risk) ?? "low").trim().toLowerCase();
		const mutability = (asString(frontMatter.mutability) ?? "read-only").trim().toLowerCase();
		const trust = (asString(frontMatter.trust) ?? "unreviewed").trim().toLowerCase();

		// Conservative approval default: high-risk or write-capable skills require
		// approval unless the document explicitly overrides.
		const approvalDefault = HIGH_RISK.has(risk) || WRITE_MUTABILITY.has(mutability);
		const requiresApproval = isTruthyFlag(
			asString(frontMatter.requiresapproval ?? frontMatter.requiresApproval ?? frontMatter["requires-approval"]),
			approvalDefault,
		);
		const enabled =
			isTruthyFlag(asString(frontMatter.enabled), true) && !isTruthyFlag(asString(frontMatter.disabled), false);

		// Collect declared edges and mirror them into graph-parseable shorthand
		// metadata fields.
		const edges: DiscoveredEdge[] = [];
		const shorthand: Record<string, string[]> = {};
		const seen = new Set<string>();
		for (const spec of EDGE_FIELD_SPECS) {
			const targets: string[] = [];
			for (const alias of spec.aliases) {
				for (const target of asArray(frontMatter[alias])) {
					const to = target.trim();
					if (to.length === 0 || to === id) continue;
					targets.push(to);
					const key = `${to}\u0000${spec.kind}`;
					if (seen.has(key)) continue;
					seen.add(key);
					edges.push({ from: id, to, kind: spec.kind });
				}
			}
			if (targets.length > 0) shorthand[spec.shorthandField] = [...new Set(targets)];
		}

		const revisionHash = fnv1aHex(raw);

		const node: CapabilityDescriptor = {
			id,
			kind: "skill",
			name: rawName.trim(),
			description,
			tags,
			version,
			enabled,
			requiresApproval,
			metadata: {
				...shorthand,
				scope: context.scope,
				projectId: context.projectId,
				source: { type: context.scope === "global" ? "global-config" : "project-config", path: sourcePath },
				revisionHash,
				risk,
				mutability,
				trust,
			},
		};

		return { node, edges, diagnostics };
	} catch {
		return fail("unexpected error while parsing skill document");
	}
}

/**
 * Parse many SKILL.md documents into a de-duplicated node/edge set. Later
 * documents with a colliding id are dropped with a diagnostic (first wins), so
 * discovery is deterministic. Pure and fail-open.
 */
export function discoverSkills(
	documents: ReadonlyArray<{ raw: string; context: DiscoveryContext }>,
): DiscoveryBatchResult {
	const nodes: CapabilityDescriptor[] = [];
	const edges: DiscoveredEdge[] = [];
	const diagnostics: DiscoveryDiagnostic[] = [];
	const byId = new Map<string, CapabilityDescriptor>();

	if (!Array.isArray(documents)) return { nodes, edges, diagnostics };

	for (const doc of documents) {
		const result = parseSkillDocument(doc?.raw ?? "", doc?.context ?? { scope: "project" });
		diagnostics.push(...result.diagnostics);
		if (!result.node) continue;
		if (byId.has(result.node.id)) {
			diagnostics.push({
				level: "warning",
				message: `duplicate capability id "${result.node.id}" ignored (first definition wins)`,
				sourcePath: doc?.context?.sourcePath,
			});
			continue;
		}
		byId.set(result.node.id, result.node);
		nodes.push(result.node);
		edges.push(...result.edges);
	}

	return { nodes, edges, diagnostics };
}

// ---------------------------------------------------------------------------
// Dynamic MCP server & extension capability discovery (injected manifests)
// ---------------------------------------------------------------------------

export interface McpServerManifest {
	serverId: string;
	serverName: string;
	tools: Array<{
		name: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
		readOnly?: boolean;
		requiresApproval?: boolean;
	}>;
	resources?: Array<{
		uri: string;
		name: string;
		description?: string;
	}>;
	unreachable?: boolean;
	errorReason?: string;
}

export interface McpCircuitBreakerState {
	failureCount: number;
	tripped: boolean;
	lastFailedAt?: number;
}

/**
 * Per-server failure tracker. After `maxFailures` consecutive failures a
 * server is skipped until `cooldownMs` has elapsed. The clock is injectable so
 * behaviour stays deterministic under test.
 */
export class McpCircuitBreaker {
	#states = new Map<string, McpCircuitBreakerState>();
	readonly maxFailures: number;
	readonly cooldownMs: number;
	readonly #now: () => number;

	constructor(maxFailures = 3, cooldownMs = 60000, now: () => number = () => Date.now()) {
		this.maxFailures = maxFailures;
		this.cooldownMs = cooldownMs;
		this.#now = now;
	}

	canAttempt(serverId: string): boolean {
		const state = this.#states.get(serverId);
		if (!state?.tripped) return true;
		if (state.lastFailedAt && this.#now() - state.lastFailedAt > this.cooldownMs) {
			return true;
		}
		return false;
	}

	recordSuccess(serverId: string): void {
		this.#states.delete(serverId);
	}

	recordFailure(serverId: string): void {
		const state = this.#states.get(serverId) ?? { failureCount: 0, tripped: false };
		const failureCount = state.failureCount + 1;
		const tripped = failureCount >= this.maxFailures;
		this.#states.set(serverId, { failureCount, tripped, lastFailedAt: this.#now() });
	}

	getState(serverId: string): McpCircuitBreakerState | undefined {
		return this.#states.get(serverId);
	}
}

/**
 * TTL cache of the last good manifest per server. The clock is injectable so
 * expiry is testable without real time passing.
 */
export class McpSessionCache {
	#cache = new Map<string, { manifest: McpServerManifest; cachedAt: number }>();
	readonly ttlMs: number;
	readonly #now: () => number;

	constructor(ttlMs = 300000, now: () => number = () => Date.now()) {
		this.ttlMs = ttlMs;
		this.#now = now;
	}

	get(serverId: string): McpServerManifest | undefined {
		const entry = this.#cache.get(serverId);
		if (!entry) return undefined;
		if (this.#now() - entry.cachedAt > this.ttlMs) {
			this.#cache.delete(serverId);
			return undefined;
		}
		return entry.manifest;
	}

	set(serverId: string, manifest: McpServerManifest): void {
		this.#cache.set(serverId, { manifest, cachedAt: this.#now() });
	}

	clear(): void {
		this.#cache.clear();
	}
}

/**
 * Normalize injected MCP server manifests into capability descriptors. No
 * network I/O happens here — the caller fetches manifests and feeds them in.
 */
export function discoverMcpCapabilities(
	servers: ReadonlyArray<McpServerManifest>,
	options: { circuitBreaker?: McpCircuitBreaker; sessionCache?: McpSessionCache } = {},
): DiscoveryBatchResult {
	const nodes: CapabilityDescriptor[] = [];
	const edges: DiscoveredEdge[] = [];
	const diagnostics: DiscoveryDiagnostic[] = [];
	const circuitBreaker = options.circuitBreaker;
	const sessionCache = options.sessionCache;

	if (!Array.isArray(servers)) return { nodes, edges, diagnostics };

	for (const server of servers) {
		if (!server?.serverId) continue;

		if (circuitBreaker && !circuitBreaker.canAttempt(server.serverId)) {
			diagnostics.push({
				level: "warning",
				message: `MCP server "${server.serverId}" bypassed due to open circuit breaker`,
			});
			continue;
		}

		if (server.unreachable) {
			if (circuitBreaker) circuitBreaker.recordFailure(server.serverId);
			diagnostics.push({
				level: "error",
				message: `MCP server "${server.serverId}" unreachable: ${server.errorReason ?? "connection failure"}`,
			});
			continue;
		}

		if (circuitBreaker) circuitBreaker.recordSuccess(server.serverId);
		if (sessionCache) sessionCache.set(server.serverId, server);

		for (const tool of server.tools ?? []) {
			const toolId = `mcp:${server.serverId}:${tool.name}`;
			nodes.push({
				id: toolId,
				kind: "tool",
				name: tool.name,
				description: tool.description ?? `MCP tool ${tool.name} from ${server.serverName}`,
				inputSchema: tool.inputSchema,
				tags: ["mcp", server.serverId, tool.readOnly ? "read-only" : "write"],
				version: 1,
				enabled: true,
				requiresApproval: tool.requiresApproval ?? !tool.readOnly,
				metadata: {
					serverId: server.serverId,
					serverName: server.serverName,
					readOnly: tool.readOnly ?? false,
				},
			});
		}
	}

	return { nodes, edges, diagnostics };
}

export interface ExtensionDescriptor {
	extensionId: string;
	name: string;
	description: string;
	tools?: Array<{
		name: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
		requiresApproval?: boolean;
	}>;
	scope?: "global" | "project";
}

/** Normalize injected extension descriptors into capability descriptors. */
export function discoverExtensionCapabilities(extensions: ReadonlyArray<ExtensionDescriptor>): DiscoveryBatchResult {
	const nodes: CapabilityDescriptor[] = [];
	const edges: DiscoveredEdge[] = [];
	const diagnostics: DiscoveryDiagnostic[] = [];

	if (!Array.isArray(extensions)) return { nodes, edges, diagnostics };

	for (const ext of extensions) {
		if (!ext?.extensionId) continue;
		const extNodeId = `extension:${ext.extensionId}`;
		nodes.push({
			id: extNodeId,
			kind: "sidecar",
			name: ext.name,
			description: ext.description,
			tags: ["extension", ext.scope ?? "global"],
			version: 1,
			enabled: true,
			metadata: { extensionId: ext.extensionId, scope: ext.scope ?? "global" },
		});

		for (const tool of ext.tools ?? []) {
			const toolId = `extension:${ext.extensionId}:${tool.name}`;
			nodes.push({
				id: toolId,
				kind: "tool",
				name: tool.name,
				description: tool.description ?? `Extension tool ${tool.name}`,
				inputSchema: tool.inputSchema,
				tags: ["extension-tool", ext.extensionId],
				version: 1,
				enabled: true,
				requiresApproval: tool.requiresApproval ?? false,
				metadata: { extensionId: ext.extensionId },
			});
			edges.push({ from: extNodeId, to: toolId, kind: "requires" });
		}
	}

	return { nodes, edges, diagnostics };
}
