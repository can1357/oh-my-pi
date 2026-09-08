import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { Database } from "bun:sqlite";
import { discoverAdvisorConfigs, saveWatchdogConfigFile, type WatchdogConfigDoc } from "../../../src/advisor/config";
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
