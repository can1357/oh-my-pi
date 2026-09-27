import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildProfileSnapshot } from "@oh-my-pi/pi-coding-agent/profiles/snapshot";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("profile snapshots", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@omp-profile-snapshot-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(path.join(projectDir, ".omp", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		setAgentDir(agentDir);
		setProjectDir(projectDir);
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	});

	afterEach(async () => {
		authStorage.close();
		restoreSettingsTestState(state);
		state = undefined;
		await tempDir.remove();
	});

	async function registry(settings: Settings): Promise<ModelRegistry> {
		return new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	}

	it("projects only meaningful finite nonnegative token prices", async () => {
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const modelRegistry = await registry(settings);
		const baseModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected the pricing fixture in the bundled catalog");
		const costs = [
			{ input: 0, output: 15, cacheRead: 0, cacheWrite: 0 },
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			{ input: -1, output: 15, cacheRead: 0, cacheWrite: 0 },
			{ input: 3, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 },
		];
		const snapshots = await Promise.all(
			costs.map(cost =>
				buildProfileSnapshot({ cwd: projectDir, settings, modelRegistry, currentModel: { ...baseModel, cost } }),
			),
		);
		expect(snapshots[0]?.roles.find(row => row.role === "default")?.cost).toEqual(costs[0]);
		for (const snapshot of snapshots.slice(1)) {
			expect(snapshot.roles.find(row => row.role === "default")?.cost).toBeUndefined();
		}
	});

	it("resolves non-chat roles and a prototype-named project agent from their own model pools", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: {
					image: "openai/chatgpt-image-latest",
					speech: "local/kokoro",
					dictation: "local/whisper-base",
					tiny: "local/falcon-h1-90m",
				},
			}),
		);
		await Bun.write(
			path.join(projectDir, ".omp", "agents", "toString.md"),
			[
				"---",
				"name: toString",
				"description: Prototype-named fixture",
				"model: anthropic/claude-sonnet-4-5",
				"---",
				"Fixture prompt.",
			].join("\n"),
		);
		authStorage.keys.setRuntime("openai", "fixture-key");
		authStorage.keys.setRuntime("anthropic", "fixture-key");
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const modelRegistry = await registry(settings);
		const currentModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!currentModel) throw new Error("Expected bundled chat model fixture");

		const snapshot = await buildProfileSnapshot({ cwd: projectDir, settings, modelRegistry, currentModel });

		const resolved = (role: string) => {
			const row = snapshot.roles.find(item => item.role === role);
			return `${row?.provider}/${row?.modelId}`;
		};
		expect(resolved("default")).toBe("anthropic/claude-sonnet-4-5");
		expect(resolved("image")).toBe("openai/chatgpt-image-latest");
		expect(resolved("speech")).toBe("local/kokoro");
		expect(resolved("dictation")).toBe("local/whisper-base");
		expect(resolved("tiny")).toBe("local/falcon-h1-90m");
		expect(snapshot.agents.find(row => row.name === "toString")).toMatchObject({
			selector: "anthropic/claude-sonnet-4-5",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
	});

	it("reports the live model and thinking for the current profile and never serializes secrets", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				auth: { broker: { url: "https://broker.example.test/path?token=url-secret", token: "broker-secret" } },
				modelRoles: {
					default: "anthropic/claude-sonnet-4-5:high",
					review: "extension-provider/private-extension-model",
				},
				task: { disabledAgents: ["fixture"], agentModelOverrides: { fixture: "anthropic/claude-sonnet-4-5" } },
				memory: { backend: "hindsight" },
				hindsight: {
					apiToken: "hindsight-secret",
					bankId: "https://bank.example.test/shared?key=bank-secret",
					scoping: "global",
				},
				compaction: { enabled: false },
			}),
		);
		await Bun.write(
			path.join(projectDir, ".omp", "agents", "fixture.md"),
			[
				"---",
				"name: fixture",
				"description: Fixture agent",
				"model: anthropic/claude-sonnet-4-5",
				"---",
				"Fixture prompt.",
			].join("\n"),
		);
		authStorage.keys.setRuntime("anthropic", "fixture-key");
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const modelRegistry = await registry(settings);
		const currentModel = modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!currentModel) throw new Error("Expected the active-model fixture in the bundled catalog");

		const saved = await buildProfileSnapshot({ cwd: projectDir, settings, modelRegistry });
		expect(saved.roles.find(row => row.role === "default")).toMatchObject({
			modelId: "claude-sonnet-4-5",
			thinkingLevel: "high",
		});

		const current = await buildProfileSnapshot({
			cwd: projectDir,
			settings,
			modelRegistry,
			currentModel,
			currentThinkingLevel: AUTO_THINKING,
		});
		expect(current.roles.find(row => row.role === "default")).toMatchObject({
			selector: "anthropic/claude-sonnet-4-5:high",
			modelId: "claude-opus-4-5",
			thinkingLevel: AUTO_THINKING,
		});
		expect(current.roles.find(row => row.role === "review")?.warning).toBe(
			"Configured model is not available with the current providers.",
		);
		expect(current.agents.find(row => row.name === "fixture")).toMatchObject({
			enabled: false,
			modelId: "claude-sonnet-4-5",
		});
		expect(current.memory).toEqual({
			backend: "hindsight",
			scope: "global",
			storageLabel: "Custom storage — may be shared · Bank bank.example.test",
		});
		expect(current.settings.find(row => row.id === "auth.broker.token")).toMatchObject({
			value: null,
			hidden: true,
			configured: true,
		});
		const serialized = JSON.stringify(current);
		for (const secret of ["broker-secret", "url-secret", "hindsight-secret", "bank-secret"]) {
			expect(serialized).not.toContain(secret);
		}
	});
});
