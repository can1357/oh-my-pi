import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Bot review on PR #9379: `initHooksAndCustomTools()` fires the interactive
 * session's startup `resources_discover` pass (via
 * `discoverStartupSkillPaths()`), which folds any extension-contributed skill
 * into `session.skills` and notifies command-metadata listeners — but
 * `InteractiveMode.init()` registers its `subscribeCommandMetadataChanged`
 * listener (the one that rebuilds `skillCommands`/`/skill:<name>` entries)
 * only later in the same method. Pre-fix, a skill contributed at startup
 * landed in the system prompt but stayed invisible to `/skill:<name>` and
 * autocomplete until a later `/reload-plugins`.
 */
describe("InteractiveMode startup skill discovery (PR #9379 review)", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("recognizes a resources_discover-contributed skill immediately after initHooksAndCustomTools, before any subscription exists", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-interactive-startup-skill-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		let mode: InteractiveMode | undefined;
		try {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd: tempDir });

			const skillDir = path.join(tempDir, "contributed-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				"---\nname: contributed-skill\ndescription: Contributed via resources_discover at startup.\n---\n\nbody\n",
			);

			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "startup-skill.ts");
			await fs.writeFile(
				extPath,
				`export default function (pi) {
	pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(tempDir)}] }));
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [] },
				}),
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
			});

			mode = new InteractiveMode(session, "test");
			expect(mode.skillCommands.has("skill:contributed-skill")).toBe(false);

			// `init()` builds the editor's autocomplete provider at
			// `init:slashCommands`, BEFORE the hooks pass runs discovery. The
			// provider snapshots the command list, so the roster the user sees
			// is whatever gets pushed to the editor after discovery — capture
			// every provider handed to the editor and assert on the last one.
			let provider: AutocompleteProvider | undefined;
			vi.spyOn(mode.editor, "setAutocompleteProvider").mockImplementation(next => {
				provider = next;
			});
			await mode.refreshSlashCommandState(tempDir, session.slashCommands);
			const suggestionsBefore = await provider?.getSuggestions(["/skill:contrib"], 0, "/skill:contrib".length);
			expect(suggestionsBefore?.items.map(item => item.value) ?? []).not.toContain("skill:contributed-skill");

			// Exercises exactly the controller call `init()` makes — without
			// running the rest of `init()` (terminal/composer setup), so the
			// `subscribeCommandMetadataChanged` listener registered later in
			// `init()` is provably not yet wired when this returns.
			await mode.initHooksAndCustomTools();

			expect(session.skills.some(skill => skill.name === "contributed-skill")).toBe(true);
			expect(mode.skillCommands.has("skill:contributed-skill")).toBe(true);
			// The user-observable contract: the skill is offered in `/skill:`
			// autocomplete right after startup, not only after `/reload-plugins`.
			const suggestionsAfter = await provider?.getSuggestions(["/skill:contrib"], 0, "/skill:contrib".length);
			expect(suggestionsAfter?.items.map(item => item.value)).toContain("skill:contributed-skill");
		} finally {
			mode?.stop();
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("drains a session_start-triggered turn, with visibility into startup-discovered skills, before initHooksAndCustomTools returns (regression: PR #9379 review)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-interactive-startup-turn-"));
		const authStorage = createInMemoryAuthStorage();
		// `AgentSession.prompt` preflights a provider key through the registry; the
		// session_start-triggered turn below must not depend on the developer's env.
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		let session: AgentSession | undefined;
		let mode: InteractiveMode | undefined;
		try {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd: tempDir });

			const skillDir = path.join(tempDir, "contributed-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				"---\nname: contributed-skill\ndescription: Contributed via resources_discover at startup.\n---\n\nbody\n",
			);

			// A `session_start` handler that triggers a turn (mirrors a real
			// extension announcing itself at startup), alongside a
			// `resources_discover` handler that contributes a skill directory.
			// Pre-fix, the TUI startup path (`initHooksAndCustomTools`) had no
			// tracking of the session_start-triggered send at all, so it could
			// still be in flight — using the pre-discovery skill snapshot — when
			// this call returned.
			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "session-start-turn.ts");
			await fs.writeFile(
				extPath,
				`export default function (pi) {
	pi.on("session_start", () => {
		pi.sendUserMessage("hello");
	});
	pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(tempDir)}] }));
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			// Recorded from inside the handler — the exact state the model call
			// actually saw, not a state read racing the assertion.
			const skillVisibleAtCallTime: boolean[] = [];
			const mock = createMockModel({
				handler: () => {
					skillVisibleAtCallTime.push(session?.skills.some(skill => skill.name === "contributed-skill") ?? false);
					return { content: ["ack"] };
				},
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [] },
					streamFn: mock.stream,
				}),
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
			});

			mode = new InteractiveMode(session, "test");
			await mode.initHooksAndCustomTools();

			// The extension-triggered turn must be fully settled by the time
			// `initHooksAndCustomTools` resolves — not merely started — or the
			// interactive render loop's first prompt can observe the session as
			// still streaming.
			expect(session.isStreaming).toBe(false);
			expect(skillVisibleAtCallTime).toEqual([true]);
		} finally {
			mode?.stop();
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});
});
