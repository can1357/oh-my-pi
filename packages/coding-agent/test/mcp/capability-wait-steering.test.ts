/**
 * Steering cancels the in-flight capability wait. The built-in wait raced
 * steering in-process; as an MCP call the capability wait must be
 * interruptible, so the agent loop hands it the steering signal and the stdio
 * transport turns the steering abort into `notifications/cancelled` on the
 * wire (design 2026-10-24, Constraints: "steering abort expressed as
 * cancellation of the in-flight MCP request").
 */
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { CAPABILITY_SERVER_NAME } from "@oh-my-pi/pi-coding-agent/discovery/capability-server";
import { CustomToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/wrapper";
import * as mcpTimeout from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import type {
	JsonRpcNotification,
	JsonRpcRequest,
	MCPServerConnection,
	MCPToolDefinition,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type Frame = JsonRpcRequest | JsonRpcNotification;
const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "cancellable-mcp.ts");
// Real subprocess I/O must advance on the platform clock; fake timers cannot
// drive a child process's pipes. Every poll and wait below is bounded.
const POLL_MS = 5;
// Generous bounds for loaded CI hosts: passing runs return as soon as the event happens.
const OBSERVE_MS = 5_000;
// A blocked wait never settles on its own, so settling within this bound proves the abort settled it.
const SETTLE_MS = 2_000;
// bun's default 5s per-test timeout is shorter than the bounds above; each test
// covers a child-process spawn plus up to two observe windows and one settle bound.
const TEST_MS = 2 * OBSERVE_MS + SETTLE_MS + 5_000;
// The real server publishes its tools as agentmux_capability_<name> (snapshot:
// fixtures/capability-tools-list.jsonl), so the wait is not named plain "wait".
const WAIT_TOOL: MCPToolDefinition = {
	name: "agentmux_capability_wait",
	inputSchema: { type: "object", properties: {} },
};

async function within<T>(promise: Promise<T>): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`Call did not settle within ${SETTLE_MS}ms`)), SETTLE_MS);
	try {
		return await Promise.race([promise, expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("capability wait steering cancellation", () => {
	let transport: StdioTransport | undefined;
	let tempDir: string;
	let logPath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-capability-wait-steering-"));
		logPath = path.join(tempDir, "frames.jsonl");
		await Bun.write(logPath, "");
		// The registration disables the request deadline; keep that hermetic here.
		spyOn(mcpTimeout, "resolveMCPTimeoutMs").mockImplementation(timeout => timeout ?? 0);
	});

	afterEach(async () => {
		try {
			await transport?.close();
		} finally {
			transport = undefined;
			vi.restoreAllMocks();
			await removeWithRetries(tempDir);
		}
	});

	async function connect(serverName: string): Promise<MCPServerConnection> {
		transport = new StdioTransport({
			type: "stdio",
			command: process.execPath,
			args: [FIXTURE, logPath, "normal"],
			timeout: 0,
		});
		await transport.connect();
		await transport.request("initialize");
		await transport.notify("notifications/initialized");
		return { name: serverName, transport, capabilities: {} } as unknown as MCPServerConnection;
	}

	async function frames(): Promise<Frame[]> {
		const text = await Bun.file(logPath).text();
		return Bun.JSONL.parse(text.slice(0, text.lastIndexOf("\n") + 1)) as Frame[];
	}

	async function loggedUntil(predicate: (received: Frame[]) => boolean): Promise<Frame[]> {
		const deadline = performance.now() + OBSERVE_MS;
		let received: Frame[];
		do {
			received = await frames();
			if (predicate(received)) return received;
			await Bun.sleep(POLL_MS);
		} while (performance.now() < deadline);
		return received;
	}

	it(
		"a steering abort of the zero-arg capability wait sends notifications/cancelled for its request",
		async () => {
			const tool = new MCPTool(await connect(CAPABILITY_SERVER_NAME), WAIT_TOOL);
			// The agent loop only hands steering aborts to interruptible tools.
			expect(tool.interruptible({})).toBe(true);

			const steering = new AbortController();
			const outcome = tool.execute("wait-1", {}, undefined, {} as never, steering.signal).then(
				() => "settled",
				(error: unknown) => error,
			);
			const isWaitCall = (frame: Frame) =>
				"id" in frame && frame.method === "tools/call" && frame.params?.name === WAIT_TOOL.name;
			const sent = (await loggedUntil(log => log.some(isWaitCall))).find(isWaitCall) as JsonRpcRequest;
			expect(sent).toHaveProperty("id");

			steering.abort(TOOL_INTERRUPT_ABORT_REASON);

			// The call settles promptly as aborted instead of blocking for 30 minutes.
			expect(await within(outcome)).toBeInstanceOf(Error);
			const cancelled = (
				await loggedUntil(log => log.some(frame => frame.method === "notifications/cancelled"))
			).filter(frame => frame.method === "notifications/cancelled");
			expect(cancelled).toEqual([
				{
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: sent.id, reason: "Request cancelled by the client" },
				},
			]);
		},
		TEST_MS,
	);

	it(
		"only the capability server's blocking wait is interruptible",
		async () => {
			const capability = new MCPTool(await connect(CAPABILITY_SERVER_NAME), WAIT_TOOL);
			expect(capability.interruptible({ action: "status" })).toBe(true);
			// Quick writes keep today's non-interruptible semantics.
			expect(capability.interruptible({ action: "arm" })).toBe(false);
			// A same-named tool on another server never sees steering aborts.
			const other = new MCPTool(
				{ name: "other", transport, capabilities: {} } as unknown as MCPServerConnection,
				WAIT_TOOL,
			);
			expect(other.interruptible({})).toBe(false);
			// Steering only reaches a direct call: an `xd://`-mounted tool is called
			// through `write`, whose signal steering never aborts. The capability wait
			// therefore stays top-level, like the built-in wait it replaced.
			const wrappedCapability = CustomToolAdapter.wrap(capability, () => ({}) as never);
			const wrappedOther = CustomToolAdapter.wrap(other, () => ({}) as never);
			expect(wrappedCapability.loadMode).toBe("essential");
			expect(isMountableUnderXdev(wrappedCapability)).toBe(false);
			expect(isMountableUnderXdev(wrappedOther)).toBe(true);
		},
		TEST_MS,
	);
});
