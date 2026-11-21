/**
 * MCP servers as eval globals (`mcp.evalNamespaces`).
 *
 * Each server's enabled tools become async methods of one eval global
 * (`mcp__github_create_issue` → `github.create_issue(args)`) and leave the
 * top-level and tool-command surfaces. A method calls its registry tool
 * through the eval bridge op {@link EVAL_MCP_BRIDGE_NAME}, which runs the
 * tool exactly as `tool.<name>(args)` does (approval, ACP gates, extension
 * hooks stay the tool's own) and maps its MCP content to a script value
 * ({@link mcpNamespaceValue}): images, audio and binary resources land as
 * `local://mcp/…` files. Full docs (every method with its description and
 * argument type, plus the server's advertised resources) live behind
 * `read help://eval/<namespace>`; the eval namespace listing carries a
 * model-written "when to use" hint, cached like skill descriptions and empty
 * until generated.
 *
 * Consumers: `SessionTools` partitions {@link isEvalNamespaceTool} entries out
 * of the presented tools, the SDK appends {@link MCPEvalNamespaceCatalog.preludes}
 * to the session's eval preludes, and the eval tool bridge serves the calls.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { jsonSchemaToTypeScript, toolWireSchema } from "@oh-my-pi/pi-ai";
import { blobExtensionForImageMimeType, normalizeBlobExtension } from "@oh-my-pi/pi-tui/prompt/image-format";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../eval/preludes";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import type { LocalProtocolOptions } from "../internal-urls/local-root";
import {
	previewSkillDescription,
	RoutingHintCatalog,
	type RoutingHintCatalogOptions,
	type RoutingHintRequest,
} from "../extensibility/skill-descriptions";
import namespaceDocs from "../prompts/tools/mcp-namespace.md" with { type: "text" };
import namespaceHint from "../prompts/tools/mcp-namespace-hint.md" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import namespaceJavascript from "./eval-namespace.js" with { type: "text" };
import namespacePython from "./eval-namespace.py" with { type: "text" };
import type { MCPManagerApi } from "./manager";
import { mcpToolNameParts } from "./tool-bridge";

/** Eval bridge op a namespace method calls with an {@link MCPNamespaceCall}. */
export const EVAL_MCP_BRIDGE_NAME = "__mcp__";

/** Most advertised resources and templates a namespace's docs list. */
const MAX_LISTED_RESOURCES = 100;

/** Resource catalog the docs list; the live MCP manager, which changes as discovery settles. */
export type MCPResourceSource = Pick<MCPManagerApi, "getServerResources" | "ensureServerResources">;

const PYTHON_KEYWORDS = new Set(
	"and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
		" ",
	),
);

/**
 * Lowercase identifiers a namespace global must not take: either language's
 * keywords, runtime globals, Python builtins, the modules and helpers the eval
 * preludes bind, and the fixed `help://eval/<topic>` doc topics. Sanitized
 * server names are lowercase, so camelCase globals cannot collide.
 */
const RESERVED_NAMESPACES = new Set([
	...PYTHON_KEYWORDS,
	// JavaScript reserved words.
	..."arguments break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof undefined var void while with yield".split(
		" ",
	),
	// JavaScript runtime and eval realm globals.
	..."atob btoa close console crypto exports fetch fs global location module navigator performance process require self webcrypto".split(
		" ",
	),
	// Python builtins.
	..."abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright credits delattr dict dir divmod enumerate exec exit filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow print property quit range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip".split(
		" ",
	),
	// Modules the Python prelude binds as kernel globals.
	..."asyncio collections contextvars inspect json math os re time types typing unquote urllib".split(" "),
	// Eval prelude helpers (both languages) and fixed doc topics.
	..."agent agents budget completion env helpers judge judge_batch log output phase read sh tool wait workpool write".split(
		" ",
	),
	// Built-in eval preludes (SDK `getEvalPreludes`), reserved while disabled too, so a
	// namespace keeps its name across toggles.
	..."archive browser commit computer dsm ratchet".split(" "),
]);

/** Original MCP route of a registry entry; `undefined` for tools that did not come from an MCP server. */
function mcpRoute(tool: object | undefined): { server: string; tool: string } | undefined {
	if (!tool || !("mcpServerName" in tool) || !("mcpToolName" in tool)) return undefined;
	const { mcpServerName, mcpToolName } = tool;
	return typeof mcpServerName === "string" && typeof mcpToolName === "string"
		? { server: mcpServerName, tool: mcpToolName }
		: undefined;
}

