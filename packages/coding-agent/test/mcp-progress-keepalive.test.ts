import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { progressWindowMs, resolveMCPMaxTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import { PROGRESS_INTERVAL_MS, TOOL_DURATION_MS, TOOL_NAME, TOOL_RESULT } from "./fixtures/progress-tool-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "progress-tool-mcp.ts");
/** Short enough that the fixture's total work blows through it several times over. */
const REQUEST_TIMEOUT_MS = PROGRESS_INTERVAL_MS * 2;
const ORIGINAL_MAX_TIMEOUT = process.env.OMP_MCP_MAX_TIMEOUT_MS;

function connectFixture(args: string[] = []): StdioTransport {
	return new StdioTransport({
		type: "stdio",
		command: process.execPath,
		args: ["run", FIXTURE_PATH, ...args],
		timeout: REQUEST_TIMEOUT_MS,
	});
}

describe("MCP progress keepalive", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
		if (ORIGINAL_MAX_TIMEOUT === undefined) {
			delete process.env.OMP_MCP_MAX_TIMEOUT_MS;
		} else {
			process.env.OMP_MCP_MAX_TIMEOUT_MS = ORIGINAL_MAX_TIMEOUT;
		}
	});

	it("outlives its request timeout while the server reports progress", async () => {
		delete process.env.OMP_MCP_MAX_TIMEOUT_MS;
		transport = connectFixture();
		await transport.connect();

		const started = Date.now();
		const result = await transport.request<{ content: Array<{ text: string }> }>("tools/call", {
			name: TOOL_NAME,
			arguments: {},
		});

		// The echoed token proves the client asked for progress in the first place.
		expect(result.content[0]?.text).toBe(`${TOOL_RESULT}:1`);
		expect(Date.now() - started).toBeGreaterThanOrEqual(TOOL_DURATION_MS);
	});

	it("still times out when the server works silently past the deadline", async () => {
		delete process.env.OMP_MCP_MAX_TIMEOUT_MS;
		transport = connectFixture(["silent"]);
		await transport.connect();

		const error = await transport.request("tools/call", { name: TOOL_NAME, arguments: {} }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({ transport: "stdio", failure: "timeout" });
	});

	it("stops extending a call once the total ceiling is spent", async () => {
		process.env.OMP_MCP_MAX_TIMEOUT_MS = String(REQUEST_TIMEOUT_MS * 2);
		transport = connectFixture();
		await transport.connect();

		const error = await transport.request("tools/call", { name: TOOL_NAME, arguments: {} }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toMatchObject({ transport: "stdio", failure: "timeout" });
	});
});

describe("progressWindowMs", () => {
	it("grants another full window while the ceiling has room", () => {
		expect(progressWindowMs({ timeoutMs: 30_000, startedAt: 1_000, maxTimeoutMs: 600_000, now: 20_000 })).toBe(
			30_000,
		);
	});

	it("shortens the last window so the ceiling is not overshot", () => {
		expect(progressWindowMs({ timeoutMs: 30_000, startedAt: 1_000, maxTimeoutMs: 40_000, now: 20_000 })).toBe(21_000);
	});

	it("reports no window left once the ceiling is reached", () => {
		expect(progressWindowMs({ timeoutMs: 30_000, startedAt: 1_000, maxTimeoutMs: 10_000, now: 20_000 })).toBe(0);
	});

	it("never bounds the window when the ceiling is disabled", () => {
		expect(progressWindowMs({ timeoutMs: 30_000, startedAt: 1_000, maxTimeoutMs: 0, now: 5_000_000 })).toBe(30_000);
	});
});

describe("resolveMCPMaxTimeoutMs", () => {
	afterEach(() => {
		if (ORIGINAL_MAX_TIMEOUT === undefined) {
			delete process.env.OMP_MCP_MAX_TIMEOUT_MS;
		} else {
			process.env.OMP_MCP_MAX_TIMEOUT_MS = ORIGINAL_MAX_TIMEOUT;
		}
	});

	it("defaults to an hour", () => {
		delete process.env.OMP_MCP_MAX_TIMEOUT_MS;

		expect(resolveMCPMaxTimeoutMs()).toBe(60 * 60 * 1000);
	});

	it("honors the env override, including 0 for no ceiling", () => {
		process.env.OMP_MCP_MAX_TIMEOUT_MS = "0";

		expect(resolveMCPMaxTimeoutMs()).toBe(0);
	});
});
