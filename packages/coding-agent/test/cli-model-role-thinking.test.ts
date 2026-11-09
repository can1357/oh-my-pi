import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression: `--model` used to record the `default` role without its effort,
// so cycling back into that role with ctrl+p ran at the previous role's effort.
describe("--model role override thinking suffix", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cli-role-thinking-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function overriddenDefaultRole(cliArgs: string[]): Promise<string | undefined> {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("expected claude-opus-4-5 to be bundled");
		authStorage.keys.setRuntime(model.provider, "test-key");
		const settings = Settings.isolated();
		settings.setModelRole("default", `${model.provider}/${model.id}:high`);
		// Guards the test run: a resolution failure would exit the process.
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});

		await buildSessionOptions(parseArgs(cliArgs), [], SessionManager.inMemory(), modelRegistry, settings);

		return settings.getModelRole("default");
	}

	test("keeps the requested effort on the default role", async () => {
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5:low"])).toBe(
			"anthropic/claude-opus-4-5:low",
		);
	});

	test("leaves the role effort unselected when the flag carries no suffix", async () => {
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5"])).toBe("anthropic/claude-opus-4-5");
	});

	test("records the explicit --thinking effort over the --model suffix", async () => {
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5:low", "--thinking", "high"])).toBe(
			"anthropic/claude-opus-4-5:high",
		);
	});

	test("records --thinking on the default role when --model carries no suffix", async () => {
		// The only case where the flag supplies the effort and the suffix does not.
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5", "--thinking", "high"])).toBe(
			"anthropic/claude-opus-4-5:high",
		);
	});

	test("prewalk @default resolves the configured default before --model overrides the session role", async () => {
		const startupModel = getBundledModel("anthropic", "claude-opus-4-5");
		const configuredDefault = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!startupModel || !configuredDefault) throw new Error("expected bundled models");

		authStorage.keys.setRuntime("anthropic", "test-key");

		const settings = Settings.isolated({ defaultThinkingLevel: "auto" });
		settings.setModelRole("default", `${configuredDefault.provider}/${configuredDefault.id}`);

		const options = await buildSessionOptions(
			parseArgs(["--model", `${startupModel.provider}/${startupModel.id}`, "--prewalk-into", "@default"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.model?.id).toBe(startupModel.id);
		expect(options.prewalk?.target.id).toBe(configuredDefault.id);
	});

	test("prewalk bare default resolves the configured default before --model overrides the session role", async () => {
		const startupModel = getBundledModel("anthropic", "claude-opus-4-5");
		const configuredDefault = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!startupModel || !configuredDefault) throw new Error("expected bundled models");

		authStorage.keys.setRuntime("anthropic", "test-key");

		const settings = Settings.isolated({ defaultThinkingLevel: "auto" });
		settings.setModelRole("default", `${configuredDefault.provider}/${configuredDefault.id}`);

		const options = await buildSessionOptions(
			parseArgs(["--model", `${startupModel.provider}/${startupModel.id}`, "--prewalk-into", "default"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.model?.id).toBe(startupModel.id);
		expect(options.prewalk?.target.id).toBe(configuredDefault.id);
	});

	// Regression (#18389): `--model pi/<role>` recorded the session under `default`, so a
	// retryable error walked `fallbackChains.default` instead of the role's own chain.
	describe("role alias retry ownership", () => {
		const lead = "anthropic/claude-opus-4-5";
		const leadFallback = "anthropic/claude-sonnet-4-6";

		function roleSettings(): Settings {
			authStorage.keys.setRuntime("anthropic", "test-key");
			return Settings.isolated({
				modelRoles: { lead },
				"retry.fallbackChains": { lead: [leadFallback], default: ["anthropic/claude-haiku-4-5"] },
			});
		}

		async function retryChainOf(options: CreateAgentSessionOptions) {
			const { session } = await createAgentSession({
				...options,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				const recovery = new TurnRecovery({
					model: () => session.model,
					thinkingLevel: () => undefined,
					sessionManager: session.sessionManager,
					settings: session.settings,
					modelRegistry: session.modelRegistry,
					configWarnings: [],
				} as unknown as TurnRecoveryHost);
				const keys = recovery.retryFallbackChainKeys(lead, session.model);
				return keys.flatMap(key => recovery.findRetryFallbackCandidates(key, lead).map(candidate => candidate.raw));
			} finally {
				await session.dispose();
			}
		}

		test("a new session walks the alias role's chain", async () => {
			const settings = roleSettings();
			const options = await buildSessionOptions(
				parseArgs(["--model", "pi/lead"]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(await retryChainOf({ ...options, settings })).toEqual([leadFallback]);
		});

		test("--continue re-owns a branch recorded under default", async () => {
			const settings = roleSettings();
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendModelChange(lead);
			const options = await buildSessionOptions(
				parseArgs(["--continue", "--model", "pi/lead"]),
				[],
				sessionManager,
				modelRegistry,
				settings,
			);
			expect(await retryChainOf({ ...options, settings })).toEqual([leadFallback]);
		});

		test("resuming with an explicit model but no role keeps the recorded role", async () => {
			// Subagent revival passes its model explicitly; it must not demote the run's role to
			// `default`, which shares the model here and would claim the retry.
			const settings = roleSettings();
			settings.setModelRole("default", lead);
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendModelChange(lead);
			sessionManager.appendModelChange(lead, "lead");
			expect(
				await retryChainOf({ model: getBundledModel("anthropic", "claude-opus-4-5"), sessionManager, settings }),
			).toEqual([leadFallback]);
		});
	});
});
