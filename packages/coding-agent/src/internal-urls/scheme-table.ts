/**
 * A session-owned set of internal URL scheme handlers: one of the sources a
 * session router checks before the built-ins (see {@link InternalUrlRouter}).
 */
import { assertProtocolHandlerSpec, InternalUrlRouter, type UrlSchemeSource } from "./router";
import type { ProtocolHandler } from "./types";
import { isStandardScheme } from "./url-scheme";

/** Handlers one session owns, keyed by lowercase scheme. Built-in and standard schemes are refused. */
export class UrlSchemeTable implements UrlSchemeSource {
	#handlers = new Map<string, ProtocolHandler>();
	readonly #owner: string;
	readonly #taken: readonly UrlSchemeSource[];

	/**
	 * `owner` names the registrant in refusal messages (e.g. "Host URI scheme"); a scheme one of
	 * `taken` holds is refused too.
	 */
	constructor(owner: string, taken: readonly UrlSchemeSource[] = []) {
		this.#owner = owner;
		this.#taken = taken;
	}

	get(scheme: string): ProtocolHandler | undefined {
		return this.#handlers.get(scheme);
	}

	handlers(): Iterable<ProtocolHandler> {
		return this.#handlers.values();
	}

	/**
	 * Replace every handler with `handlers`. Throws, changing nothing, when one
	 * names a built-in or standard scheme, a scheme a `taken` source holds,
	 * repeats a scheme, or fails {@link assertProtocolHandlerSpec}.
	 */
	replace(handlers: readonly ProtocolHandler[]): void {
		const next = new Map<string, ProtocolHandler>();
		for (const handler of handlers) {
			const scheme = handler.scheme.toLowerCase();
			if (InternalUrlRouter.isBuiltin(scheme)) {
				throw new Error(`${this.#owner} is reserved by OMP: ${scheme}://`);
			}
			if (isStandardScheme(scheme)) {
				throw new Error(`${this.#owner} is a standard scheme: ${scheme}://`);
			}
			if (this.#taken.some(source => source.get(scheme))) {
				throw new Error(`${this.#owner} is already registered in this session: ${scheme}://`);
			}
			if (next.has(scheme)) throw new Error(`${this.#owner} is registered twice: ${scheme}://`);
			assertProtocolHandlerSpec(handler);
			next.set(scheme, handler);
		}
		this.#handlers = next;
	}

	/** Remove every handler. */
	clear(): void {
		this.#handlers = new Map();
	}
}

/** A source owning no scheme. */
const NO_SCHEMES: UrlSchemeSource = { get: () => undefined, handlers: () => [] };

/**
 * One session's own schemes and the router over them. Sources are checked in
 * order, then the built-ins: RPC host URIs first, then extension schemes.
 */
export class SessionUrlSchemes {
	/** Schemes the RPC host registered for this session (`set_host_uri_schemes`); never one an extension holds. */
	readonly hostUris: UrlSchemeTable;
	/**
	 * The host URI schemes this session resolves: its own {@link hostUris}, then the
	 * ones it inherited from the session that spawned it. Read live, never written.
	 */
	readonly hostUriSources: readonly UrlSchemeSource[];
	/** The session's router: {@link hostUriSources}, then the extension schemes, then the built-ins. */
	readonly router: InternalUrlRouter;

	/**
	 * `parentHostUris` is the spawning session's {@link hostUriSources}: a task
	 * subagent on the parent's thread resolves the RPC host's schemes the parent
	 * resolves, including ones the host registers after the spawn.
	 * `extensionSchemes` reads the schemes the session's active extensions registered
	 * (`pi.registerUrlScheme`); a host URI scheme may not be one of them.
	 */
	constructor(parentHostUris: readonly UrlSchemeSource[] = [], extensionSchemes: UrlSchemeSource = NO_SCHEMES) {
		this.hostUris = new UrlSchemeTable("Host URI scheme", [extensionSchemes]);
		this.hostUriSources = [this.hostUris, ...parentHostUris];
		this.router = new InternalUrlRouter([...this.hostUriSources, extensionSchemes]);
	}
}
