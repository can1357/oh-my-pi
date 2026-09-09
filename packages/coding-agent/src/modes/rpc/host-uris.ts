import { Snowflake } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../../internal-urls";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
} from "../../internal-urls/types";
import type {
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
} from "./rpc-types";

type RpcHostUriOutput = (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;

/** OMP-owned namespaces that RPC hosts may not replace. */
const RESERVED_HOST_URI_SCHEMES: ReadonlySet<string> = new Set(["security"]);

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
	readonly immutable: boolean;
	readonly write?: (url: InternalUrl, content: string, context?: WriteContext) => Promise<void>;
	readonly #bridge: RpcHostUriBridge;

	constructor(definition: RpcHostUriSchemeDefinition, bridge: RpcHostUriBridge) {
		this.scheme = definition.scheme;
		this.immutable = definition.immutable === true;
		this.#bridge = bridge;
		if (definition.writable === true) {
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
	#pending = new Map<string, PendingUriRequest>();

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
	 */
	setSchemes(schemes: RpcHostUriSchemeDefinition[]): string[] {
		const normalized = new Map<string, RpcHostUriSchemeDefinition>();
		for (const raw of schemes) {
			const scheme = typeof raw?.scheme === "string" ? raw.scheme.trim().toLowerCase() : "";
			if (!scheme) {
				throw new Error("Host URI scheme must be a non-empty string");
			}
			if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
				throw new Error(`Host URI scheme contains invalid characters: ${raw.scheme}`);
			}
			if (RESERVED_HOST_URI_SCHEMES.has(scheme)) {
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
				this.#router.unregister(previous);
			}
		}
		for (const definition of normalized.values()) {
			this.#router.register(new RpcHostUriProtocolHandler(definition, this));
		}
		this.#definitions = normalized;
		return Array.from(normalized.keys());
	}

	/**
	 * Unregister every host scheme from the router and reject any in-flight
	 * requests. Called on RPC shutdown to keep the global router clean for
	 * subsequent sessions in the same process (used by tests).
	 */
	clear(message: string = "Host URI bridge shut down"): void {
		for (const scheme of this.#definitions.keys()) {
			this.#router.unregister(scheme);
		}
		this.#definitions.clear();
		this.rejectAllPending(message);
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
