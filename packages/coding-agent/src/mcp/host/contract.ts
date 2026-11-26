/**
 * Contract between a session's MCP client (`mcp/link.ts`) and the MCP host
 * that owns every server: the daemon's `mcp` module (`daemon/modules/mcp.ts`),
 * or the same code in-process (`mcp/host/local.ts`) when no daemon is used.
 *
 * One host unit is one upstream server. A session resolves the server's era
 * ({@link MCP_RESOLVE_METHOD}), attaches a tunnel to its unit, and speaks
 * newline-delimited MCP 2026-07-28 JSON-RPC on it — the stdio framing, which
 * the specification extends to any byte stream. The unit multiplexes every
 * attached session onto the one upstream, serves cacheable results from the
 * store all units share, and starts the upstream only when a request needs it.
 *
 * Sharing follows the protocol era, never a flag:
 * - A modern server is stateless by specification, so one process (or one
 *   origin) serves every session and is stopped whenever it sits unused.
 * - A handshake-era server holds a session in its process, so each MCP
 *   manager gets its own unit ({@link mcpUnitKey}), started on its first real
 *   request and stopped when that manager lets go.
 *
 * Beyond standard MCP the tunnel carries the `omp/*` methods and `_meta` keys
 * declared here.
 */
import { type } from "@oh-my-pi/omptype";
import type { UnitPolicy } from "../../daemon/daemon-types";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { MCPTransportError } from "../errors";
import type { JsonRpcError, MCPRequestIdFormat } from "../types";

/** Daemon unit kind and `call` module name. */
export const MCP_MODULE_KIND = "mcp";
/** `mcp` module protocol version advertised in the daemon's caps. */
export const MCP_MODULE_VERSION = 1;

/**
 * `call("mcp", MCP_RESOLVE_METHOD, McpServerSpec)`: the server's era, probing
 * it once when the store has no record. Result: {@link McpResolveResult}.
 */
export const MCP_RESOLVE_METHOD = "resolve";

/** Which protocol generation an upstream server natively speaks. */
export type McpEra = "modern" | "legacy";

interface McpSpecBase {
	/** JSON-RPC id type the upstream expects; integers unless a server needs strings. */
	requestIdFormat?: MCPRequestIdFormat;
	/** Bound in milliseconds on host-side start, probe and handshake steps; 0 disables it. */
	timeoutMs: number;
}

/** A subprocess server, fully resolved: nothing is looked up in the host's own environment. */
export interface McpStdioSpec extends McpSpecBase {
	transport: "stdio";
	command: string;
	args: string[];
	/** Absolute working directory. */
	cwd: string;
	/** Variables the server's configuration declares, with their resolved values. */
	env: Record<string, string>;
	/** Complete environment of the process: the session's own plus {@link env}. */
	spawnEnv: Record<string, string>;
}

/** A remote server with its request headers resolved, credentials included. */
export interface McpRemoteSpec extends McpSpecBase {
	transport: "http" | "sse";
	url: string;
	headers: Record<string, string>;
	headerPolicy?: "origin-locked";
}

/** Everything the host needs to reach one server. */
export type McpServerSpec = McpStdioSpec | McpRemoteSpec;

/** `open` params of an `mcp` unit. */
export interface McpUnitParams {
	spec: McpServerSpec;
	era: McpEra;
	/** Configured server name, for the board label. */
	name: string;
	/**
	 * How long an unused modern upstream keeps running, in milliseconds; 0
	 * never idle-stops it. Read when the unit is created: the first session
	 * to open a shared unit decides.
	 */
	idleMs: number;
}

/** A resolved server. */
export interface McpResolveResult {
	era: McpEra;
}

/**
 * What {@link MCP_RESOLVE_METHOD} returns over the daemon. A failed probe is
 * a value, not a rejected call: a daemon call error is a bare string, and the
 * session needs the structured failure (an HTTP 401 carries the OAuth
 * challenge). `error` is an {@link encodeHostError} envelope.
 */
export type McpResolveReply = McpResolveResult | { error: JsonRpcError };

/**
 * Names of inherited variables that select an account or carry a credential.
 * Two sessions that differ in one of these must not share a process: the
 * second would act with the first one's identity.
 */
const CREDENTIAL_ENV =
	/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|PROFILE|ACCOUNT|TENANT|CONFIG|CCNAME|AUTH/i;

function sha256(parts: unknown): string {
	return `sha256:${Bun.SHA256.hash(stableStringifyJson(parts), "hex")}`;
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name in headers) result[name.toLowerCase()] = headers[name];
	return result;
}

/**
 * Identity of the upstream a spec describes; sessions with equal identities
 * reach the same server.
 *
 * A subprocess is identified by what its configuration declares — command,
 * arguments, working directory, declared variables — plus every inherited
 * variable whose name looks like a credential or account selector. The rest of
 * the inherited environment (`PATH`, terminal and shell bookkeeping) differs
 * between any two shells and comes from whichever session starts the process.
 * A remote server is identified by its URL and every request header, so a
 * refreshed token is a different upstream: caches are never shared across
 * authorization contexts.
 *
 * Hashed because unit keys reach the board and logs.
 */
