import { Snowflake } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../../internal-urls";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "../../internal-urls/types";
import type {
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
} from "./rpc-types";

type RpcHostUriOutput = (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;

type PendingUriRequest = {
	operation: "read" | "write";
	url: string;
	resolve: (frame: RpcHostUriResult) => void;
	reject: (error: Error) => void;
};

/** Type guard for inbound `host_uri_result` frames coming from the host. */
export function isRpcHostUriResult(value: unknown): value is RpcHostUriResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown };
	return frame.type === "host_uri_result" && typeof frame.id === "string";
}

/**
 * One handler instance per host-registered scheme. Delegates reads and (when
 * the scheme was registered as writable) writes to the bridge, which serializes
 * them over the RPC transport.
 */
class RpcHostUriProtocolHandler implements ProtocolHandler {
	readonly scheme: string;
	readonly spec: SchemeSpec;
	readonly write?: (url: InternalUrl, content: string, context?: WriteContext) => Promise<void>;
	readonly #bridge: RpcHostUriBridge;

	constructor(definition: RpcHostUriSchemeDefinition, bridge: RpcHostUriBridge) {
		this.scheme = definition.scheme;
		this.#bridge = bridge;
		const writable = definition.writable === true;
		this.spec = {
			backing: "remote",
			selectors: "none",
			immutable: definition.immutable === true,
			write: writable ? { via: "handler", payload: "text", scope: "workspace", tier: () => "write" } : undefined,
		};
		if (writable) {
			this.write = (url, content, context) => this.#bridge.requestWrite(this.scheme, url, content, context);
		}
	}

	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		return this.#bridge.requestRead(this.scheme, url, context);
	}
}

/**
 * Bidirectional bridge that lets the RPC host own a set of URI schemes.
 *
 * The host registers schemes via `set_host_uri_schemes`; the bridge installs
 * a `RpcHostUriProtocolHandler` per scheme into the process-global
 * {@link InternalUrlRouter}. Reads land on the read tool through the existing
 * router; writes are intercepted by the write tool and dispatched through
 * `requestWrite`.
 */
export class RpcHostUriBridge {
	#output: RpcHostUriOutput;
	#router: InternalUrlRouter;
	#definitions = new Map<string, RpcHostUriSchemeDefinition>();
	/** Handlers this bridge installed, by scheme. Another bridge may since have replaced one. */
	#handlers = new Map<string, RpcHostUriProtocolHandler>();
	#pending = new Map<string, PendingUriRequest>();
	/** Set by {@link clear}: the client is gone, so no scheme may be registered for it and no request sent to it. */
	#closed: string | undefined;

	constructor(output: RpcHostUriOutput, router: InternalUrlRouter = InternalUrlRouter.instance()) {
		this.#output = output;
		this.#router = router;
	}

	getSchemes(): string[] {
		return Array.from(this.#definitions.keys());
	}

	/**
	 * Replace the registered set of host URI schemes. Previously registered
	 * schemes that no longer appear in the new set are unregistered from the
	 * router; surviving and new schemes get fresh handler instances.
	 *
	 * @throws Error once {@link clear} ran: a command from a departed client that was still queued must not
	 * re-register its schemes.
	 */
	setSchemes(schemes: RpcHostUriSchemeDefinition[]): string[] {
		if (this.#closed !== undefined) throw new Error(this.#closed);
		const normalized = new Map<string, RpcHostUriSchemeDefinition>();
		for (const raw of schemes) {
			const scheme = typeof raw?.scheme === "string" ? raw.scheme.trim().toLowerCase() : "";
			if (!scheme) {
				throw new Error("Host URI scheme must be a non-empty string");
			}
			if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
				throw new Error(`Host URI scheme contains invalid characters: ${raw.scheme}`);
			}
			// Built-in schemes are OMP-owned: a host shadowing one would change its semantics for
			// the whole process, and `clear()` would then delete it for later sessions.
			if (this.#router.isBuiltin(scheme)) {
				throw new Error(`Host URI scheme is reserved by OMP: ${scheme}://`);
			}
			normalized.set(scheme, {
				scheme,
				description: typeof raw.description === "string" ? raw.description : undefined,
				writable: raw.writable === true,
				immutable: raw.immutable === true,
			});
		}

		for (const previous of this.#definitions.keys()) {
			if (!normalized.has(previous)) {
				this.#unregister(previous);
			}
		}
		for (const definition of normalized.values()) {
			const handler = new RpcHostUriProtocolHandler(definition, this);
			this.#router.register(handler);
			this.#handlers.set(definition.scheme, handler);
		}
		this.#definitions = normalized;
		return Array.from(normalized.keys());
	}

	/**
	 * Unregister this bridge's host schemes from the router and reject any
	 * in-flight requests. A scheme another bridge has since registered keeps
	 * that bridge's handler. Called when the client disconnects, which also
	 * keeps the global router clean for later sessions in the same process.
	 * After this the bridge refuses new schemes and requests.
	 */
	clear(message: string = "Host URI bridge shut down"): void {
		this.#closed ??= message;
		for (const scheme of this.#definitions.keys()) {
			this.#unregister(scheme);
		}
		this.#definitions.clear();
		this.rejectAllPending(message);
	}

	#unregister(scheme: string): void {
		if (this.#router.getHandler(scheme) === this.#handlers.get(scheme)) this.#router.unregister(scheme);
		this.#handlers.delete(scheme);
	}

	/**
	 * Re-install this bridge's handler for `scheme` after a later registrant
	 * released it. Returns false when this bridge does not serve `scheme`.
	 */
	reclaim(scheme: string): boolean {
		const handler = this.#handlers.get(scheme);
		if (!handler) return false;
		this.#router.register(handler);
		return true;
	}

	/** Resolve a pending request by id; called by `rpc-mode` on inbound results. */
	handleResult(frame: RpcHostUriResult): boolean {
		const pending = this.#pending.get(frame.id);
		if (!pending) return false;
		this.#pending.delete(frame.id);
		pending.resolve(frame);
		return true;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const entry of pending) {
			entry.reject(error);
		}
	}

	async requestRead(scheme: string, url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const result = await this.#dispatch("read", url.href, undefined, context?.signal);
		if (result.isError) {
			throw new Error(result.error || result.content || `Host URI read failed for ${url.href}`);
		}
		const content = result.content ?? "";
		const contentType = result.contentType ?? "text/plain";
		const definition = this.#definitions.get(scheme);
		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			notes: result.notes && result.notes.length > 0 ? [...result.notes] : undefined,
			immutable: result.immutable ?? definition?.immutable === true,
		};
	}

	async requestWrite(_scheme: string, url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const result = await this.#dispatch("write", url.href, content, context?.signal);
		if (result.isError) {
			throw new Error(result.error || result.content || `Host URI write failed for ${url.href}`);
		}
	}

	#dispatch(
		operation: "read" | "write",
		url: string,
		content: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<RpcHostUriResult> {
		if (this.#closed !== undefined) return Promise.reject(new Error(this.#closed));
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host URI ${operation} for ${url} was aborted`));
		}

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<RpcHostUriResult>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#output({
				type: "host_uri_cancel",
				id: Snowflake.next() as string,
				targetId: id,
			});
			reject(new Error(`Host URI ${operation} for ${url} was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(id, {
			operation,
			url,
			resolve: frame => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(frame);
			},
			reject: err => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			},
		});

		const frame: RpcHostUriRequest = {
			type: "host_uri_request",
			id,
			operation,
			url,
		};
		if (operation === "write") {
			frame.content = content ?? "";
		}
		this.#output(frame);

		return promise;
	}
}
