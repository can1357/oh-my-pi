import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetProjectDirCacheForTests,
	directoryIsMissing,
	getProjectDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

const originalProjectDir = fs.realpathSync(process.cwd()).replace(/^\/private(?=\/)/, "");

afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
});
describe("project directory state", () => {
	it("enters an accessible fallback when process.cwd fails", () => {
		__resetProjectDirCacheForTests();
		const originalPwd = process.env.PWD;
		const cwd = spyOn(process, "cwd").mockImplementation(() => {
			throw new Error("cwd unavailable");
		});
		process.env.PWD = os.tmpdir();
		try {
			getProjectDir();
			cwd.mockRestore();
			expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(getProjectDir()));
		} finally {
			cwd.mockRestore();
			if (originalPwd === undefined) delete process.env.PWD;
			else process.env.PWD = originalPwd;
		}
	});

	it("treats denied stat as probeable rather than missing", async () => {
		const stat = spyOn(fs.promises, "stat").mockRejectedValue(
			Object.assign(new Error("operation not permitted"), { code: "EACCES" }),
		);
		try {
			expect(await directoryIsMissing(path.join(os.tmpdir(), "blocked"))).toBe(false);
		} finally {
			stat.mockRestore();
		}
	});

	it("keeps the previous directory when chdir fails", () => {
		const chdir = spyOn(process, "chdir").mockImplementation(() => {
			throw new Error("operation not permitted");
		});

		expect(() => setProjectDir("/blocked/project")).toThrow("operation not permitted");
		expect(getProjectDir()).toBe(originalProjectDir);
		chdir.mockRestore();
	});
});

describe("stats database directory", () => {
	it.each([
		{ name: "default", profile: "", xdg: false, migrateProfile: false, customActive: false },
		{ name: "custom active agent", profile: "", xdg: false, migrateProfile: false, customActive: true },
		{ name: "named profile", profile: "work", xdg: false, migrateProfile: false, customActive: false },
		{ name: "XDG default", profile: "", xdg: true, migrateProfile: false, customActive: false },
		{ name: "XDG custom active agent", profile: "", xdg: true, migrateProfile: false, customActive: true },
		{ name: "XDG named profile", profile: "work", xdg: true, migrateProfile: true, customActive: false },
		{ name: "unmigrated XDG profile", profile: "work", xdg: true, migrateProfile: false, customActive: false },
	])(
		"preserves active and explicit custom paths for $name",
		async ({ profile, xdg, migrateProfile, customActive }) => {
			await using temp = await TempDir.create("@omp-stats-dirs-");
			const home = temp.join("home");
			const dataHome = temp.join("data");
			const xdgRoot = path.join(dataHome, "omp");
			const profileParts = profile ? ["profiles", profile] : [];
			const configRoot = path.join(home, ".omp", ...profileParts);
			const activeAgent = customActive ? temp.join("active-agent") : path.join(configRoot, "agent");
			if (xdg) await fs.promises.mkdir(xdgRoot, { recursive: true });
			if (migrateProfile) await fs.promises.mkdir(path.join(xdgRoot, ...profileParts), { recursive: true });
			await fs.promises.mkdir(activeAgent, { recursive: true });
			const linkedAgent = temp.join("linked-agent");
			await fs.promises.symlink(activeAgent, linkedAgent, "junction");
			const usesXdg =
				xdg &&
				!customActive &&
				(!profile || migrateProfile) &&
				(process.platform === "linux" || process.platform === "darwin");
			const defaultStats = path.join(usesXdg ? path.join(xdgRoot, ...profileParts) : configRoot, "stats.db");
			const source = [
				'import * as path from "node:path";',
				`import { getAgentDir, getStatsDbPath } from ${JSON.stringify(new URL("../src/dirs.ts", import.meta.url).href)};`,
				"const agent = getAgentDir();",
				'const alias = agent + path.sep + "unused" + path.sep + "..";',
				"process.stdout.write(JSON.stringify({",
				"  agent,",
				"  implicit: getStatsDbPath(),",
				"  active: getStatsDbPath(agent),",
				"  alias: getStatsDbPath(alias),",
				"  relativeActive: getStatsDbPath(path.relative(process.cwd(), agent)),",
				`  linked: getStatsDbPath(${JSON.stringify(linkedAgent)}),`,
				'  caseVariant: getStatsDbPath(process.platform === "win32" ? agent.toUpperCase() : agent),',
				`  custom: getStatsDbPath(${JSON.stringify(temp.join("custom-agent"))}),`,
				'  relativeCustom: getStatsDbPath("custom-agent"),',
				"}));",
			].join("\n");
			const child = Bun.spawn([process.execPath, "--eval", source], {
				cwd: temp.path(),
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					PI_CONFIG_DIR: ".omp",
					PI_CODING_AGENT_DIR: customActive ? activeAgent : "",
					OMP_PROFILE: profile,
					PI_PROFILE: profile,
					XDG_DATA_HOME: dataHome,
					XDG_STATE_HOME: temp.join("state"),
					XDG_CACHE_HOME: temp.join("cache"),
					XDG_CONFIG_HOME: temp.join("config"),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({
				agent: activeAgent,
				implicit: defaultStats,
				active: defaultStats,
				alias: defaultStats,
				relativeActive: defaultStats,
				linked: defaultStats,
				caseVariant: defaultStats,
				custom: temp.join("custom-agent", "stats.db"),
				relativeCustom: path.join("custom-agent", "stats.db"),
			});
		},
	);
});
