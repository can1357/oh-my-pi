import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import {
	isShadowedExtension,
	loadAllExtensions,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

describe("disabledExtensions runtime filtering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalUserProfile: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-home-"));
		process.env.HOME = tempHomeDir;
		process.env.USERPROFILE = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-"));
		await fs.mkdir(path.join(tempDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".omp", "AGENTS.md"), "# project instructions\n");

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				disabledExtensions: ["context-file:project:AGENTS.md"],
			},
		});
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("USERPROFILE", originalUserProfile);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempHomeDir);
		await removeWithRetries(tempDir);
	});

	test("hides disabled context files from runtime loads by default", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("can include disabled context files for dashboard-style loads", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			includeDisabled: true,
		});

		expect(result.items).toHaveLength(1);
		expect(path.basename(result.items[0]!.path)).toBe("AGENTS.md");
	});

	test("keeps the runtime context winner active in the dashboard when its competitor is disabled", async () => {
		await fs.rm(path.join(tempDir, ".omp", "AGENTS.md"));
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# active project instructions\n");
		await fs.mkdir(path.join(tempDir, ".gemini"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".gemini", "GEMINI.md"), "# disabled project instructions\n");

		const disabledExtensions = ["context-file:project:GEMINI.md", "context-file:user:GEMINI.md"];
		const settings = Settings.isolated({ disabledExtensions });
		initializeWithSettings(settings);

		const runtime = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		const dashboard = await loadAllExtensions(tempDir, disabledExtensions);
		const agents = dashboard.find(extension => extension.path === path.join(tempDir, "AGENTS.md"));
		const gemini = dashboard.find(extension => extension.path === path.join(tempDir, ".gemini", "GEMINI.md"));

		expect(runtime.items.map(file => path.basename(file.path))).toContain("AGENTS.md");
		expect(agents?.state).toBe("active");
		expect(gemini?.state).toBe("disabled");
	});

	test("deduplicates against the caller's session-local disabled list, not global settings", async () => {
		await fs.rm(path.join(tempDir, ".omp", "AGENTS.md"));
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# active project instructions\n");
		await fs.mkdir(path.join(tempDir, ".gemini"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".gemini", "GEMINI.md"), "# session-disabled project instructions\n");

		// Process-global settings disable nothing; the disablement is session-local.
		initializeWithSettings(Settings.isolated({ disabledExtensions: [] }));

		const disabledIds = ["context-file:project:GEMINI.md", "context-file:user:GEMINI.md"];
		const dashboard = await loadAllExtensions(tempDir, disabledIds);
		const agents = dashboard.find(extension => extension.path === path.join(tempDir, "AGENTS.md"));
		const gemini = dashboard.find(extension => extension.path === path.join(tempDir, ".gemini", "GEMINI.md"));

		expect(agents?.state).toBe("active");
		expect(gemini?.state).toBe("disabled");
	});

	test("marks a disabled lower-priority row shadowed when an enabled higher-priority item owns the key", async () => {
		// Enabled builtin .omp/AGENTS.md (priority 100) already exists at project
		// depth 0 from beforeEach; add a lower-priority .gemini/GEMINI.md at the
		// same depth and disable it.
		await fs.mkdir(path.join(tempDir, ".gemini"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".gemini", "GEMINI.md"), "# disabled lower-priority instructions\n");

		const disabledIds = ["context-file:project:GEMINI.md"];
		initializeWithSettings(Settings.isolated({ disabledExtensions: disabledIds }));

		const dashboard = await loadAllExtensions(tempDir, disabledIds);
		const agents = dashboard.find(extension => extension.path === path.join(tempDir, ".omp", "AGENTS.md"));
		const gemini = dashboard.find(extension => extension.path === path.join(tempDir, ".gemini", "GEMINI.md"));

		expect(agents?.state).toBe("active");
		expect(gemini?.state).toBe("disabled");
		// The disabled loser must stay shadowed so the dashboard does not treat
		// it as an independently toggleable row.
		expect(gemini && isShadowedExtension(gemini)).toBe(true);
	});
});
