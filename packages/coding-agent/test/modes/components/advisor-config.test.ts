import { expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { Database } from "bun:sqlite";
import { discoverAdvisorConfigs, saveWatchdogConfigFile, type WatchdogConfigDoc } from "../../../src/advisor/config";
import { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AdvisorConfigOverlayComponent } from "../../../src/modes/components/advisor-config";
import { initTheme } from "../../../src/modes/theme/theme";
import { AuthStorage, SqliteAuthCredentialStore } from "../../../src/session/auth-storage";

it("enables a reference whose shared definition is disabled", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-advisor-editor-"));
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	try {
		await mkdir(join(root, ".git"));
		const agentDir = join(root, "user");
		await mkdir(agentDir);
		await saveWatchdogConfigFile(join(agentDir, "WATCHDOG.yml"), {
			advisors: [{ id: "check", name: "Check", enabled: false }],
		});
		const doc: WatchdogConfigDoc = { advisors: [{ ref: "global/check", enabled: false }] };
		const settings = Settings.isolated();
		initTheme();
		const editor = new AdvisorConfigOverlayComponent(
			new TUI(new ProcessTerminal()),
			{ modelRegistry: new ModelRegistry(auth), settings, scopedModels: [], availableToolNames: [] },
			"project",
			doc,
			{
				loadDoc: async () => doc,
				save: async (_scope, updated) => saveWatchdogConfigFile(join(root, "WATCHDOG.yml"), updated),
				close: () => {},
				requestRender: () => {},
				notify: message => {
					throw new Error(message);
				},
			},
		);
		editor.handleInput("\r");
		editor.handleInput("\r");
		await saveWatchdogConfigFile(join(root, "WATCHDOG.yml"), doc);
		const result = await discoverAdvisorConfigs(root, agentDir, { agentName: "main" });
		expect(result.advisors.find(advisor => advisor.id === "global/check")?.enabled).toBe(true);
	} finally {
		auth.close();
		await rm(root, { recursive: true, force: true });
	}
});
