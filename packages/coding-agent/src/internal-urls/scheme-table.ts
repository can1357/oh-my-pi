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

	/** `owner` names the registrant in refusal messages (e.g. "Host URI scheme"). */
	constructor(owner: string) {
		this.#owner = owner;
	}

	get(scheme: string): ProtocolHandler | undefined {
		return this.#handlers.get(scheme);
	}

	handlers(): Iterable<ProtocolHandler> {
		return this.#handlers.values();
	}

	/**
	 * Replace every handler with `handlers`. Throws, changing nothing, when one
	 * names a built-in or standard scheme, repeats a scheme, or fails
	 * {@link assertProtocolHandlerSpec}.
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

/**
 * One session's own schemes and the router over them. Sources are checked in
 * order, then the built-ins: RPC host URIs first, then extension schemes.
 */
export class SessionUrlSchemes {
	/** Schemes the RPC host registered for this session (`set_host_uri_schemes`). */
	readonly hostUris = new UrlSchemeTable("Host URI scheme");
	/** The session's router: {@link hostUris}, then the built-ins. */
	readonly router = new InternalUrlRouter([this.hostUris]);
}
