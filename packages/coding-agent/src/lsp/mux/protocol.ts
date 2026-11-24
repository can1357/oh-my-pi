/**
 * Contract of the daemon's `lsp` module (`daemon/modules/lsp.ts`) and its
 * client connector in `lsp/client.ts`.
 *
 * One `lsp` unit is one language-server process. A client calls
 * {@link LSP_ACQUIRE_METHOD} to pick an instance key (the first instance of
 * its server identity with no attached session), `open`s that unit, and
 * `attach`es with the returned token as channel. The tunnel then carries
 * plain Content-Length-framed LSP JSON-RPC plus the private `omp/mux*`
 * methods below.
 */
import type { UnitScope } from "../../daemon/daemon-types";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";

/** Daemon unit kind and `call` module name. */
export const LSP_MODULE_KIND = "lsp";
/** `lsp` module protocol version advertised in the daemon's caps. */
export const LSP_MODULE_VERSION = 1;

/**
 * `call("lsp", LSP_ACQUIRE_METHOD, LspServerParams)`: reserve the first free
 * instance of the server identity. Result: {@link LspAcquireResult}.
 */
export const LSP_ACQUIRE_METHOD = "acquire";

/**
 * `call("lsp", LSP_UNRESERVE_METHOD, LspAcquireResult)`: drop a reservation
 * whose `open` or `attach` failed, so the next acquire reuses the instance
 * instead of starting another server. Result: null.
 */
export const LSP_UNRESERVE_METHOD = "unreserve";

/**
 * Notification on an attached tunnel: kill that tunnel's server process. Sent
 * by `lsp reload` when the generic reload path decides the server is wedged,
 * or when the link's configuration was superseded — a plain per-session
 * `shutdown`/`exit` is intercepted by the module so the process can linger
 * for reuse.
 */
export const MUX_RESTART_METHOD = "omp/muxRestartServer";

/**
 * Last frame the module writes on each tunnel bound to a server that just
 * exited, before closing it: carries the real exit code and stderr tail,
 * which a bare close cannot. Sent as `{ jsonrpc, method, params }` (in that
 * key order) so the client finds it by prefix in the tunnel's final bytes.
 */
export const MUX_SERVER_EXITED_METHOD = "omp/muxServerExited";

/** Bytes of server stderr forwarded in {@link MUX_SERVER_EXITED_METHOD}. */
export const MUX_SERVER_EXIT_STDERR_BYTES = 4_096;

/** Payload of {@link MUX_SERVER_EXITED_METHOD}. */
export interface MuxServerExit {
	/** Process exit code; -1 when the process died from a signal. */
	code: number;
	/** Tail of the server's stderr. */
	stderr: string;
}

const MUX_SERVER_EXIT_PREFIX = `{"jsonrpc":"2.0","method":"${MUX_SERVER_EXITED_METHOD}"`;

/** Find the server-exit notification at the end of a tunnel's final bytes. */
export function parseMuxServerExit(tail: string): MuxServerExit | undefined {
	const start = tail.lastIndexOf(MUX_SERVER_EXIT_PREFIX);
	if (start < 0) return undefined;
	try {
		const message = JSON.parse(tail.slice(start)) as { params?: Partial<MuxServerExit> };
		const params = message.params;
		if (typeof params?.code !== "number") return undefined;
		return { code: params.code, stderr: typeof params.stderr === "string" ? params.stderr : "" };
	} catch {
		return undefined;
	}
}

/** Parameters identifying a reusable server process. */
export interface LspServerParams {
	/** Executable to spawn (the client's `resolvedCommand ?? command`). */
	command: string;
	/** Arguments passed verbatim to the executable. */
	args: string[];
	/** Workspace root the server runs in; part of the server identity key. */
	cwd: string;
	/** Environment overlay the client applies on top of its own env for the spawn. */
	env?: Record<string, string>;
	/**
	 * `initializationOptions` the client sends in its `initialize` request. A
	 * reused server answers `initialize` from its cached result, so the options
	 * it was started with are part of its identity.
	 */
	initializationOptions?: unknown;
}

/** `open` params of an `lsp` unit. */
export interface LspUnitParams extends LspServerParams {
	/** Complete spawn environment: the client's base env merged with {@link LspServerParams.env}. */
	spawnEnv: Record<string, string>;
}

/** Result of {@link LSP_ACQUIRE_METHOD}. */
export interface LspAcquireResult {
	/** Project scope of the server's canonical cwd. */
	scope: UnitScope;
	/** Instance key to `open`. */
	key: string;
	/** Reservation token; pass as the `attach` channel. */
	token: string;
}

/** Unit key of instance `index` of a server identity. */
export function lspInstanceKey(identity: string, index: number): string {
	return index === 0 ? identity : `${identity}#${index}`;
}

/**
 * Server identity key.
 *
 * Every input that changes what the spawned process actually *is* belongs in
 * this key: the module spawns `[command, ...args]` in `cwd` with the client's
 * env plus `env`, so two clients that agree on command and cwd but differ in
 * args or env are not interchangeable. Keying on command and cwd alone let
 * an idle server started with one argument set be handed to a client that
 * asked for another, silently serving the wrong configuration from a process
 * the client believed it had configured.
 *
 * Initialization options belong in the key for the same reason. A reused
 * server answers `initialize` from the cached result of the client that
 * started it, so the options a later client sends never reach the process.
 * Absent options key like `{}`, which is what the client sends when its
 * config has none.
 *
 * Object keys are sorted at every depth so insertion order never splits one
 * identity in two, and the parts are JSON-encoded so no separator can be
 * forged from a value (`["--log-level", "4"]` stays distinct from
 * `["--log-level 4"]`). The canonical identity is SHA-256 hashed because the
 * key is the unit key shown on the board and in logs; raw environment values
 * and initialization options can contain credentials and must not leak.
 */
export function muxServerKey(params: LspServerParams): string {
	const identity = stableStringifyJson([
		params.command,
		params.args,
		params.cwd,
		params.env ?? {},
		params.initializationOptions ?? {},
	]);
	return `sha256:${Bun.SHA256.hash(identity, "hex")}`;
}
