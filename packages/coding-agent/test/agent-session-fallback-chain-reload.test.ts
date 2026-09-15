import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

type ConfigWarningsChangedEvent = Extract<AgentSessionEvent, { type: "config_warnings_changed" }>;

interface ReloadResult {
	output: Mock<(message?: string) => void>;
	warningEvents: ConfigWarningsChangedEvent[];
}

/**
 * Drives the real /reload-settings entry point against a real AgentSession and
 * asserts the observable `configWarnings` set: a reload that installs a catalog
 * making a chain selector resolvable must retract the stale warning, and one
 * that drops the selector's model must surface a new warning — with
 * `config_warnings_changed` emitted so observers (the TUI header) rebuild.
 */
describe("fallback-chain configWarnings reconcile on /reload-settings", () => {
	const CHAIN_SELECTOR = "liveprov/catalog-model";
	const UNKNOWN_MODEL_WARNING = `Fallback chain for role 'default' references unknown model: ${CHAIN_SELECTOR}`;

	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let registryAuthStorage: AuthStorage;
	let session: AgentSession | undefined;

	/**
	 * Writes both on-disk fixtures; `withCatalogModel` is the independent
	 * variable deciding whether the chain's selector resolves in the registry.
	 */
	const seedFixture = async (withCatalogModel: boolean) => {
		const modelsYml = path.join(agentDir, "models.yml");
		await Bun.write(
			modelsYml,
			YAML.stringify({
				providers: {
					liveprov: {
						baseUrl: "https://liveprov.example.invalid/v1",
						api: "openai-completions",
						apiKey: "sk-liveprov",
						models: [
							// Always present so the static layer is non-empty; the
							// chain selector tracks only catalog-model.
							{ id: "static-model", name: "Static Model" },
							...(withCatalogModel ? [{ id: "catalog-model", name: "Catalog Model" }] : []),
						],
					},
				},
			}),
		);
		// Static reloads are mtime-gated; stamp a distinct mtime instead of
		// sleeping, so the rewrite deterministically passes the gate.
		const bumped = new Date(Date.now() + 60_000);
		fs.utimesSync(modelsYml, bumped, bumped);
		// config.yml is identical in both states on purpose: every warning
		// transition below is driven by the catalog refresh alone.
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ retry: { fallbackChains: { default: [CHAIN_SELECTOR] } } }),
		);
	};

	/** Builds a real session over disk-backed settings and the live registry. */
	const createSession = async (): Promise<AgentSession> => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled test model to exist");
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const modelRegistry = new ModelRegistry(registryAuthStorage, path.join(agentDir, "models.yml"));
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
	};

	/** Runs the real reload-settings handler with the real session wired in. */
	const runReload = async (liveSession: AgentSession): Promise<ReloadResult> => {
		const command = lookupBuiltinSlashCommand("reload-settings");
		if (!command) throw new Error("Expected reload-settings builtin command to exist");
		const warningEvents: ConfigWarningsChangedEvent[] = [];
		liveSession.subscribe(event => {
			if (event.type === "config_warnings_changed") warningEvents.push(event);
		});
		const output: Mock<(message?: string) => void> = vi.fn();
		const runtime = {
			session: liveSession,
			sessionManager: liveSession.sessionManager,
			settings: liveSession.settings,
			cwd: projectDir,
			output,
			refreshCommands: async () => {},
			reloadPlugins: async () => {},
			notifyConfigChanged: async () => {},
		} as unknown as SlashCommandRuntime;
		await command.handle?.({ name: "reload-settings", args: "", text: "/reload-settings" }, runtime);
		return { output, warningEvents };
	};

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-fallback-reload-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		registryAuthStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		registryAuthStorage.close();
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("clears a repaired chain warning once the reload installs a catalog that resolves the selector", async () => {
		// Startup: the chain selector has no backing model anywhere.
		await seedFixture(false);
		session = await createSession();
		expect(session.configWarnings).toContain(UNKNOWN_MODEL_WARNING);

		// The catalog refresh alone repairs the selector: config.yml is untouched,
		// so the command reports no effective settings change while the stale
		// warning must still be retracted.
		await seedFixture(true);
		const { warningEvents } = await runReload(session);

		expect(session.configWarnings).not.toContain(UNKNOWN_MODEL_WARNING);
		expect(warningEvents.length).toBe(1);
	});

	it("surfaces a newly invalid selector once a reload drops its model from the catalog", async () => {
		await seedFixture(true);
		session = await createSession();
		expect(session.configWarnings).not.toContain(UNKNOWN_MODEL_WARNING);

		await seedFixture(false);
		const { warningEvents } = await runReload(session);

		expect(session.configWarnings).toContain(UNKNOWN_MODEL_WARNING);
		expect(warningEvents.length).toBe(1);
	});
});