export function mcpIdentity(spec: McpServerSpec): string {
	if (spec.transport !== "stdio") {
		return sha256([
			spec.transport,
			spec.url,
			lowercaseKeys(spec.headers),
			spec.headerPolicy ?? "",
			spec.requestIdFormat ?? "",
		]);
	}
	const inherited: Record<string, string> = {};
	for (const name in spec.spawnEnv) {
		if (!Object.hasOwn(spec.env, name) && CREDENTIAL_ENV.test(name)) inherited[name] = spec.spawnEnv[name];
	}
	return sha256(["stdio", spec.command, spec.args, spec.cwd, spec.env, inherited, spec.requestIdFormat ?? ""]);
}

/**
 * Identity without credentials: keys the era record and `cacheScope: "public"`
 * results, which hold for every caller of a remote origin. A subprocess has no
 * credential-free form (its credentials are its environment), so this equals
 * {@link mcpIdentity}.
 */
export function mcpPublicIdentity(spec: McpServerSpec): string {
	return spec.transport === "stdio" ? mcpIdentity(spec) : sha256([spec.transport, spec.url]);
}

/**
 * Unit key of the upstream `instance` reaches. Every session shares the one
 * modern unit; a handshake-era unit belongs to a single MCP manager.
 */
export function mcpUnitKey(spec: McpServerSpec, era: McpEra, instance: string): string {
	const identity = mcpIdentity(spec);
	return era === "modern" ? identity : `${identity}#${instance}`;
}

/**
 * Lifetime policy of a unit. `idleMs` is how long an unleased modern unit
 * lingers for the next session; a handshake-era unit stops with its last
 * lease, since nothing else can adopt the session inside it. Subprocess units
 * cross a daemon re-exec with their pipes; remote units hold nothing to keep.
 */
export function mcpUnitPolicy(spec: McpServerSpec, era: McpEra, idleMs: number): UnitPolicy {
	return {
		hold: "leases",
		idleMs: era === "legacy" ? 0 : idleMs,
		onIdle: "stop",
		restart: "no",
		survive: spec.transport === "stdio" ? "exec" : "none",
	};
}

// ── tunnel extensions ──────────────────────────────────────────────────────

/** Private `_meta` keys on the tunnel; the host strips them before anything reaches an upstream. */
export const OmpMeta = {
	/**
	 * Request hint on cacheable methods: {@link MCP_STALE_OK} or
	 * {@link MCP_NO_STORE}. Without it a fresh entry is served from the store
	 * and a stale one is refetched before the host answers.
	 */
	cache: "omp/cache",
	/** Result flag: the entry served under {@link MCP_STALE_OK} was past its TTL. */
	stale: "omp/stale",
} as const;

/**
 * {@link OmpMeta.cache} value: answer from the store even past the entry's
 * TTL, without starting the upstream; then revalidate in the background and
 * notify list-change subscribers if the content differs.
 */
export const MCP_STALE_OK = "stale-ok";

/**
 * {@link OmpMeta.cache} value: ask the server itself, whatever the store
 * holds, and leave the store untouched. For connection tests and
 * authentication probes, whose point is the live answer.
 */
export const MCP_NO_STORE = "no-store";

/** Host → session notification carrying an {@link McpUpstreamStatus}: once on attach, then on every change. */
export const MCP_STATUS_METHOD = "omp/status";

/**
 * Session → host notification: stop the upstream now and forget its crash
 * history; the next request starts a fresh one. Sent by a manual reconnect.
 */
export const MCP_RESTART_METHOD = "omp/restart";

/**
 * Session → host notification `{ roots: { uri: string; name?: string }[] }`:
 * the session's roots, which a handshake-era upstream fetches with
 * `roots/list`. Modern upstreams ask through `input_required` and the session
 * answers itself.
 */
export const MCP_ROOTS_METHOD = "omp/roots";

/** How an upstream went away. */
export interface McpUpstreamExit {
	code?: number;
	signal?: number;
	/** Tail of the subprocess's stderr; empty for remote upstreams. */
	stderr: string;
}

/** Payload of {@link MCP_STATUS_METHOD}. */
export interface McpUpstreamStatus {
	era: McpEra;
	/**
	 * `idle`: not running and nothing wrong, the next request starts it.
	 * `failed`: the last start or run ended in an error ({@link exit}).
	 */
	state: "idle" | "starting" | "running" | "failed";
	/** Main process of a running subprocess upstream. */
	pid?: number;
	/** Sessions attached to the unit, this one included. */
	links: number;
	exit?: McpUpstreamExit;
}

/** Bytes of subprocess stderr kept for {@link McpUpstreamExit.stderr}. */
export const MCP_STDERR_TAIL_BYTES = 4_096;