/** Whether a registry entry presents as an eval namespace method under `mcp.evalNamespaces`. */
export function isEvalNamespaceTool(tool: object | undefined): boolean {
	return mcpRoute(tool) !== undefined;
}

/** `<namespace>.<name>(args)` runs registry tool `tool`. */
export interface MCPNamespaceMethod {
	readonly name: string;
	readonly tool: AgentTool;
}

/** One eval global over the tools of one sanitized MCP server name. */
export interface MCPNamespace {
	readonly name: string;
	/** Original server names, sorted; several when distinct names sanitize alike. */
	readonly servers: readonly string[];
	/** Sorted by name. */
	readonly methods: readonly MCPNamespaceMethod[];
}

/** A method name valid in both languages: no leading digit, no Python keyword (JS allows keywords as properties). */
function methodName(tool: string): string {
	const name = /^\d/.test(tool) ? `_${tool}` : tool;
	return PYTHON_KEYWORDS.has(name) ? `${name}_` : name;
}

/**
 * Group MCP registry entries into namespaces named after their sanitized
 * server (the `<server>` of `mcp__<server>_<tool>`). A name that is reserved,
 * starts with a digit, or is in `taken` (other preludes' globals) gains an
 * `_mcp` suffix (`fetch` → `fetch_mcp`), numbered until unique. Tools without
 * an MCP route are ignored; a method name two tools share keeps the first by
 * registry name.
 */
export function groupMCPNamespaces(tools: readonly AgentTool[], taken: ReadonlySet<string>): MCPNamespace[] {
	const groups = new Map<string, { servers: Set<string>; methods: Map<string, AgentTool> }>();
	for (const tool of [...tools].sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	)) {
		const route = mcpRoute(tool);
		if (!route) continue;
		const parts = mcpToolNameParts(route.server, route.tool);
		let group = groups.get(parts.server);
		if (!group) {
			group = { servers: new Set(), methods: new Map() };
			groups.set(parts.server, group);
		}
		group.servers.add(route.server);
		const method = methodName(parts.tool);
		const existing = group.methods.get(method);
		if (existing) {
			logger.warn("MCP eval namespace method collision; keeping the first tool", {
				namespace: parts.server,
				method,
				kept: existing.name,
				ignored: tool.name,
			});
			continue;
		}
		group.methods.set(method, tool);
	}

	const bases = [...groups.keys()].sort();
	const free = new Set(bases.filter(base => !/^\d/.test(base) && !RESERVED_NAMESPACES.has(base) && !taken.has(base)));
	const assigned = new Set([...free, ...taken]);
	return bases.map(base => {
		let name = base;
		if (!free.has(base)) {
			const stem = /^\d/.test(base) ? `mcp_${base}` : `${base}_mcp`;
			name = stem;
			for (let suffix = 2; assigned.has(name) || RESERVED_NAMESPACES.has(name); suffix++) name = `${stem}${suffix}`;
			assigned.add(name);
		}
		const group = groups.get(base)!;
		return {
			name,
			servers: [...group.servers].sort(),
			methods: [...group.methods]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([method, tool]) => ({ name: method, tool })),
		};
	});
}

function sameNamespace(left: MCPNamespace, right: MCPNamespace): boolean {
	return (
		left.servers.length === right.servers.length &&
		left.servers.every((server, index) => server === right.servers[index]) &&
		left.methods.length === right.methods.length &&
		left.methods.every(
			(method, index) => method.name === right.methods[index].name && method.tool === right.methods[index].tool,
		)
	);
}

function hintRequest(namespace: MCPNamespace): RoutingHintRequest {
	const request = prompt.render(namespaceHint, {
		name: namespace.name,
		servers: namespace.servers,
		methods: namespace.methods.map(method => ({
			name: method.name,
			description: previewSkillDescription(method.tool.description ?? ""),
		})),
	});
	return {
		key: new Bun.CryptoHasher("sha256").update(request).digest("hex"),
		name: namespace.name,
		description: request,
		placeholder: "",
		activity: `Optimizing MCP: ${namespace.servers.join(", ")}`,
		render: () => request,
	};
}

