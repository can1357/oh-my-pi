import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { mcpUpstreams } from "@oh-my-pi/pi-coding-agent/mcp/host/peers";
import { MCP_LEGACY_TTL_MS } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import { MCP_PROTOCOL_VERSION, MCPMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { INSTRUCTIONS, PROTOCOL_VERSION } from "../fixtures/modern-mcp";
import { SERVER_INSTRUCTIONS } from "../fixtures/instructions-mcp";
import { FIXTURES, isAlive, realDeps, stdioSpec } from "./upstream-support";

describe("era probe of a subprocess server", () => {
	it("classifies a server that answers server/discover as modern and leaves no process behind", async () => {
		const deps = realDeps();
		const result = await mcpUpstreams.probe(stdioSpec(path.join(FIXTURES, "modern-mcp.ts")), deps);

		expect(result.era).toBe("modern");
		expect(result.discover?.supportedVersions).toEqual([PROTOCOL_VERSION]);
		expect(result.discover?.instructions).toBe(INSTRUCTIONS);
		expect(result.discover?.cacheScope).toBe("public");
		expect(deps.pids).toHaveLength(1);
		expect(isAlive(deps.pids[0])).toBe(false);
	});

	it("classifies a handshake-era server as legacy and builds its discover result from initialize", async () => {
		const deps = realDeps();
		const result = await mcpUpstreams.probe(stdioSpec(path.join(FIXTURES, "instructions-mcp.ts")), deps);

		expect(result.era).toBe("legacy");
		expect(result.discover).toEqual({
			resultType: "complete",
			supportedVersions: [MCP_PROTOCOL_VERSION],
			capabilities: { tools: {} },
			instructions: SERVER_INSTRUCTIONS,
			ttlMs: MCP_LEGACY_TTL_MS,
			cacheScope: "private",
			_meta: { [MCPMeta.serverInfo]: { name: "instr-fixture", version: "1.0.0" } },
		});
		expect(isAlive(deps.pids[0])).toBe(false);
	});

	it("treats an ordinary method-not-found answer to server/discover as legacy", async () => {
		const deps = realDeps();
		const log = path.join(import.meta.dir, `.probe-frames-${process.pid}.log`);
		try {
			const result = await mcpUpstreams.probe(stdioSpec(path.join(FIXTURES, "cancellable-mcp.ts"), [log]), deps);
			expect(result.era).toBe("legacy");
			expect(result.discover?._meta?.[MCPMeta.serverInfo]).toEqual({
				name: "cancellable-fixture",
				version: "1.0.0",
			});
		} finally {
			await Bun.file(log)
				.delete()
				.catch(() => {});
		}
	});

	it("fails with the exit code and stderr when the server exits instead of answering", async () => {
		const deps = realDeps();
		const spec = stdioSpec("-e", ["process.stderr.write('fixture exploded'); process.exit(7)"]);

		const failure = await mcpUpstreams.probe(spec, deps).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		if (!(failure instanceof MCPTransportError)) return;
		expect(failure.transport).toBe("stdio");
		expect(failure.code).toBe(7);
		expect(failure.message).toContain("fixture exploded");
		expect(isAlive(deps.pids[0])).toBe(false);
	});

	it("gives up on a silent server once the spec's bound passes, and kills it", async () => {
		const deps = realDeps();
		const spec = stdioSpec("-e", ["setInterval(() => {}, 60_000)"]);
		spec.timeoutMs = 300;

		const failure = await mcpUpstreams.probe(spec, deps).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		if (!(failure instanceof MCPTransportError)) return;
		expect(failure.failure).toBe("timeout");
		expect(isAlive(deps.pids[0])).toBe(false);
	});
});
