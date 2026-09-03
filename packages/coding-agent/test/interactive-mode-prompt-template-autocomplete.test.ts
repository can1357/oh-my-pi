/**
 * Issue #2462: prompt templates discovered from `cwd/.omp/prompts/` were never
 * surfaced in the slash-command autocomplete picker. The runtime expansion in
 * `AgentSession.prompt()` worked, but `InteractiveMode.refreshSlashCommandState`
 * never passed `session.promptTemplates` into the autocomplete provider.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

describe("InteractiveMode prompt-template autocomplete (#2462)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let model: Model<Api>;
	let tools: AgentTool[];
	let originalHome: string | undefined;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		// One empty temp dir doubles as the project cwd and the (isolated) home
		// directory. Pointing $HOME here keeps `refreshSlashCommandState`'s capability
		// scan off the real home dir — that scan was the per-test latency and a source
		// of nondeterminism (it picked up whatever slash commands / plugins happened to
		// live in the developer's or CI's home).
		tempDir = TempDir.createSync("@pi-prompt-template-autocomplete-");
		originalHome = process.env.HOME;
		process.env.HOME = tempDir.path();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// ModelRegistry (bundled-model load) and the resolved model are immutable across
		// these tests, so build them once rather than per test.
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		model = modelOrThrow(registry, "claude-sonnet-4-5");
		tools = [makeTool("read")];
	});

	beforeEach(() => {
		// Re-assert the home seam each test (afterEach's restoreAllMocks clears it).
		// os.homedir() is what the capability loader reads to locate user-level slash
		// commands; aiming it at the empty temp home makes discovery fast and
		// deterministic regardless of the real home's contents.
		vi.spyOn(os, "homedir").mockReturnValue(tempDir.path());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		mode = undefined;
		session = undefined;
	});

	afterAll(() => {
		authStorage?.close();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function createHarness(templates: PromptTemplate[]): { mode: InteractiveMode; session: AgentSession } {
		// SessionManager and AgentSession can't be shared: AgentSession.dispose() closes
		// its SessionManager, so each test gets a fresh pair. They're cheap (in-memory)
		// next to the hoisted ModelRegistry/AuthStorage/temp-dir setup.
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		const created = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools,
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			promptTemplates: templates,
		});
		const createdMode = new InteractiveMode(created, "test");
		session = created;
		mode = createdMode;
		return { mode: createdMode, session: created };
	}

	function captureAutocompleteProvider(target: InteractiveMode): { current: AutocompleteProvider | undefined } {
		const slot: { current: AutocompleteProvider | undefined } = { current: undefined };
		vi.spyOn(target.editor, "setAutocompleteProvider").mockImplementation(provider => {
			slot.current = provider;
		});
		return slot;
	}

	async function fetchSlashSuggestions(provider: AutocompleteProvider, query: string): Promise<string[]> {
		const result = await provider.getSuggestions([query], 0, query.length);
		if (!result) return [];
		return result.items.map(item => item.value);
	}

	async function fetchSlashItems(provider: AutocompleteProvider, query: string) {
		const result = await provider.getSuggestions([query], 0, query.length);
		return result?.items ?? [];
	}

	it("includes discovered prompt templates in slash-command autocomplete", async () => {
		const created = createHarness([
			{
				name: "review",
				description: "Review code for bugs (project)",
				content: "Please review the following code:\n",
				source: "(project)",
			},
		]);
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();

		// Empty `/` shows the full menu.
		const all = await fetchSlashSuggestions(provider!, "/");
		expect(all).toContain("review");

		// Fuzzy prefix `/rev` also surfaces the template.
		const prefixMatches = await fetchSlashSuggestions(provider!, "/rev");
		expect(prefixMatches).toContain("review");
	});

	it("shows session-backed builtin status descriptions in slash-command autocomplete", async () => {
		const created = createHarness([]);
		const providerSlot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());
		const offFast = (await fetchSlashItems(providerSlot.current!, "/fast")).find(item => item.value === "fast");
		expect(offFast?.description).toBe("Fast: off");

		created.session.setFastMode(true);
		const onFast = (await fetchSlashItems(providerSlot.current!, "/fast")).find(item => item.value === "fast");
		expect(onFast?.description).toBe("Fast: on");
	});

	it("does not duplicate templates whose names collide with builtin slash commands", async () => {
		const created = createHarness([
			{
				name: "exit",
				description: "Custom exit template (project)",
				content: "ignored",
				source: "(project)",
			},
		]);
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();
		const matches = await fetchSlashSuggestions(provider!, "/exit");
		// Builtin `/exit` stays; the colliding template is filtered out so the picker
		// shows a single entry rather than two `exit` rows.
		expect(matches.filter(name => name === "exit")).toHaveLength(1);
	});

	it("does not duplicate templates whose names collide with builtin slash command aliases", async () => {
		const created = createHarness([
			{
				name: "models",
				description: "Custom models template (project)",
				content: "ignored",
				source: "(project)",
			},
		]);
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();
		const matches = await fetchSlashSuggestions(provider!, "/models");
		// Builtin `/model` owns the `/models` alias. The colliding template is filtered
		// out so autocomplete follows the interactive slash-command resolution path.
		expect(matches.filter(name => name === "models")).toHaveLength(1);
	});
});
