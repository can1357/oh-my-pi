import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("issue #775: per-model defaultLevel", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-775-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function getOpus() {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("expected claude-opus-4-5");
		return model;
	}

	function getSonnet() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5");
		return model;
	}

	async function createSession(initialModel: Model, settings: Settings) {
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setThinkingLevel(Effort.Low);
	}

	function withDefaultLevel(model: Model, defaultLevel: Effort): Model {
		return {
			...model,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				defaultLevel,
			},
		};
	}

	it("setModel carries the current level over the target's defaultLevel, clamped to its ladder", async () => {
		const opus47 = getBundledModel("anthropic", "claude-opus-4-7");
		if (!opus47) throw new Error("expected claude-opus-4-7");
		await createSession(opus47, Settings.isolated({ defaultThinkingLevel: Effort.Medium }));
		session.setThinkingLevel(Effort.Max);

		await session.setModel(withDefaultLevel(getOpus(), Effort.Medium));

		// The target has no max: the nearest level is xhigh, not its medium default.
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("setModel adopts the target's defaultLevel when the session has no level to carry", async () => {
		await createSession(getSonnet(), Settings.isolated({ defaultThinkingLevel: Effort.Medium }));
		session.setThinkingLevel(undefined);

		await session.setModel(withDefaultLevel(getOpus(), Effort.XHigh));

		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});
});
