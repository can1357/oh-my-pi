import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getConfigRootDir,
	getPluginsDir,
	getProfileRootDir,
	getSessionsDir,
} from "@oh-my-pi/pi-utils/dirs";
import { expandTilde } from "@oh-my-pi/pi-utils/path";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
const HOME_KEY = process.platform === "win32" ? "USERPROFILE" : "HOME";

// Bun's os.homedir() keeps the home the process started with; a HOME set later
// (a test's temp home, a worker host) never reaches it.
describe("home set after start-up", () => {
	let tempHome = "";
	let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		savedEnv = {};
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-home-env-"));
		for (const key of ENV_KEYS) delete process.env[key];
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		await fs.rm(tempHome, { recursive: true, force: true });
	});

	it("resolves omp's config, agent, sessions, profile and plugin dirs under the runtime home", () => {
		process.env[HOME_KEY] = tempHome;
		__resetDirsFromEnvForTests();

		const root = path.join(tempHome, ".omp");
		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		expect(getSessionsDir()).toBe(path.join(root, "agent", "sessions"));
		expect(getProfileRootDir("work")).toBe(path.join(root, "profiles", "work"));
		expect(getPluginsDir()).toBe(path.join(root, "plugins"));
		expect(expandTilde("~/notes")).toBe(path.join(tempHome, "notes"));
	});

	it("keeps the start-up home when HOME is empty instead of resolving relative to cwd", () => {
		const startupHome = os.homedir();
		process.env[HOME_KEY] = "";
		__resetDirsFromEnvForTests();

		expect(getConfigRootDir()).toBe(path.join(startupHome, ".omp"));
		expect(expandTilde("~/notes")).toBe(path.join(startupHome, "notes"));
	});
});
