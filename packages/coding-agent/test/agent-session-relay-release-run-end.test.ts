/**
 * `browser.relayReleaseOnRunEnd` lets go of the session's relay tabs once its run ends, never between the model
 * turns of one run: reattaching resets the tab's worker state, which the run's next tool call may still rely on.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as tabSupervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("relay tab release at run end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let release: Mock<typeof tabSupervisor.releaseRelayTabsForOwner>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-relay-release-run-end-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		release = spyOn(tabSupervisor, "releaseRelayTabsForOwner").mockResolvedValue(0);
	});

	afterEach(async () => {
		release.mockRestore();
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	/** A run of two model turns: a tool call, then the answer. Returns the releases seen when the second turn began. */
	async function runTwoTurns(enabled: boolean): Promise<number> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		let releasesAtSecondTurn = -1;
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls++;
				if (calls === 1) return { content: [{ type: "toolCall", name: "probe", arguments: {} }] };
				releasesAtSecondTurn = release.mock.calls.length;
				return { content: ["done"] };
			},
		});
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Stands in for a browser call",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [probe] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"browser.relayReleaseOnRunEnd": enabled,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.prompt("Use the probe, then answer");
		await session.waitForRunEnd();
		// The release is started detached from the run's end.
		await Bun.sleep(0);
		expect(calls).toBe(2);
		return releasesAtSecondTurn;
	}

	it("lets go of the session's relay tabs once, after the run's last turn", async () => {
		expect(await runTwoTurns(true)).toBe(0);
		expect(release).toHaveBeenCalledTimes(1);
		expect(release.mock.calls[0]?.[0]).toBeString();
	});

	it("leaves relay tabs alone when the setting is off", async () => {
		await runTwoTurns(false);
		expect(release).not.toHaveBeenCalled();
	});
});
