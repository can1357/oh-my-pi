import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	formatMCPConnectionStatusMessage,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Behavioral wiring guard for MCP startup status (mirrors
 * interactive-mode-lsp-startup.test.ts). The SDK emits connection lifecycle
 * events, and InteractiveMode aggregates them into one live status line. This
 * pins the constructor-time subscription and the update path that replaces the
 * stale "Connecting…" banner when servers connect or fail.
 */
describe("InteractiveMode MCP connection status", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Keep ProcessTerminal.start() from probing the real terminal; the test
		// only drives the event bus and spies on showStatus.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-mcp-connecting-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, () => {}, [], undefined, eventBus);
		// This contract is the banner wiring, not git branch watching; a real
		// fs.watch in a parallel Bun worker can trip an unrelated-worker SIGTRAP.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("routes a mcp:connection-status event through the constructor-registered subscriber, before init()", () => {
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

		const serverNames = ["sequential", "critic", "shannon"];
		const event = { type: "connecting", serverNames } satisfies McpConnectionStatusEvent;
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);

		expect(showStatusSpy).toHaveBeenCalledWith(
			formatMCPConnectionStatusMessage({
				pendingServers: serverNames,
				connectedServers: [],
				failedServers: [],
			}),
		);
	});

	it("does not render the mcp:connection-status status when startup.quiet is enabled", () => {
		session.settings.set("startup.quiet", true);
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["sequential", "critic"],
		} satisfies McpConnectionStatusEvent);

		expect(showStatusSpy).not.toHaveBeenCalled();
	});

	it("updates the live MCP status as servers connect and fail", () => {
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["alpha", "broken", "slow"],
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "alpha",
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "failed",
			serverName: "broken",
			error: "missing command",
			sourcePath: "/tmp/codex/config.toml",
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "slow",
		} satisfies McpConnectionStatusEvent);

		expect(showStatusSpy.mock.calls.map(call => call[0])).toEqual([
			"Connecting to MCP servers: alpha, broken, slow…",
			"Connected: alpha. Still connecting: broken, slow…",
			"Connected: alpha. Failed: broken [config: /tmp/codex/config.toml]: missing command. Still connecting: slow…",
			"MCP finished with failures. Connected: alpha, slow. Failed: broken [config: /tmp/codex/config.toml]: missing command",
		]);
	});

	it("rejects a malformed mcp:connection-status payload via the guard instead of letting it throw", () => {
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, { wrong: "shape" });

		expect(showStatusSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
