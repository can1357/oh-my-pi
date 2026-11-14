import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Hook, hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import { SYMLINKS_USABLE } from "../helpers/symlink-support";

const HOOK_SOURCE = `export default function(pi) {
	pi.on("tool_call", async () => ({ block: true, reason: "blocked by hook" }));
}`;

describe("native hook discovery", () => {
	let root: string;
	let project: string;
	let projectPre: string;
	let sharedHooks: string;
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-hooks-"));
		const home = path.join(root, "home");
		project = path.join(root, "project");
		projectPre = path.join(project, ".omp", "hooks", "pre");
		sharedHooks = path.join(root, "shared-hooks");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		await Promise.all([
			fs.mkdir(projectPre, { recursive: true }),
			fs.mkdir(path.join(home, ".omp", "agent", "hooks", "pre"), { recursive: true }),
			fs.mkdir(sharedHooks, { recursive: true }),
			fs.mkdir(path.join(project, ".git"), { recursive: true }),
		]);
		initializeWithSettings(await Settings.init({ inMemory: true, cwd: project }));
	});

	afterEach(async () => {
		resetSettingsForTest();
		clearFsCache();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	});

	test("discovers a hook written as a plain file", async () => {
		const hookPath = path.join(projectPre, "plain-hook.ts");
		await fs.writeFile(hookPath, HOOK_SOURCE);

		const result = await loadCapability<Hook>(hookCapability.id, { cwd: project, providers: ["native"] });

		expect(result.items.map(hook => hook.path)).toContain(hookPath);
	});

	// Linking a shared hook into the hooks dir is the install method this covers. Without
	// the fix `readdir(withFileTypes)` reports the entry as a link rather than a file and
	// `loadHooks` drops it with no item and no warning, so the link is absent here.
	test.skipIf(!SYMLINKS_USABLE)("discovers a hook linked into the hooks dir", async () => {
		const shared = path.join(sharedHooks, "shared-hook.ts");
		await fs.writeFile(shared, HOOK_SOURCE);
		const linkPath = path.join(projectPre, "linked-hook.ts");
		await fs.symlink(shared, linkPath, "file");

		const result = await loadCapability<Hook>(hookCapability.id, { cwd: project, providers: ["native"] });

		expect(result.items.map(hook => hook.path)).toContain(linkPath);
	});
});
