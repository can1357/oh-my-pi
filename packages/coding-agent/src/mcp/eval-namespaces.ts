/**
 * MCP servers as eval globals (`mcp.evalNamespaces`).
 *
 * Each server's enabled tools become async methods of one eval global
 * (`mcp__github_create_issue` → `github.create_issue(args)`) and leave the
 * top-level and `xd://` tool surfaces. A method calls its registry tool
 * through the eval tool bridge (`__omp_call_tool__`), so approval, ACP gates
 * and extension hooks stay the tool's own. Full docs (every method with its
 * description and argument type) live behind `read xd://eval/<namespace>`; the
 * eval namespace listing carries a model-written "when to use" hint, cached
 * like skill descriptions and empty until generated.
 *
 * Consumers: `SessionTools` partitions {@link isEvalNamespaceTool} entries out
 * of the presented tools, and the SDK appends {@link MCPEvalNamespaceCatalog.preludes}
 * to the session's eval preludes.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { jsonSchemaToTypeScript, toolWireSchema } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../eval/preludes";
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
import { mcpToolNameParts } from "./tool-bridge";

const PYTHON_KEYWORDS = new Set(
	"and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
		" ",
	),
);

/**
 * Lowercase identifiers a namespace global must not take: either language's
 * keywords, runtime globals, Python builtins, the modules and helpers the eval
 * preludes bind, and the fixed `xd://eval/<topic>` doc topics. Sanitized
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

function namespacePrelude(namespace: MCPNamespace, summary: string): EvalPreludeDefinition {
	const methods = Object.fromEntries(namespace.methods.map(method => [method.name, method.tool.name]));
	let documentation: string | undefined;
	return {
		name: namespace.name,
		// Rendered once, on the first read: schemas of large servers are costly to print.
		get documentation() {
			documentation ??= prompt.render(namespaceDocs, {
				name: namespace.name,
				servers: namespace.servers,
				methods: namespace.methods.map(method => ({
					name: method.name,
					tool: method.tool.name,
					description: (method.tool.description ?? "").trim(),
					schema: jsonSchemaToTypeScript(toolWireSchema(method.tool)),
				})),
			});
			return documentation;
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
	#built = new Map<string, { namespace: MCPNamespace; prelude: EvalPreludeDefinition }>();

	constructor(options: RoutingHintCatalogOptions = {}) {
		this.#hints = new RoutingHintCatalog(options);
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
					: { namespace, prelude: namespacePrelude(namespace, hints[index++]) },
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