function namespacePrelude(
	namespace: MCPNamespace,
	summary: string,
	resources: (() => MCPResourceSource | undefined) | undefined,
): EvalPreludeDefinition {
	const methods = Object.fromEntries(namespace.methods.map(method => [method.name, method.tool.name]));
	// Load the resource catalogs now, so the docs list them by the time they are read.
	for (const server of namespace.servers) {
		resources?.()
			?.ensureServerResources(server)
			.catch(error => logger.debug("MCP namespace resources unavailable", { server, error: String(error) }));
	}
	let methodDocs: Array<{ name: string; tool: string; description: string; schema: string }> | undefined;
	return {
		name: namespace.name,
		get documentation() {
			// Schemas are printed once, on the first read: large servers are costly to print.
			methodDocs ??= namespace.methods.map(method => ({
				name: method.name,
				tool: method.tool.name,
				description: (method.tool.description ?? "").trim(),
				schema: jsonSchemaToTypeScript(toolWireSchema(method.tool)),
			}));
			// Resources are read live: a server's list changes without its tools changing.
			const source = resources?.();
			const listed = namespace.servers.flatMap(server => {
				const catalog = source?.getServerResources(server);
				if (!catalog) return [];
				return [
					...catalog.resources.map(resource => ({
						uri: resource.uri,
						name: resource.title ?? resource.name,
						description: resource.description && previewSkillDescription(resource.description),
					})),
					...catalog.templates.map(template => ({
						uri: template.uriTemplate,
						template: true,
						name: template.title ?? template.name,
						description: template.description && previewSkillDescription(template.description),
					})),
				];
			});
			return prompt.render(namespaceDocs, {
				name: namespace.name,
				servers: namespace.servers,
				methods: methodDocs,
				resources: listed.slice(0, MAX_LISTED_RESOURCES),
				omittedResources: Math.max(0, listed.length - MAX_LISTED_RESOURCES),
			});
		},
		summary,
		javascript: `${namespaceJavascript.trim()}(${JSON.stringify({ name: namespace.name, methods })});\n`,
		// Names and methods are `[a-z0-9_]` identifiers and registry keys, so the JSON is a valid Python literal.
		python: `${namespacePython.trim()}\n\n${namespace.name} = _omp_mcp_namespace(${JSON.stringify(namespace.name)}, ${JSON.stringify(methods)})\ndel _omp_mcp_namespace\n`,
		exports: [namespace.name],
	};
}

/**
 * Session-scoped eval preludes for MCP namespaces. A namespace whose servers
 * and tool instances are unchanged keeps its definition object, so prompt
 * surfaces and installed kernel sources stay stable across calls; its hint is
 * frozen on first render ({@link RoutingHintCatalog}).
 */
export class MCPEvalNamespaceCatalog {
	readonly #hints: RoutingHintCatalog;
	readonly #resources: (() => MCPResourceSource | undefined) | undefined;
	#built = new Map<string, { namespace: MCPNamespace; prelude: EvalPreludeDefinition }>();

	/** `resources` returns the live MCP manager whose resource catalogs the docs list. */
	constructor(options: RoutingHintCatalogOptions & { resources?: () => MCPResourceSource | undefined } = {}) {
		this.#hints = new RoutingHintCatalog(options);
		this.#resources = options.resources;
	}

	/**
	 * Eval preludes for the namespaces of `tools` (eval-bound MCP registry
	 * entries); `taken` holds globals other preludes export.
	 */
	preludes(tools: readonly AgentTool[], taken: ReadonlySet<string>): EvalPreludeDefinition[] {
		if (tools.length === 0) {
			this.#built.clear();
			return [];
		}
		const namespaces = groupMCPNamespaces(tools, taken);
		const stale = namespaces.filter(namespace => {
			const built = this.#built.get(namespace.name);
			return !built || !sameNamespace(built.namespace, namespace);
		});
		const hints = this.#hints.hints(stale.map(hintRequest));
		const next = new Map<string, { namespace: MCPNamespace; prelude: EvalPreludeDefinition }>();
		let index = 0;
		for (const namespace of namespaces) {
			const built = this.#built.get(namespace.name);
			next.set(
				namespace.name,
				built && sameNamespace(built.namespace, namespace)
					? built
					: { namespace, prelude: namespacePrelude(namespace, hints[index++], this.#resources) },
			);
		}
		this.#built = next;
		return [...next.values()].map(entry => entry.prelude);
	}

	/** Start hint generation held by `deferCompression`. */
	startCompression(): void {
		this.#hints.startCompression();
	}

	/** Await scheduled hint writes (for shutdown or tests). */
	waitForPending(): Promise<void> {
		return this.#hints.waitForPending();
	}
}

/** One {@link EVAL_MCP_BRIDGE_NAME} request: kernel method `label` (`github.search`) running registry tool `tool`. */
export interface MCPNamespaceCall {
	readonly tool: string;
	readonly label: string;
	readonly args: unknown;
}

/** @throws {ToolError} when the kernel sent a malformed request. */
export function parseMCPNamespaceCall(args: unknown): MCPNamespaceCall {
	if (!isRecord(args) || typeof args.tool !== "string" || typeof args.label !== "string") {
		throw new ToolError("Invalid MCP namespace call");
	}
	return { tool: args.tool, label: args.label, args: args.args ?? {} };
}

/**
 * A resource an MCP namespace call returned. Embedded text comes as `text`, an
 * embedded binary as a `local://` `path`; a link carries neither and is read
 * with `read("mcp://<uri>")`.
 */
export interface MCPNamespaceResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	text?: string;
	path?: string;
}

/** Call result with both text and structured data, media, or resources. */
export interface MCPNamespaceResult {
	text: string;
	structured?: Record<string, unknown>;
	/** `local://mcp/…` image files. */
	images?: string[];
	/** `local://mcp/…` audio files. */
	audio?: string[];
	resources?: MCPNamespaceResource[];
}

/** A namespace method's text, structured data, or envelope for mixed content. */
export type MCPNamespaceValue = string | Record<string, unknown> | MCPNamespaceResult;

function contentText(content: readonly unknown[]): string {
	const texts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") texts.push(item.text);
	}
	return texts.join("\n\n");
}

