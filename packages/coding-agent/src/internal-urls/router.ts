/**
 * Internal URL router for internal protocols (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `security://`, `skill://`, `ssh://`, `vault://`, and `xd://`).
 *
 * One process-global router with one handler per scheme. Access via
 * `InternalUrlRouter.instance()`. Handlers are stateless; per-session and
 * shared state lives in `./state.ts`.
 */
import { AgentProtocolHandler } from "./agent-protocol";
import { ArtifactProtocolHandler } from "./artifact-protocol";
import { HistoryProtocolHandler } from "./history-protocol";
import { IssueProtocolHandler, PrProtocolHandler } from "./issue-pr-protocol";
import { LocalProtocolHandler } from "./local-protocol";
import { McpProtocolHandler } from "./mcp-protocol";
import { MemoryProtocolHandler } from "./memory-protocol";
import { OmpProtocolHandler } from "./omp-protocol";
import { extractUriScheme, parseInternalUrl } from "./parse";
import { RuleProtocolHandler } from "./rule-protocol";
import { SecurityProtocolHandler } from "./security-protocol";
import { SkillProtocolHandler } from "./skill-protocol";
import { SshProtocolHandler } from "./ssh-protocol";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";
import { VaultProtocolHandler } from "./vault-protocol";
import { XdProtocolHandler } from "./xd-protocol";

export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	#handlers = new Map<string, ProtocolHandler>();

	constructor() {
		this.register(new OmpProtocolHandler());
		this.register(new AgentProtocolHandler());
		this.register(new ArtifactProtocolHandler());
		this.register(new MemoryProtocolHandler());
		this.register(new LocalProtocolHandler());
		this.register(new VaultProtocolHandler());
		this.register(new SkillProtocolHandler());
		this.register(new RuleProtocolHandler());
		// Reserved OMP-owned security-analysis namespace; vendor adapters normalize into its store.
		this.register(new SecurityProtocolHandler());
		this.register(new McpProtocolHandler());
		this.register(new IssueProtocolHandler());
		this.register(new PrProtocolHandler());
		this.register(new HistoryProtocolHandler());
		this.register(new SshProtocolHandler());
		this.register(new XdProtocolHandler());
	}

	/** Process-global router instance. */
	static instance(): InternalUrlRouter {
		InternalUrlRouter.#instance ??= new InternalUrlRouter();
		return InternalUrlRouter.#instance;
	}

	/** Reset the global instance in tests. */
	static resetForTests(): void {
		InternalUrlRouter.#instance = undefined;
	}

	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme.toLowerCase(), handler);
	}

	unregister(scheme: string): boolean {
		return this.#handlers.delete(scheme.toLowerCase());
	}

	getHandler(scheme: string): ProtocolHandler | undefined {
		return this.#handlers.get(scheme.toLowerCase());
	}

	canHandle(input: string): boolean {
		const match = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (!match) return false;
		return this.#handlers.has(match[1].toLowerCase());
	}

	/**
	 * Whether read can resolve this URL through either a native handler or the
	 * MCP resource fallback. MCP resources may use arbitrary custom schemes and
	 * may be opaque (`urn:example:document`) rather than hierarchical.
	 */
	canResolve(input: string): boolean {
		const scheme = extractUriScheme(input);
		if (!scheme) return false;
		// Registered handlers only accept the hierarchical `scheme://` form;
		// opaque inputs reach the MCP resource fallback alone.
		if (this.#handlers.has(scheme)) return this.canHandle(input);
		return this.#isMcpResourceScheme(scheme);
	}

	/** Schemes whose handler supports host/path autocomplete. */
	completionSchemes(): string[] {
		const schemes: string[] = [];
		for (const [scheme, handler] of this.#handlers) {
			if (handler.complete) schemes.push(scheme);
		}
		return schemes;
	}

	/**
	 * Candidate completions for the host/path portion of `scheme://<query>`.
	 * Returns `null` when the scheme is unknown or does not support completion.
	 */
	async complete(scheme: string, query: string, context?: ResolveContext): Promise<UrlCompletion[] | null> {
		const handler = this.#handlers.get(scheme.toLowerCase());
		if (!handler?.complete) return null;
		return handler.complete(query, context);
	}

	#isMcpResourceScheme(scheme: string): boolean {
		return !["file", "http", "https"].includes(scheme) && this.#handlers.has("mcp");
	}

	#route(input: string, allowMcpResource = false): { parsed: InternalUrl; handler: ProtocolHandler } {
		const parsed = parseInternalUrl(input);
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler =
			this.#handlers.get(scheme) ??
			(allowMcpResource && this.#isMcpResourceScheme(scheme) ? this.#handlers.get("mcp") : undefined);
		if (!handler) {
			const available = Array.from(this.#handlers.keys())
				.map(candidate => `${candidate}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}
		return { parsed, handler };
	}

	/** Resolve an internal URL through its registered protocol handler. */
	async resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
		const { parsed, handler } = this.#route(input, true);
		const resource = await handler.resolve(parsed, context);
		return { ...resource, immutable: resource.immutable ?? handler.immutable };
	}

	/** Write an internal URL through its registered protocol handler. */
	async write(input: string, content: string, context?: WriteContext): Promise<void> {
		const { parsed, handler } = this.#route(input);
		if (!handler.write) {
			const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
			throw new Error(`${scheme}:// URLs are read-only for write; use the protocol-specific tool for mutations.`);
		}
		await handler.write(parsed, content, context);
	}
}
