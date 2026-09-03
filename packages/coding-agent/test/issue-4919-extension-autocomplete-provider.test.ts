/**
 * Issue #4919: a pi extension calling `ctx.ui.addAutocompleteProvider(...)` in its
 * `session_start` handler crashed at load under omp — the method was absent from
 * `ExtensionUIContext`, so the call threw `TypeError: ... is not a function` and
 * (for extensions that wrap init in try/catch, e.g. @ff-labs/pi-fff) aborted the
 * extension's entire initialization.
 *
 * These tests pin the pi-compatible contract:
 * - headless contexts accept the factory as a no-op instead of throwing, and
 * - interactive mode stacks each factory on top of the built-in editor provider.
 *
 * NOTE: imports are relative (`../src/...`) so the tests exercise this checkout
 * even when `node_modules/@oh-my-pi/pi-coding-agent` resolves elsewhere.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

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

/**
 * Wrap `current` the way a well-behaved pi extension does: contribute items for
 * its own trigger prefix, delegate everything else to the wrapped provider.
 */
function makeWrappingFactory(tag: string): (current: AutocompleteProvider) => AutocompleteProvider {
	return current => ({
		async getSuggestions(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			if (line.startsWith("##")) {
				const base = await current.getSuggestions(lines, cursorLine, cursorCol);
				return {
					items: [...(base?.items ?? []), { value: tag, label: tag }],
					prefix: base?.prefix ?? line.slice(0, cursorCol),
				};
			}
			return current.getSuggestions(lines, cursorLine, cursorCol);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	});
}

describe("extension autocomplete provider API (#4919)", () => {
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
		// directory, keeping `refreshSlashCommandState`'s capability scan off the
		// real home dir (mirrors the prompt-template autocomplete harness).
		tempDir = TempDir.createSync("@pi-ext-autocomplete-");
		originalHome = process.env.HOME;
		process.env.HOME = tempDir.path();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const resolved = registry.find("anthropic", "claude-sonnet-4-5");
		if (!resolved) throw new Error("Expected anthropic model claude-sonnet-4-5 to exist");
		model = resolved;
		tools = [makeTool("read")];
	});

	beforeEach(() => {
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

	function createHarness(): { mode: InteractiveMode; session: AgentSession } {
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
			promptTemplates: [],
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

	it("does not abort a session_start handler that registers a provider without UI", async () => {
		// Mimics @ff-labs/pi-fff: registerAutocompleteProvider(ctx) runs first and
		// unconditionally inside the try/catch that guards the whole init routine.
		const extensionsDir = path.join(tempDir.path(), "runner-extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const markerPath = path.join(extensionsDir, "init-marker.txt");
		const extPath = path.join(extensionsDir, "fff-like.ts");
		fs.writeFileSync(
			extPath,
			`import * as fs from "node:fs";
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			ctx.ui.addAutocompleteProvider((current) => current);
			// "Rest of init" — on baseline the call above throws and this never runs.
			fs.writeFileSync(${JSON.stringify(markerPath)}, "initialized");
		} catch (error) {
			fs.writeFileSync(
				${JSON.stringify(markerPath)},
				"failed: " + (error instanceof Error ? error.message : String(error)),
			);
		}
	});
}
`,
		);

		const result = await loadExtensions([extPath], tempDir.path());
		expect(result.errors).toEqual([]);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			registry,
		);
		const surfaced: string[] = [];
		runner.onError(error => {
			surfaced.push(error.error);
		});

		await runner.emit({ type: "session_start" });

		expect(surfaced).toEqual([]);
		expect(fs.readFileSync(markerPath, "utf8")).toBe("initialized");
	});

	it("stacks extension factories on top of the built-in editor provider", async () => {
		const created = createHarness();
		const slot = captureAutocompleteProvider(created.mode);

		// Registration before the first refresh (session_start fires before init's
		// refreshSlashCommandState) must land once the base provider exists.
		created.mode.addAutocompleteProvider(makeWrappingFactory("##fff-first"));
		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();

		// The extension's trigger prefix surfaces its items...
		const extension = await provider!.getSuggestions(["##"], 0, 2);
		expect(extension?.items.map(item => item.value)).toContain("##fff-first");

		// ...while built-in slash completion still flows through the wrapper.
		const slash = await provider!.getSuggestions(["/"], 0, 1);
		expect(slash?.items.map(item => item.value)).toContain("model");

		// Registration after the refresh re-applies immediately, preserving the chain.
		created.mode.addAutocompleteProvider(makeWrappingFactory("##fff-second"));
		const restacked = slot.current;
		expect(restacked).toBeDefined();
		expect(restacked).not.toBe(provider);

		const chained = await restacked!.getSuggestions(["##"], 0, 2);
		const values = chained?.items.map(item => item.value) ?? [];
		expect(values).toContain("##fff-first");
		expect(values).toContain("##fff-second");
	});

	it("skips broken factories without losing core autocomplete or healthy wrappers", async () => {
		const created = createHarness();
		const slot = captureAutocompleteProvider(created.mode);
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		created.mode.addAutocompleteProvider(() => {
			throw new Error("boom");
		});
		created.mode.addAutocompleteProvider(() => ({}) as AutocompleteProvider);
		created.mode.addAutocompleteProvider(makeWrappingFactory("##healthy"));
		await created.mode.refreshSlashCommandState(tempDir.path());

		const provider = slot.current;
		expect(provider).toBeDefined();

		const slash = await provider!.getSuggestions(["/"], 0, 1);
		expect(slash?.items.map(item => item.value)).toContain("model");

		const extension = await provider!.getSuggestions(["##"], 0, 2);
		expect(extension?.items.map(item => item.value)).toContain("##healthy");

		expect(warnSpy.mock.calls.some(([message]) => String(message).includes("autocomplete provider factory"))).toBe(
			true,
		);
	});
});
