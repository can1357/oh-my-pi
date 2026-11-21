/**
 * Where a session finds its MCP host: the daemon's `mcp` module when sharing
 * is on and a daemon with that module answers, else the host inside this
 * process.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir, daemonClient } from "../../daemon/client";
import { type DaemonClient, GLOBAL_SCOPE, projectScope } from "../../daemon/protocol";
import { createMCPJsonRpcError } from "../errors";
import {
	decodeHostError,
	MCP_MODULE_KIND,
	MCP_MODULE_VERSION,
	MCP_RESOLVE_METHOD,
	type McpAttachment,
	type McpAttachRequest,
	type McpHostAccess,
	type McpResolveReply,
	type McpResolveResult,
	type McpServerSpec,
	type McpUnitParams,
	mcpUnitKey,
	mcpUnitPolicy,
} from "./contract";
import { localMcpHost } from "./local";

// The newest hold decides; with none sharing is off, so embedders and tests
// that build an MCP manager directly never touch the daemon.
interface SharedMcpHold {
	enabled: boolean;
}
const sharedMcpHolds: SharedMcpHold[] = [];

/** Hold daemon-shared MCP at `enabled` until released; `set` follows later setting changes. */
export function holdSharedMcp(enabled: boolean): { set(enabled: boolean): void; release(): void } {
	const hold: SharedMcpHold = { enabled };
	sharedMcpHolds.push(hold);
	return {
		set(next) {
			hold.enabled = next;
		},
		release() {
			const index = sharedMcpHolds.indexOf(hold);
			if (index !== -1) sharedMcpHolds.splice(index, 1);
		},
	};
}

/** Units in the daemon's `mcp` module, shared with every omp process of this user. */
class DaemonMcpAccess implements McpHostAccess {
	readonly shared = true;
	readonly #daemon: DaemonClient;

	constructor(daemon: DaemonClient) {
		this.#daemon = daemon;
	}

	/** @throws MCPTransportError the probe failed with, rebuilt from the module's reply. */
	async resolve(spec: McpServerSpec, signal?: AbortSignal): Promise<McpResolveResult> {
		const reply = await this.#daemon.call<McpResolveReply>(MCP_MODULE_KIND, MCP_RESOLVE_METHOD, spec, { signal });
		if ("error" in reply) throw decodeHostError(reply.error) ?? createMCPJsonRpcError("unknown", reply.error);
		return reply;
	}

	async attach(request: McpAttachRequest, signal?: AbortSignal): Promise<McpAttachment> {
		const { spec, era, name } = request;
		const scope = spec.transport === "stdio" ? projectScope(await canonicalProjectDir(spec.cwd)) : GLOBAL_SCOPE;
		const params: McpUnitParams = { spec, era, name, idleMs: request.idleMs };
		signal?.throwIfAborted();
		// `open` is quick and not abortable: an abandoned answer would leave a lease this process can never drop.
		const opened = await this.#daemon.open({
			kind: MCP_MODULE_KIND,
			scope,
			key: mcpUnitKey(spec, era, request.instance),
			params,
			policy: mcpUnitPolicy(spec, era, request.idleMs),
			label: `mcp ${name}`,
		});
		let lease = opened.lease;
		const release = (): void => {
			if (lease) void this.#daemon.release(lease).catch(() => {});
			lease = undefined;
		};
		try {
			signal?.throwIfAborted();
			return { tunnel: await this.#daemon.attach(opened.unit.id, undefined, signal), release };
		} catch (error) {
			release();
			throw error;
		}
	}

	onReconnect(sink: () => void): () => void {
		return this.#daemon.onReconnect(sink);
	}
}

/**
 * The host this process's MCP links attach to right now. Never fails: any
 * problem reaching a daemon that serves MCP means the in-process host.
 */
export async function mcpHostAccess(): Promise<McpHostAccess> {
	if (sharedMcpHolds.at(-1)?.enabled) {
		try {
			const daemon = await daemonClient();
			if (daemon.welcome.caps[MCP_MODULE_KIND] === MCP_MODULE_VERSION) return new DaemonMcpAccess(daemon);
			logger.debug("Daemon lacks the mcp module; hosting MCP servers in-process");
		} catch (error) {
			logger.debug("Daemon unavailable; hosting MCP servers in-process", { error: String(error) });
		}
	}
	return localMcpHost();
}
