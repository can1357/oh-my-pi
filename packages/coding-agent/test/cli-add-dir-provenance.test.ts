import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

test("--add-dir roots survive a reload that withdraws the same paths from settings", async () => {
	using tempDir = TempDir.createSync("@omp-add-dir-provenance-");
	const authStorage = await AuthStorage.create(":memory:");
	const cliDir = tempDir.join("cli-root");
	const settingsDir = tempDir.join("settings-root");
	await fs.promises.mkdir(cliDir, { recursive: true });
	await fs.promises.mkdir(settingsDir, { recursive: true });

	// Startup: the CLI passes --add-dir cli-root while settings supplies
	// settings-root; buildSessionOptions merges both into additionalDirectories.
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated({ "workspace.additionalDirectories": [settingsDir] });
	const options = await buildSessionOptions(
		parseArgs(["--add-dir", cliDir]),
		[],
		sessionManager,
		new ModelRegistry(authStorage),
		settings,
	);
	expect(options.additionalDirectories).toEqual([path.resolve(cliDir), path.resolve(settingsDir)]);
	expect(options.sessionSuppliedDirectories).toEqual([cliDir]);

	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			...options,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			modelRegistry: new ModelRegistry(authStorage),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		}));
		expect(sessionManager.isSessionSuppliedDirectory(cliDir)).toBe(true);
		expect(sessionManager.isSessionSuppliedDirectory(settingsDir)).toBe(false);

		// A reload withdraws BOTH roots from workspace.additionalDirectories.
		// The /reload-settings delta removes exactly the roots the
		// session-supplied guard does not protect.
		for (const root of [cliDir, settingsDir]) {
			if (sessionManager.isSessionSuppliedDirectory(root)) continue;
			await sessionManager.removeWorkspaceDirectory(root);
		}
		expect(sessionManager.getAdditionalDirectories()).toEqual([path.resolve(cliDir)]);
	} finally {
		await session?.dispose();
		await authStorage.close();
	}
});