/** Decode base64 `data` into a fresh `local://mcp/<label>-<id>.<ext>` file; returns its URL. */
async function saveLocal(label: string, data: string, mimeType: unknown, local: LocalProtocolOptions): Promise<string> {
	const mime = typeof mimeType === "string" ? mimeType : undefined;
	const subtype = mime?.split(";")[0].split("/")[1];
	const extension =
		blobExtensionForImageMimeType(mime) ??
		(subtype === "octet-stream" ? undefined : normalizeBlobExtension(subtype)) ??
		"bin";
	const url = `local://mcp/${label.replace(/[^\w.-]/g, "_")}-${Snowflake.next()}.${extension}`;
	await Bun.write(resolveLocalUrlToPath(url, local), Buffer.from(data, "base64"));
	return url;
}

/**
 * Script value of one namespace call. Text-only and structured-only results
 * stay bare. Mixed text and structured data, or any media or resources, use
 * an envelope with media and binary resources saved under `local://mcp/`.
 *
 * @throws {ToolError} with the tool's error text when the call failed.
 */
export async function mcpNamespaceValue(
	label: string,
	result: AgentToolResult,
	local: LocalProtocolOptions,
): Promise<MCPNamespaceValue> {
	const details = isRecord(result.details) ? result.details : {};
	if (result.isError === true || details.isError === true) {
		throw new ToolError(contentText(result.content) || `${label} failed`);
	}
	// The server's own content blocks: the model-facing `content` may be truncated or carry rendered JSON.
	const content: readonly unknown[] = Array.isArray(details.rawContent) ? details.rawContent : result.content;
	const images: string[] = [];
	const audio: string[] = [];
	const resources: MCPNamespaceResource[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if ((item.type === "image" || item.type === "audio") && typeof item.data === "string") {
			(item.type === "image" ? images : audio).push(await saveLocal(label, item.data, item.mimeType, local));
		} else if (item.type === "resource" && isRecord(item.resource) && typeof item.resource.uri === "string") {
			const { uri, mimeType, text, blob } = item.resource;
			const entry: MCPNamespaceResource = { uri };
			if (typeof mimeType === "string") entry.mimeType = mimeType;
			if (typeof text === "string") entry.text = text;
			else if (typeof blob === "string") entry.path = await saveLocal(label, blob, mimeType, local);
			resources.push(entry);
		} else if (item.type === "resource_link" && typeof item.uri === "string") {
			const entry: MCPNamespaceResource = { uri: item.uri };
			const name = typeof item.title === "string" ? item.title : item.name;
			if (typeof name === "string") entry.name = name;
			if (typeof item.description === "string") entry.description = item.description;
			if (typeof item.mimeType === "string") entry.mimeType = item.mimeType;
			resources.push(entry);
		}
	}
	const text = contentText(content);
	const structured = isRecord(details.structuredContent) ? details.structuredContent : undefined;
	if (images.length === 0 && audio.length === 0 && resources.length === 0 && (!structured || !text)) {
		return structured ?? text;
	}
	const value: MCPNamespaceResult = { text };
	if (structured) value.structured = structured;
	if (images.length > 0) value.images = images;
	if (audio.length > 0) value.audio = audio;
	if (resources.length > 0) value.resources = resources;
	return value;
}
