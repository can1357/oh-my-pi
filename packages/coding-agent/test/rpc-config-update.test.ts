import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { snapshotReplaySettings } from "@oh-my-pi/pi-coding-agent/modes/controllers/setting-side-effects";
import { emitRpcConfigUpdate } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../src/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("emitRpcConfigUpdate", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-rpc-config-update-");
		setAgentDir(tempDir.path());
		await Settings.init({ agentDir: tempDir.path(), inMemory: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("replays changed session settings before emitting the config_update frame", async () => {
		const order: string[] = [];
		const session = {
			settings,
			setThinkingLevel: () => {},
			refreshBaseSystemPrompt: async () => {
				order.push("prompt");
			},
			applyMemoryBackend: async () => {
				order.push("memory");
			},
			setThinkToolEnabled: async (enabled: boolean) => {
				order.push(`think:${enabled}`);
				return true;
			},
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "high",
		} as unknown as AgentSession;
		const beforeReplay = snapshotReplaySettings(settings);
		settings.set("externalThinking", true);
		settings.set("memory.backend", "local");

		const frames: object[] = [];
		await emitRpcConfigUpdate(
			session,
			obj => {
				order.push("frame");
				frames.push(obj);
			},
			beforeReplay,
		);

		// The replay of every changed session-level setting precedes the host update.
		expect(order[order.length - 1]).toBe("frame");
		expect(order.filter(entry => entry.startsWith("think:"))).toEqual(["think:true"]);
		expect(order.filter(entry => entry === "memory")).toEqual(["memory"]);
		expect(frames).toEqual([
			{ type: "config_update", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" },
		]);
	});

	it("replays mcp.notifications through the host-supplied manager before the frame", async () => {
		const order: string[] = [];
		const session = {
			settings,
			setThinkingLevel: () => {},
			refreshBaseSystemPrompt: async () => {},
			applyMemoryBackend: async () => {},
			setThinkToolEnabled: async () => true,
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "high",
		} as unknown as AgentSession;
		const beforeReplay = snapshotReplaySettings(settings);
		settings.set("mcp.notifications", true);

		const frames: object[] = [];
		await emitRpcConfigUpdate(
			session,
			obj => {
				order.push("frame");
				frames.push(obj);
			},
			beforeReplay,
			{ mcpManager: { setNotificationsEnabled: enabled => order.push(`mcp:${enabled}`) } },
		);

		// The subscription sweep runs inside the replay, before the host ack —
		// the next prompt must not start against stale subscription state.
		expect(order).toEqual(["mcp:true", "frame"]);
		expect(frames).toEqual([
			{ type: "config_update", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" },
		]);
	});

	it("does not reset a session-only thinking level when nothing changed", async () => {
		settings.set("defaultThinkingLevel", Effort.High);
		const thinkingLevels: unknown[] = [];
		const session = {
			settings,
			setThinkingLevel: (level: unknown) => {
				thinkingLevels.push(level);
			},
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "low",
		} as unknown as AgentSession;
		// Snapshot after the disk value settled: the reload is a no-op, so the
		// session-only "low" must survive and the frame still emits.
		const beforeReplay = snapshotReplaySettings(settings);

		const frames: object[] = [];
		await emitRpcConfigUpdate(
			session,
			obj => {
				frames.push(obj);
			},
			beforeReplay,
		);

		expect(thinkingLevels).toEqual([]);
		expect(frames).toEqual([
			{ type: "config_update", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "low" },
		]);
	});

	it("does not emit the config_update frame until the replayed mutation settles", async () => {
		let releaseThinkTool!: (enabled: boolean) => void;
		const thinkToolGate = new Promise<boolean>(resolve => {
			releaseThinkTool = resolve;
		});
		const order: string[] = [];
		const session = {
			settings,
			setThinkingLevel: () => {},
			refreshBaseSystemPrompt: async () => {},
			applyMemoryBackend: async () => {},
			setThinkToolEnabled: async () => {
				order.push("think:start");
				await thinkToolGate;
				order.push("think:done");
				return true;
			},
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "high",
		} as unknown as AgentSession;
		const beforeReplay = snapshotReplaySettings(settings);
		settings.set("externalThinking", true);

		const frames: object[] = [];
		const update = emitRpcConfigUpdate(
			session,
			obj => {
				order.push("frame");
				frames.push(obj);
			},
			beforeReplay,
		);

		// Deterministic gate, no wall-clock sleep: while the think-tool
		// re-registration is in flight the host has not been acknowledged —
		// the fire-and-forget replay let the frame overtake the mutation.
		await Promise.resolve();
		expect(order).toEqual(["think:start"]);
		expect(frames).toEqual([]);

		releaseThinkTool(true);
		await update;
		expect(order).toEqual(["think:start", "think:done", "frame"]);
		expect(frames).toEqual([
			{ type: "config_update", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" },
		]);
	});
});
