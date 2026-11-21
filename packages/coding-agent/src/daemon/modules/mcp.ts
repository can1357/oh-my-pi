/**
 * `mcp` daemon module: the MCP host shared by every omp session.
 *
 * One unit is one upstream MCP server ({@link McpEndpoint}), keyed by
 * `mcpUnitKey`: a modern server is a single unit for all sessions, a
 * handshake-era one a unit per MCP manager. Sessions ask
 * {@link MCP_RESOLVE_METHOD} for a server's era, `open` its unit and `attach`
 * a tunnel speaking newline-delimited MCP 2026-07-28. The store with era
 * records and cached results lives in the module's state directory.
 */
import { type } from "@oh-my-pi/omptype";
import { isRecord } from "@oh-my-pi/pi-utils";
import { normalizeMCPTransportError } from "../../mcp/errors";
import {
	encodeHostError,
	MCP_MODULE_KIND,
	MCP_MODULE_VERSION,
	MCP_RESOLVE_METHOD,
	type McpEra,
	type McpResolveReply,
	type McpServerSpec,
	type McpUnitParams,
	mcpUnitPolicy,
} from "../../mcp/host/contract";
import { McpEndpoint, McpEraResolver } from "../../mcp/host/endpoint";
import type { McpPeerState } from "../../mcp/host/peer";
import { mcpUpstreams } from "../../mcp/host/peers";
import { McpStore } from "../../mcp/host/store";
import type { DaemonModule } from "../module";

const StdioSpec = type({
	transport: "'stdio'",
	command: "string",
	args: "string[]",
	cwd: "string",
	env: "Record<string, string>",
	spawnEnv: "Record<string, string>",
	timeoutMs: "number",
	"requestIdFormat?": "'string' | 'number'",
});
const RemoteSpec = type({
	transport: "'http' | 'sse'",
	url: "string",
	headers: "Record<string, string>",
	timeoutMs: "number",
	"headerPolicy?": "'origin-locked'",
	"requestIdFormat?": "'string' | 'number'",
});
const PeerState = type({
	child: { pid: "number", startedAt: "number", stdin: "number", stdout: "number", stderr: "number" },
	state: "unknown",
});

function parseSpec(value: unknown): McpServerSpec {
	const spec = isRecord(value) && value.transport === "stdio" ? StdioSpec(value) : RemoteSpec(value);
	if (spec instanceof type.errors) throw new Error(`invalid mcp server spec: ${spec.summary}`);
	return spec;
}

function parseUnitParams(value: unknown): McpUnitParams {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.idleMs !== "number") {
		throw new Error("invalid mcp unit params");
	}
	return { spec: parseSpec(value.spec), era: parseEra(value.era), name: value.name, idleMs: value.idleMs };
}

function parseEra(value: unknown): McpEra {
	if (value !== "modern" && value !== "legacy") throw new Error(`invalid mcp era: ${String(value)}`);
	return value;
}

let store: McpStore | undefined;
let resolver: McpEraResolver | undefined;

/** The MCP host: one unit per upstream server, shared according to its era. */
export const mcpModule: DaemonModule = {
	kind: MCP_MODULE_KIND,
	version: MCP_MODULE_VERSION,
	policy(params) {
		const unit = parseUnitParams(params);
		return mcpUnitPolicy(unit.spec, unit.era, unit.idleMs);
	},
	init(context) {
		store = McpStore.open(context.stateDir);
		resolver = new McpEraResolver(store, mcpUpstreams, spec => context.spawn(spec));
	},
	open(context, request) {
		if (!store) throw new Error("mcp module is not initialized");
		const params = parseUnitParams(request.params);
		return new McpEndpoint({
			unitId: request.unitId,
			spec: params.spec,
			era: params.era,
			name: params.name,
			store,
			upstreams: mcpUpstreams,
			deps: { spawn: spec => context.spawn(spec) },
			idleMs: params.idleMs,
			changed: unitId => context.changed(unitId),
		});
	},
	async call(_context, method, params) {
		if (method !== MCP_RESOLVE_METHOD) throw new Error(`unknown mcp method: ${method}`);
		if (!resolver) throw new Error("mcp module is not initialized");
		const spec = parseSpec(params);
		let reply: McpResolveReply;
		try {
			reply = { era: await resolver.resolve(spec) };
		} catch (error) {
			// A rejected call reaches the client as a bare string; the session needs the structured failure.
			const failure = normalizeMCPTransportError(error, {
				transport: spec.transport === "stdio" ? "stdio" : "http",
				stage: "connect",
			});
			reply = { error: encodeHostError(failure) };
		}
		return reply;
	},
	async restore(context, request, state) {
		if (!store || !isRecord(state) || typeof state.name !== "string" || typeof state.idleMs !== "number") {
			return undefined;
		}
		let peer: McpPeerState | undefined;
		if (state.peer !== undefined) {
			const parsed = PeerState(state.peer);
			if (parsed instanceof type.errors) return undefined;
			peer = parsed;
		}
		return new McpEndpoint({
			unitId: request.unitId,
			spec: parseSpec(state.spec),
			era: parseEra(state.era),
			name: state.name,
			store,
			upstreams: mcpUpstreams,
			deps: { spawn: spec => context.spawn(spec) },
			idleMs: state.idleMs,
			changed: unitId => context.changed(unitId),
			restore: peer && { peer, adopt: child => context.adoptChild(child) },
		});
	},
	async dispose() {
		// Probes write their verdict to the store; they must be gone before it closes.
		await resolver?.dispose();
		resolver = undefined;
		store?.close();
		store = undefined;
	},
};
