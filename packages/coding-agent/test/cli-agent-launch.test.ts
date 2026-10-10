import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Regression: `omp --agent <name>` must feed the agent's FULL ordered model
 * list through the same deferred `modelPattern` path a task sub-agent uses,
 * with a runtime retry chain under the `agent:<name>` role.
 *
 * The fixture agent carries three ordered selectors with explicit effort
 * suffixes:
 *   1. `ghost-provider/parity-unavailable:max` — not in the catalog (unavailable)
 *   2. `anthropic/claude-opus-4-5:high`        — bundled + authenticated; must be selected
 *   3. `anthropic/claude-sonnet-4-6:low`       — must become the runtime fallback
 *
 * The agent's own `thinking-level: low` default differs from the second
 * selector's explicit `:high` suffix, which must win as the configured effort.
 */
const AGENT_NAME = "parity-agent";
const AGENT_ROLE = `agent:${AGENT_NAME}`;
const SELECTORS = [
	"ghost-provider/parity-unavailable:max",
	"anthropic/claude-opus-4-5:high",
	"anthropic/claude-sonnet-4-6:low",
];
const AGENT_THINKING_DEFAULT = Effort.Low;
const AGENT_OUTPUT_SCHEMA = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
};

describe("cli --agent launch parity with task subagent model handling", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let isolatedSettings: Settings;
	let exitSpy: { mockRestore: () => void } | undefined;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cli-agent-parity-"));
		fs.mkdirSync(path.join(tempDir, ".omp", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".omp", "agents", `${AGENT_NAME}.md`),
			[
				"---",
				"name: parity-agent",
				"description: Deferred model pattern parity fixture",
				"model:",
				...SELECTORS.map(selector => `  - ${selector}`),
				"thinking-level: low",
				"tools:",
				"  - read",
				"output:",
				"  type: object",
				"  properties:",
				"    answer:",
				"      type: string",
				"  required:",
				"    - answer",
				"---",
				"",
				"Parity fixture agent body.",
				"",
			].join("\n"),
		);
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		isolatedSettings = Settings.isolated({ "retry.modelFallback": true });
		// Guards the test run: a resolution failure would exit the process.
		exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
	});

	afterAll(async () => {
		exitSpy?.mockRestore();
		await authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("buildSessionOptions defers the full ordered agent model list with fallback role and agent thinking default", async () => {
		const parsed = parseArgs(["--agent", AGENT_NAME]);
		(parsed as { cwd?: string }).cwd = tempDir;

		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, isolatedSettings);

		expect(Array.isArray(options.modelPattern)).toBe(true);
		const selectors = options.modelPattern as string[];
		expect(selectors).toHaveLength(3);
		expect(selectors[0]).toContain("ghost-provider/parity-unavailable");
		expect(selectors[1]).toContain("claude-opus-4-5");
		expect(selectors[1]).toContain(":high");
		expect(selectors[2]).toContain("claude-sonnet-4-6");
		expect(options.modelPatternFallbackRole).toBe(AGENT_ROLE);
		expect(options.model).toBeUndefined();
		// The agent thinking default must ride the pattern-specific field, not
		// seize `thinkingLevel` (the reported effort symptom).
		expect(options.thinkingLevel).toBeUndefined();
		expect(options.modelPatternDefaultThinkingLevel).toBe(AGENT_THINKING_DEFAULT);
	});

	test(
		"createAgentSession selects the first available selector with its explicit effort and installs the remaining selector as runtime fallback",
		async () => {
			const parsed = parseArgs(["--agent", AGENT_NAME]);
			(parsed as { cwd?: string }).cwd = tempDir;
			const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, isolatedSettings);

			const result = await createAgentSession({
				...options,
				disableExtensionDiscovery: true,
				authStorage,
				modelRegistry,
				settings: isolatedSettings,
			});
			const session = result.session;
			try {
				// First available model in the ordered list wins.
				const model = session.model;
				if (!model) throw new Error("session.model was not set");
				expect(model.provider).toBe("anthropic");
				expect(model.id).toBe("claude-opus-4-5");
				// The selected selector's explicit suffix is the configured effort,
				// beating the agent's `low` thinking default.
				const effortState = session as unknown as { thinkingLevel?: unknown; effort?: unknown };
				expect(String(effortState.thinkingLevel ?? effortState.effort)).toBe("high");
				// The runtime role carries the selected selector with its effort.
				const roleValue = isolatedSettings.getModelRole(AGENT_ROLE);
				expect(String(roleValue)).toContain("claude-opus-4-5");
				expect(String(roleValue)).toContain(":high");
				// The remaining selector is installed in the agent launch retry chain.
				const chains = isolatedSettings.get("retry.fallbackChains") as Record<string, string[]> | undefined;
				const chain = chains?.[AGENT_ROLE] ?? [];
				expect(chain.some(entry => String(entry).includes("claude-sonnet-4-6"))).toBe(true);
			} finally {
				await session.dispose().catch(() => {});
			}
		},
		120_000,
	);

	test("buildSessionOptions does not let a settings-derived scopedModels scope hide the agent model", async () => {
		const parsed = parseArgs(["--agent", AGENT_NAME]);
		Object.assign(parsed, { cwd: tempDir });
		const available = modelRegistry.getAvailable();
		const opus = available.find(model => model.provider === "anthropic" && model.id === "claude-opus-4-5");
		const sonnet = available.find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-6");
		if (!opus || !sonnet) throw new Error("fixture catalog is missing the anthropic models");
		// Simulates a settings `enabledModels` scope: no CLI --models, no remembered default.
		const scopedModels = [
			{ model: opus, explicitThinkingLevel: false },
			{ model: sonnet, explicitThinkingLevel: false },
		];
		const options = await buildSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			isolatedSettings,
		);
		// The agent model wins: full ordered deferred pattern, not scopedModels[0].
		const selectors = options.modelPattern as string[];
		expect(Array.isArray(selectors)).toBe(true);
		expect(selectors).toHaveLength(3);
		expect(selectors[1]).toContain("claude-opus-4-5");
		expect(options.modelPatternFallbackRole).toBe(AGENT_ROLE);
		expect(options.model).toBeUndefined();
		// The settings scope stays available for Ctrl+P cycling.
		expect(options.scopedModels?.map(entry => entry.model.id)).toEqual(["claude-opus-4-5", "claude-sonnet-4-6"]);
	});

	test("buildSessionOptions keeps an explicit CLI --models scope above the agent model", async () => {
		const parsed = parseArgs(["--agent", AGENT_NAME, "--models", "anthropic/claude-sonnet-4-6"]);
		Object.assign(parsed, { cwd: tempDir });
		const sonnet = modelRegistry
			.getAvailable()
			.find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-6");
		if (!sonnet) throw new Error("fixture catalog is missing the anthropic models");
		const scopedModels = [{ model: sonnet, explicitThinkingLevel: false }];
		const options = await buildSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			isolatedSettings,
		);
		expect(options.model?.provider).toBe("anthropic");
		expect(options.model?.id).toBe("claude-sonnet-4-6");
		expect(options.modelPattern).toBeUndefined();
		expect(options.modelPatternFallbackRole).toBeUndefined();
	});

	test("buildSessionOptions keeps explicit CLI --thinking and --tools above the agent defaults", async () => {
		const parsed = parseArgs(["--agent", AGENT_NAME, "--thinking", "high", "--tools", "bash,read"]);
		Object.assign(parsed, { cwd: tempDir });
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, isolatedSettings);
		expect(options.thinkingLevel).toBe(Effort.High);
		expect(options.toolNames).toEqual(["bash", "read"]);
		// The agent model list itself still applies.
		expect(options.modelPatternFallbackRole).toBe(AGENT_ROLE);
	});

	test("buildSessionOptions sets requireYieldTool and the output schema for an agent with declared output", async () => {
		const parsed = parseArgs(["--agent", AGENT_NAME]);
		Object.assign(parsed, { cwd: tempDir });
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, isolatedSettings);
		expect(options.outputSchema).toEqual(AGENT_OUTPUT_SCHEMA);
		// parseAgentFields already appends `yield` to the agent's explicit tools.
		expect(options.toolNames).toEqual(["read", "yield"]);
		expect(options.requireYieldTool).toBe(true);
	});

	test(
		"createAgentSession activates yield alongside the agent's explicit tool list",
		async () => {
			const parsed = parseArgs(["--agent", AGENT_NAME]);
			Object.assign(parsed, { cwd: tempDir });
			const options = await buildSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				isolatedSettings,
			);
			const result = await createAgentSession({
				...options,
				disableExtensionDiscovery: true,
				authStorage,
				modelRegistry,
				settings: isolatedSettings,
			});
			const session = result.session;
			try {
				const activeToolNames = session.getActiveToolNames();
				expect(activeToolNames).toContain("read");
				expect(activeToolNames).toContain("yield");
			} finally {
				await session.dispose().catch(() => {});
			}
		},
		120_000,
	);

	test("buildSessionOptions rejects an unknown agent before creating a session", async () => {
		const parsed = parseArgs(["--agent", "no-such-agent"]);
		Object.assign(parsed, { cwd: tempDir });
		await expect(
			buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, isolatedSettings),
		).rejects.toThrow(/Unknown agent/);
	});
});
