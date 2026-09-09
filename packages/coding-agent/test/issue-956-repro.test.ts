import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as mcpConfigWriter from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import {
	createInteractiveModeContext,
	createMcpManagerStub,
	type ContextOverrides,
} from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

type RenderableBlock = {
	render: (width: number) => readonly string[];
	isTranscriptBlockFinalized: () => boolean;
};

function isRenderableBlock(component: Component): component is Component & RenderableBlock {
	return "isTranscriptBlockFinalized" in component && typeof component.isTranscriptBlockFinalized === "function";
}

function createController(overrides: ContextOverrides = {}) {
	const mcpManager = createMcpManagerStub(overrides.mcpManager);
	const ctx = createInteractiveModeContext({ ...overrides, mcpManager });
	return { controller: new MCPCommandController(ctx), ctx, mcpManager };
}

describe("interactive /mcp test", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-956-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-956-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);

		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify(
				{
					mcpServers: {
						github: {
							type: "stdio",
							command: "github-mcp-server",
							args: ["serve"],
						},
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	it("tests a discovered server and keeps its advertised Esc cancellation grace", async () => {
		vi.useFakeTimers();
		const transport = {
			connected: true,
			request: vi.fn(),
			notify: vi.fn(),
			close: vi.fn(async () => {}),
		};
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport,
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		const disconnectServer = vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const { controller, ctx } = createController({ mcpTestEscapeHandlers });
		const { showError, showStatus } = ctx;

		await controller.handle("/mcp test github");
		const signal = connectToServer.mock.calls[0]?.[2]?.signal;
		expect(signal?.aborted).toBe(false);
		expect(mcpTestEscapeHandlers).toHaveLength(1);

		// The settled hint must stop advertising Esc the moment cancellation is
		// impossible, or a later press kills the running agent turn instead.
		const rendered = ctx.chatContainer.children.map(block => block.render(80).join("\n")).join("\n");
		expect(rendered).toContain(`Tested connection to "github".`);
		expect(rendered).not.toContain("(esc to cancel)");

		// The grace window still holds while untouched...
		vi.advanceTimersByTime(4_999);
		expect(mcpTestEscapeHandlers).toHaveLength(1);

		// ...and a press inside it gives feedback instead of silently aborting
		// the (already-settled) test controller.
		// oxlint-disable-next-line unicorn/no-useless-spread -- handlers are removed while dispatching
		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler); // mirrors InputController's consume-on-dispatch
			handler();
		}
		expect(showStatus).toHaveBeenCalledWith(`MCP test for "github" already finished`);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(mcpTestEscapeHandlers).toHaveLength(0);

		expect(showError).not.toHaveBeenCalled();
		expect(connectToServer).toHaveBeenCalledWith(
			"github",
			expect.objectContaining({ command: "github-mcp-server", args: ["serve"] }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(listTools).toHaveBeenCalledWith(connection, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(disconnectServer).toHaveBeenCalledWith(connection);
		expect(ctx.ui.requestRender).toHaveBeenCalled();
	});

	it("cancelling a pending test consumes Esc ownership without a grace window", async () => {
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, _config, options) => {
			const { promise, reject } = Promise.withResolvers<never>();
			const signal = options?.signal;
			if (!signal) return promise;
			const abort = () => {
				const error = new Error("aborted");
				error.name = "AbortError";
				reject(error);
			};
			// Esc can fire while earlier awaits (config lookup) are still pending,
			// so the signal may already be aborted when the connection starts.
			if (signal.aborted) {
				abort();
			} else {
				signal.addEventListener("abort", abort);
			}
			return promise;
		});
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const { promise: lookup, resolve: resolveLookup } = Promise.withResolvers<{
			mcpServers: Record<string, { type: string; command: string; args: string[] }>;
		}>();
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockReturnValue(lookup as never);
		const { promise: hintPresented, resolve: hintResolve } = Promise.withResolvers<void>();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const { controller, ctx } = createController({ mcpTestEscapeHandlers });
		const { showStatus } = ctx;
		const addChild = ctx.chatContainer.addChild.bind(ctx.chatContainer);
		vi.spyOn(ctx.chatContainer, "addChild").mockImplementation(component => {
			addChild(component);
			hintResolve();
		});

		const pending = controller.handle("/mcp test github");
		expect(mcpTestEscapeHandlers).toHaveLength(1);

		resolveLookup({
			mcpServers: { github: { type: "stdio", command: "github-mcp-server", args: ["serve"] } },
		});
		// Let the hint render before cancelling: this exercises the post-hint
		// cancellation path (connect still pending), not the pre-hint bailout.
		await hintPresented;
		const presented = ctx.chatContainer.children.filter(isRenderableBlock);
		// keeps re-rendering it (post-settlement rewrite stays visible).
		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(false);

		// Consume like InputController does: clear the set, then fire.
		// oxlint-disable-next-line unicorn/no-useless-spread -- handlers are removed while dispatching
		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}
		await pending;

		expect(showStatus).toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
		expect(showStatus).not.toHaveBeenCalledWith(`MCP test for "github" already finished`);
		// Ownership was consumed by the press: the finally block must NOT re-arm
		// a 5s grace window that would silently swallow the next Esc.
		expect(mcpTestEscapeHandlers).toHaveLength(0);
		expect(connectToServer).toHaveBeenCalledTimes(1);

		// The hint must stop advertising esc immediately on cancellation, read
		// as cancelled (not completed), and be sealed for scrollback history.
		expect(presented).toHaveLength(1);
		const rendered = presented.map(block => block.render(80).join("\n")).join("\n");
		expect(rendered).toContain(`Cancelled connection test for "github".`);
		expect(rendered).not.toContain("(esc to cancel)");
		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(true);
	});

	it("treats an abort landing during manager sync as a completed test", async () => {
		const transport = {
			connected: true,
			request: vi.fn(),
			notify: vi.fn(),
			close: vi.fn(async () => {}),
		};
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport,
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const { promise: hintPresented, resolve: hintResolve } = Promise.withResolvers<void>();
		const { promise: syncStarted, resolve: syncStartedResolve } = Promise.withResolvers<void>();
		const { promise: syncGate, resolve: syncResolve } = Promise.withResolvers<void>();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const { controller, ctx } = createController({
			mcpTestEscapeHandlers,
			mcpManager: {
				getConnectionStatus: vi.fn(() => "disconnected" as const),
				connectServers: vi.fn(async () => {
					syncStartedResolve();
					await syncGate;
					return {
						tools: [],
						errors: new Map<string, string>(),
						connectedServers: [],
						exaApiKeys: [],
					};
				}),
			},
		});
		const { showStatus } = ctx;
		const addChild = ctx.chatContainer.addChild.bind(ctx.chatContainer);
		vi.spyOn(ctx.chatContainer, "addChild").mockImplementation(component => {
			addChild(component);
			hintResolve();
		});

		const pending = controller.handle("/mcp test github");
		await hintPresented;
		const presented = ctx.chatContainer.children;

		// Wait until the test is past listTools and inside #syncManagerConnection:
		// an abort here does not observe the signal, so the flow still completes.
		await syncStarted;
		// oxlint-disable-next-line unicorn/no-useless-spread -- handlers are removed while dispatching
		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}
		syncResolve();
		await pending;

		const rendered = presented.map(block => block.render(80).join("\n")).join("\n");
		expect(rendered).toContain(`Successfully connected to "github"`);
		expect(rendered).toContain(`Tested connection to "github".`);
		expect(rendered).not.toContain("Cancelled connection test");
		expect(showStatus).not.toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
		expect(presented.find(isRenderableBlock)?.isTranscriptBlockFinalized()).toBe(true);
	});

	it("aborts during the awaited lookup without ever advertising esc", async () => {
		const { promise: lookup, resolve } = Promise.withResolvers<{
			mcpServers: Record<string, { type: string; command: string; args: string[] }>;
		}>();
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockReturnValue(lookup as never);
		const mcpTestEscapeHandlers = new Set<() => void>();
		const { controller, ctx } = createController({ mcpTestEscapeHandlers });
		const { presentCommandOutput, showStatus } = ctx;

		const pending = controller.handle("/mcp test github");
		expect(mcpTestEscapeHandlers).toHaveLength(1);

		// Esc lands while the config lookup is still awaiting: the dispatcher
		// consumes ownership, and the resumed handler must not render a hint.
		// oxlint-disable-next-line unicorn/no-useless-spread -- handlers are removed while dispatching
		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}
		resolve({
			mcpServers: { github: { type: "stdio", command: "github-mcp-server", args: ["serve"] } },
		});
		await pending;

		expect(presentCommandOutput).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
		expect(mcpTestEscapeHandlers).toHaveLength(0);
	});

	it("cancels while the awaited lookup is still pending", async () => {
		// The config read never settles (e.g. config on a stuck network FS).
		const { promise: lookup } = Promise.withResolvers<{
			mcpServers: Record<string, { type: string; command: string; args: string[] }>;
		}>();
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockReturnValue(lookup as never);
		const mcpTestEscapeHandlers = new Set<() => void>();
		const { controller, ctx } = createController({ mcpTestEscapeHandlers });
		const { presentCommandOutput, showStatus } = ctx;

		const pending = controller.handle("/mcp test github");
		expect(mcpTestEscapeHandlers).toHaveLength(1);

		// Esc lands during the stuck read; consume like InputController does.
		// oxlint-disable-next-line unicorn/no-useless-spread -- handlers are removed while dispatching
		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}

		// The command must settle now, while the read is STILL pending — the
		// lookup is never resolved. Racing the abort signal makes `handle`
		// resolve; the old post-lookup check would hang until the read settled.
		await pending;

		expect(presentCommandOutput).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
		expect(mcpTestEscapeHandlers).toHaveLength(0);
	});

	it("claims Esc ownership before the awaited server lookup", async () => {
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport: { connected: true, request: vi.fn(), notify: vi.fn(), close: vi.fn(async () => {}) },
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const { controller } = createController({ mcpTestEscapeHandlers });

		// Do not await: the handler must be registered synchronously, before the
		// awaited `#resolveServerForAuth()` config read can suspend and let Esc
		// fall through to aborting the agent turn.
		const pending = controller.handle("/mcp test github");
		expect(mcpTestEscapeHandlers).toHaveLength(1);
		await pending;
	});

	it("releases Esc immediately when lookup fails before the hint is shown", async () => {
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockRejectedValue(new Error("EACCES: config unreadable"));
		const connectToServer = vi.spyOn(mcpClient, "connectToServer");
		const mcpTestEscapeHandlers = new Set<() => void>();
		const { controller, ctx } = createController({ mcpTestEscapeHandlers });
		const { showError } = ctx;

		await controller.handle("/mcp test github");

		// The "(esc to cancel)" hint never rendered, so no grace window applies:
		// Esc must be free again immediately instead of being swallowed for 5s.
		expect(mcpTestEscapeHandlers).toHaveLength(0);
		expect(connectToServer).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalled();
	});
});
