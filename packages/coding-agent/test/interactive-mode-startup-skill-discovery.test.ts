import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

			// Exercises exactly the controller call `init()` makes — without
			// running the rest of `init()` (terminal/composer setup), so the
			// `subscribeCommandMetadataChanged` listener registered later in
			// `init()` is provably not yet wired when this returns.
			await mode.initHooksAndCustomTools();

			expect(session.skills.some(skill => skill.name === "contributed-skill")).toBe(true);
			expect(mode.skillCommands.has("skill:contributed-skill")).toBe(true);
		} finally {
			mode?.stop();
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});
});
