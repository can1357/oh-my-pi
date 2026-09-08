import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { Database } from "bun:sqlite";
import {
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	saveWatchdogConfigFile,
	type WatchdogConfigDoc,
} from "../../../src/advisor/config";
import { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AdvisorConfigOverlayComponent } from "../../../src/modes/components/advisor-config";
import { initTheme } from "../../../src/modes/theme/theme";
import { AuthStorage, SqliteAuthCredentialStore } from "../../../src/session/auth-storage";

it("enables a reference whose shared definition is disabled", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-advisor-editor-"));
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	try {
		await fs.mkdir(path.join(root, ".git"));
		const agentDir = path.join(root, "user");
		await fs.mkdir(agentDir);
		await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), {
			advisors: [{ id: "check", name: "Check", enabled: false }],
		});
		const doc: WatchdogConfigDoc = { advisors: [{ ref: "global/check" }] };
		const settings = Settings.isolated();
		initTheme();
		const editor = new AdvisorConfigOverlayComponent(
			new TUI(new ProcessTerminal()),
			{ modelRegistry: new ModelRegistry(auth), settings, scopedModels: [], availableToolNames: [] },
			"project",
			doc,
			{
				loadDoc: async () => doc,
				save: async (_scope, updated) => saveWatchdogConfigFile(path.join(root, "WATCHDOG.yml"), updated),
				close: () => {},
				requestRender: () => {},
				notify: message => {
					throw new Error(message);
				},
			},
		);
		editor.handleInput("\r");
		editor.handleInput("\r");
		await saveWatchdogConfigFile(path.join(root, "WATCHDOG.yml"), doc);
		const result = await discoverAdvisorConfigs(root, agentDir, { agentName: "main" });
		expect(result.advisors.find(advisor => advisor.id === "global/check")?.enabled).toBe(true);
	} finally {
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("cycles a reference through override states and restores the definition default after reload", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-advisor-editor-"));
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	try {
		initTheme();
		await fs.mkdir(path.join(root, ".git"));
		const agentDir = path.join(root, "user");
		await fs.mkdir(agentDir);
		const projectFile = path.join(root, "WATCHDOG.yml");
		await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), {
			advisors: [{ id: "check", name: "Check", enabled: true }],
		});
		const ref = "global/check";
		const doc: WatchdogConfigDoc = { advisors: [{ ref }] };
		const saved = Promise.withResolvers<void>();
		const makeEditor = (current: WatchdogConfigDoc) =>
			new AdvisorConfigOverlayComponent(
				new TUI(new ProcessTerminal()),
				{
					modelRegistry: new ModelRegistry(auth),
					settings: Settings.isolated(),
					scopedModels: [],
					availableToolNames: [],
				},
				"project",
				current,
				{
					loadDoc: async () => loadWatchdogConfigFile(projectFile),
					save: async (_scope, updated) => {
						await saveWatchdogConfigFile(projectFile, updated);
						saved.resolve();
					},
					close: () => {},
					requestRender: () => {},
					notify: message => {
						throw new Error(message);
					},
				},
			);
		const editor = makeEditor(doc);
		editor.render(160);
		editor.handleInput("\r");
		expect(editor.render(160).join("\n")).toContain("definition default");
		editor.handleInput("\r");
		expect(editor.render(160).join("\n")).toContain("on");
		editor.handleInput("\r");
		expect(editor.render(160).join("\n")).toContain("off");
		editor.handleInput("\r");
		expect(editor.render(160).join("\n")).toContain("definition default");
		editor.handleInput("\x1b");
		for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		await saved.promise;

		const reloaded = await loadWatchdogConfigFile(projectFile);
		expect(reloaded).toEqual({ advisors: [{ ref }] });
		const reloadedEditor = makeEditor(reloaded);
		reloadedEditor.render(160);
		reloadedEditor.handleInput("\r");
		expect(reloadedEditor.render(160).join("\n")).toContain("definition default");

		const ordinaryEditor = makeEditor({ advisors: [{ name: "ordinary", enabled: false }] });
		ordinaryEditor.render(160);
		ordinaryEditor.handleInput("\r");
		expect(ordinaryEditor.render(160).join("\n")).toContain("off");
		ordinaryEditor.handleInput("\r");
		expect(ordinaryEditor.render(160).join("\n")).toContain("on");

		const discovered = await discoverAdvisorConfigs(root, agentDir, { agentName: "main" });
		expect(discovered.advisors.find(advisor => advisor.id === ref)?.enabled).toBe(true);
	} finally {
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("expands reference tabs for display without changing the saved identity", async () => {
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	try {
		initTheme();
		const ref = "qa\tteam/check";
		const doc: WatchdogConfigDoc = { advisors: [{ ref }] };
		const saved = Promise.withResolvers<WatchdogConfigDoc>();
		const editor = new AdvisorConfigOverlayComponent(
			new TUI(new ProcessTerminal()),
			{
				modelRegistry: new ModelRegistry(auth),
				settings: Settings.isolated(),
				scopedModels: [],
				availableToolNames: [],
			},
			"project",
			doc,
			{
				loadDoc: async () => doc,
				save: async (_scope, updated) => saved.resolve(updated),
				close: () => {},
				requestRender: () => {},
				notify: message => {
					throw new Error(message);
				},
			},
		);
		const list = editor.render(160).join("\n");
		expect(list).not.toContain("\t");
		expect(list).toMatch(/qa +team\/check/);
		editor.handleInput("\r");
		const detail = editor.render(160).join("\n");
		expect(detail).not.toContain("\t");
		expect(detail).toMatch(/qa +team\/check/);
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		const result = await saved.promise;
		expect(result.advisors).toEqual([{ ref, enabled: true }]);
	} finally {
		auth.close();
	}
});
