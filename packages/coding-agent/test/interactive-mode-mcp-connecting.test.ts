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
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal, transcriptText } from "./helpers/mode-terminal";

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
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
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
		term = createModeTerminal({ columns: 120, rows: 10 });
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, eventBus, term.frame);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
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

		// Kept off native terminals' toasts: one per server change is noise.
		expect(showStatusSpy).toHaveBeenCalledWith(
			formatMCPConnectionStatusMessage({
				pendingServers: serverNames,
				connectedServers: [],
				failedServers: [],
			}),
			{ toast: false, key: "mcp-status" },
		);
	});

	it("does not render the mcp:connection-status status when startup.quiet is enabled", () => {
		cfgStartupQuiet.set(session.settings, true);
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

	it("retries one server without erasing other startup outcomes", () => {
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["alpha", "retry", "broken"],
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "alpha",
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "failed",
			serverName: "broken",
			error: "bad config",
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "failed",
			serverName: "retry",
			error: "timed out",
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "reconnecting",
			serverName: "retry",
		} satisfies McpConnectionStatusEvent);

		expect(showStatusSpy).toHaveBeenLastCalledWith(
			"Connected: alpha. Failed: broken: bad config. Still connecting: retry…",
			{ toast: false, key: "mcp-status" },
		);
	});

	it("keeps extension info notices shown during MCP startup and updates one MCP line", () => {
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["alpha"],
		} satisfies McpConnectionStatusEvent);
		mode.showHookNotify("A loaded", "info");
		mode.showHookNotify("B loaded", "info");
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "alpha",
		} satisfies McpConnectionStatusEvent);

		const transcript = transcriptText(mode.shell);
		expect(transcript).toContain("A loaded");
		expect(transcript).toContain("B loaded");
		expect(transcript).toContain("Connected to MCP server: alpha.");
		expect(transcript).not.toContain("Connecting to MCP servers");
	});

	it("appends the completed MCP status after its connecting line retired into scrollback", async () => {
		await term.start();
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["alpha"],
		} satisfies McpConnectionStatusEvent);
		for (const name of ["A", "B", "C", "D", "E"]) mode.showHookNotify(`${name} loaded`, "info");
		await term.settle();
		// The notices pushed the connecting line into terminal history: it can no longer be replaced.
		expect(term.scrollback().join("\n")).toContain("Connecting to MCP servers: alpha");
		expect(term.screen().join("\n")).not.toContain("Connecting to MCP servers");

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "alpha",
		} satisfies McpConnectionStatusEvent);
		await term.waitFor(screen => screen.join("\n").includes("Connected to MCP server: alpha."));
		const visible = term.screen().join("\n");
		expect(visible).not.toContain("Connecting to MCP servers");
		expect(visible).toContain("E loaded");
		// Written once, after the retired line: history is not rewritten.
		expect(term.text().match(/Connecting to MCP servers: alpha/g)).toHaveLength(1);
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