// ── errors ─────────────────────────────────────────────────────────────────

/**
 * JSON-RPC error code of failures the host reports about the upstream itself
 * (spawn failure, exit, HTTP status, timeout). Outside the range JSON-RPC and
 * MCP reserve, so it cannot be mistaken for a server's own error; those pass
 * through with their code, message and data untouched.
 */
export const MCP_HOST_ERROR_CODE = 1001;

const HostErrorData = type({
	transport: "'http' | 'stdio' | 'unknown'",
	stage: "'connect' | 'send' | 'receive' | 'decode' | 'protocol'",
	failure:
		"'connect' | 'timeout' | 'eof' | 'reset' | 'malformed_response' | 'json_rpc' | 'http_status' | 'closed' | 'unknown'",
	retryable: "boolean",
	"code?": "string | number",
	"data?": "string",
	"traceId?": "string",
	"exit?": { "code?": "number", "signal?": "number", stderr: "string" },
});

/** `data` of a {@link MCP_HOST_ERROR_CODE} error: an {@link MCPTransportError}, field for field. */
export type McpHostErrorData = typeof HostErrorData.infer;

/**
 * The JSON-RPC error a host sends a session for `error`: the server's own
 * error when it has one, else a {@link MCP_HOST_ERROR_CODE} envelope.
 */
export function encodeHostError(error: MCPTransportError, exit?: McpUpstreamExit): JsonRpcError {
	if (error.rpc) return error.rpc;
	const data: McpHostErrorData = {
		transport: error.transport,
		stage: error.stage,
		failure: error.failure,
		retryable: error.retryable,
		code: error.code,
		data: error.data,
		traceId: error.traceId,
		exit,
	};
	return { code: MCP_HOST_ERROR_CODE, message: error.message, data };
}

/** Rebuild the {@link MCPTransportError} behind a {@link MCP_HOST_ERROR_CODE} error; undefined for any other error. */
export function decodeHostError(error: JsonRpcError): MCPTransportError | undefined {
	if (error.code !== MCP_HOST_ERROR_CODE) return undefined;
	const data = HostErrorData(error.data);
	if (data instanceof type.errors) return undefined;
	return new MCPTransportError({
		transport: data.transport,
		stage: data.stage,
		failure: data.failure,
		message: error.message,
		retryable: data.retryable,
		code: data.code,
		data: data.data,
		traceId: data.traceId,
	});
}

// ── framing ────────────────────────────────────────────────────────────────

/** One JSON-RPC message as a tunnel or stdio line. */
export function encodeJsonLine(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

/** Incremental decoder of newline-delimited JSON bytes: tunnels and subprocess pipes. */
export class JsonLineDecoder {
	readonly #decoder = new TextDecoder();
	#tail: string;

	/** `remainder` continues a stream cut mid-line, e.g. across a daemon re-exec. */
	constructor(remainder = "") {
		this.#tail = remainder;
	}

	/** Complete non-empty lines `chunk` finishes, in order. */
	push(chunk: Uint8Array): string[] {
		const text = this.#tail + this.#decoder.decode(chunk, { stream: true });
		const lines = text.split("\n");
		this.#tail = lines.pop() ?? "";
		return lines.filter(line => line.trim().length > 0);
	}

	/** Text received after the last newline. */
	remainder(): string {
		return this.#tail;
	}
}

// ── host access ────────────────────────────────────────────────────────────

/** Byte stream between one session and one unit. Satisfied by a daemon tunnel and by the in-process pipe. */
export interface McpTunnel {
	/** False once more than 1 MiB is unwritten; await {@link drained}. */
	send(data: string | Uint8Array): boolean;
	drained(): Promise<void>;
	/** Call once; chunks received earlier are buffered. */
	start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void;
	close(): void;
}

/** What a session asks of the host to reach one server. */
export interface McpAttachRequest {
	spec: McpServerSpec;
	era: McpEra;
	/** Configured server name, for the board label. */
	name: string;
	/** Owner of a handshake-era unit: one id per MCP manager, the same on every re-attach. */
	instance: string;
	/** Linger of an unleased modern unit, in milliseconds. */
	idleMs: number;
}

/** A session's hold on a unit. */
export interface McpAttachment {
	tunnel: McpTunnel;
	/** Drop the unit lease; the unit stops once nothing else holds it. Idempotent. */
	release(): void;
}

/** Where the units live. One implementation fronts the daemon, the other runs them in this process. */
export interface McpHostAccess {
	/** True when units are shared with other omp processes. */
	readonly shared: boolean;
	/** The server's era, probing it once when unknown. */
	resolve(spec: McpServerSpec, signal?: AbortSignal): Promise<McpResolveResult>;
	/** Find or start the unit and attach to it, taking a lease. */
	attach(request: McpAttachRequest, signal?: AbortSignal): Promise<McpAttachment>;
	/** The host was replaced (daemon restart): every attachment is gone and must be retaken. */
	onReconnect(sink: () => void): () => void;
}
