// oxlint-disable no-template-curly-in-string -- literal `${…}` sandbox path tokens under test
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ompRuntimePaths, readRoots } from "@oh-my-pi/pi-coding-agent/sandbox/platform";
import {
	expandSandboxPath,
	hostMatches,
	readSandboxConfig,
	resolveFsPolicy,
	type SandboxPolicyContext,
} from "@oh-my-pi/pi-coding-agent/sandbox/policy";
import { cfgSandboxDenyRead } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { SandboxConfig } from "@oh-my-pi/pi-coding-agent/sandbox/types";
import { getAgentDbPath, getAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const POSIX_CTX: SandboxPolicyContext = {
	workspace: "/work/repo",
	home: "/home/u",
	tmpdir: "/scratch/tmp",
	platform: "linux",
	rootEntries: ["/bin", "/usr", "/etc", "/home", "/opt", "/work", "/scratch", "/dev", "/proc", "/sys", "/run", "/tmp"],
	discovered: { readonlyPaths: ["/usr/bin", "/opt/tools/bin"], readwritePaths: [] },
	runtimePaths: ["/opt/omp/bin"],
	authDb: "/home/u/.omp/agent/agent.db",
	agentDir: "/home/u/.omp/agent",
};

const WIN_CTX: SandboxPolicyContext = {
	workspace: "C:\\work\\repo",
	home: "C:\\Users\\u",
	tmpdir: "C:\\Users\\u\\AppData\\Local\\Temp",
	platform: "win32",
	rootEntries: [],
	discovered: { readonlyPaths: ["C:\\Program Files\\Git\\bin", "C:\\Windows\\System32"], readwritePaths: [] },
	runtimePaths: ["C:\\omp"],
};

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
	return {
		enabled: true,
		mode: "workspace-write",
		scope: ["bash"],
		fallback: "warn",
		readScope: "workspace",
		allowWrite: [],
		allowRead: [],
		denyRead: [],
		networkMode: "deny",
		allowedHosts: [],
		listDrives: false,
		loopback: false,
		ignored: [],
		...overrides,
	};
}

describe("expandSandboxPath", () => {
	it.each([
		["~", "/home/u"],
		["~/.ssh", "/home/u/.ssh"],
		["${home}/.aws", "/home/u/.aws"],
		["${workspace}/out", "/work/repo/out"],
		["${tmp}/cache", "/scratch/tmp/cache"],
		["${authDb}-wal", "/home/u/.omp/agent/agent.db-wal"],
		["${agentDir}/.env", "/home/u/.omp/agent/.env"],
		["~bob/notes", "/home/u/bob/notes"],
		["build/dist", "/work/repo/build/dist"],
		["../sibling", "/work/sibling"],
		["/abs/path/", "/abs/path"],
	])("expands %s", (entry, expected) => {
		expect(expandSandboxPath(entry, POSIX_CTX)).toBe(expected);
	});

	it("expands with Windows path rules", () => {
		expect(expandSandboxPath("~/.ssh", WIN_CTX)).toBe("C:\\Users\\u\\.ssh");
		expect(expandSandboxPath("~\\.aws", WIN_CTX)).toBe("C:\\Users\\u\\.aws");
		expect(expandSandboxPath("out", WIN_CTX)).toBe("C:\\work\\repo\\out");
	});

	it("resolves the omp tokens to this process's agent database and agent directory by default", () => {
		const { authDb: _authDb, agentDir: _agentDir, ...ctx } = POSIX_CTX;
		const hostCtx = { ...ctx, platform: process.platform };
		expect(expandSandboxPath("${authDb}", hostCtx)).toBe(getAgentDbPath());
		expect(expandSandboxPath("${agentDir}", hostCtx)).toBe(getAgentDir());
	});
});

describe("sandbox path-list validation", () => {
	it("rejects an unknown ${name} token and accepts the known ones", () => {
		expect(() => cfgSandboxDenyRead.assertWritable(["${HOME}/.vault"])).toThrow("${HOME}");
		expect(() =>
			cfgSandboxDenyRead.assertWritable(["${home}/a", "${workspace}/b", "${tmp}/c", "${authDb}", "${agentDir}/d"]),
		).not.toThrow();
	});
});

describe("resolveFsPolicy", () => {
	it("workspace-write writes the workspace, tmpdir and the extra write paths", () => {
		const policy = resolveFsPolicy(config({ allowWrite: ["~/.cache/tool"] }), {
			...POSIX_CTX,
			extraWrite: ["/srv/git-common"],
		});
		expect(policy.readwritePaths.toSorted()).toEqual(
			["/work/repo", "/scratch/tmp", "/home/u/.cache/tool", "/srv/git-common"].toSorted(),
		);
		expect(policy.readonlyPaths).not.toContain("/work/repo");
	});

	it("read-only writes only tmpdir and keeps the workspace readable", () => {
		const policy = resolveFsPolicy(config({ mode: "read-only", allowWrite: ["~/.cache/tool"] }), {
			...POSIX_CTX,
			extraWrite: ["/srv/git-common"],
		});
		expect(policy.readwritePaths).toEqual(["/scratch/tmp"]);
		expect(policy.readonlyPaths).toContain("/work/repo");
	});

	it("keeps the workspace readable in read-only mode with the broad read scope", () => {
		const win = resolveFsPolicy(config({ mode: "read-only", readScope: "all" }), WIN_CTX);
		expect(win.readonlyPaths).toContain(WIN_CTX.workspace);
		const underRun = resolveFsPolicy(config({ mode: "read-only", readScope: "all" }), {
			...POSIX_CTX,
			workspace: "/run/media/u/repo",
		});
		expect(underRun.readonlyPaths).toContain("/run/media/u/repo");
	});

	it("reads the workspace, tools, runtime and extra read paths in workspace read scope", () => {
		const policy = resolveFsPolicy(config({ mode: "read-only", allowRead: ["~/notes"] }), {
			...POSIX_CTX,
			extraRead: ["/srv/kernel"],
		});
		expect(policy.readonlyPaths.toSorted()).toEqual(
			["/work/repo", "/usr/bin", "/opt/tools/bin", "/opt/omp/bin", "/home/u/notes", "/srv/kernel"].toSorted(),
		);
	});

	it("denies the expanded denyRead entries", () => {
		const policy = resolveFsPolicy(config({ denyRead: ["~/.ssh", "${authDb}"] }), POSIX_CTX);
		expect(policy.deniedPaths).toEqual(["/home/u/.ssh", "/home/u/.omp/agent/agent.db"]);
	});

	it("drops duplicates and entries nested under a wider entry of the same list", () => {
		const policy = resolveFsPolicy(
			config({
				allowWrite: ["${workspace}/sub", "/data", "/data/", "/data/inner"],
				denyRead: ["~/.ssh/id_rsa", "~/.ssh"],
			}),
			{ ...POSIX_CTX, extraRead: ["/work/repo/sub/readme", "/srv/a", "/srv/a/b"] },
		);
		expect(policy.readwritePaths.toSorted()).toEqual(["/data", "/scratch/tmp", "/work/repo"].toSorted());
		expect(policy.readonlyPaths).toContain("/srv/a");
		expect(policy.readonlyPaths).not.toContain("/srv/a/b");
		expect(policy.readonlyPaths).not.toContain("/work/repo/sub/readme");
		expect(policy.deniedPaths).toEqual(["/home/u/.ssh"]);
	});

	it("never emits the filesystem root and honours the broad read scope", () => {
		const loose = config({ readScope: "all", allowWrite: ["/"], allowRead: ["/", "${home}/.."], denyRead: ["/"] });
		const posix = resolveFsPolicy(loose, { ...POSIX_CTX, rootEntries: [...POSIX_CTX.rootEntries, "/", "."] });
		expect(posix.readwritePaths.toSorted()).toEqual(["/scratch/tmp", "/work/repo"]);
		expect(posix.readonlyPaths.toSorted()).toEqual(["/bin", "/etc", "/home", "/opt", "/scratch", "/usr", "/work"]);
		expect(posix.deniedPaths).toEqual([]);

		const win = resolveFsPolicy(config({ ...loose, allowWrite: ["C:\\", "D:/"] }), WIN_CTX);
		expect(win.readwritePaths.toSorted()).toEqual([WIN_CTX.tmpdir, WIN_CTX.workspace].toSorted());
		expect(win.readonlyPaths.toSorted()).toEqual(
			["C:\\Program Files\\Git\\bin", "C:\\Windows\\System32", "C:\\Users", "C:\\omp"].toSorted(),
		);
		expect(win.deniedPaths).toEqual([]);
	});
});

describe("readRoots", () => {
	it("lists the root's children without device and virtual trees on Linux", () => {
		const roots = readRoots("linux", "all", POSIX_CTX);
		expect(roots.toSorted()).toEqual(["/bin", "/etc", "/home", "/opt", "/scratch", "/usr", "/work"]);
	});

	it("drops /dev and hidden special entries on macOS and accepts bare child names", () => {
		const roots = readRoots("darwin", "all", {
			...POSIX_CTX,
			rootEntries: ["Users", "/dev", "/private", "/run", "/.vol", ".resolve", "/.nofollow"],
		});
		expect(roots.toSorted()).toEqual(["/Users", "/private", "/run"]);
	});

	it("uses the discovered tool paths and the user profile on Windows", () => {
		expect(readRoots("win32", "all", WIN_CTX).toSorted()).toEqual(
			[...WIN_CTX.discovered.readonlyPaths, WIN_CTX.home].toSorted(),
		);
	});
});

describe("ompRuntimePaths", () => {
	it("reads the executable's directory, the addon, the package root and the shell snapshot", () => {
		const paths = ompRuntimePaths("linux", {
			execPath: "/opt/omp/bin/omp",
			nativeAddonPath: "/opt/natives/pi_natives.node",
			packageRoot: "/src/oh-my-pi",
			shellSnapshot: "/scratch/snap.sh",
		});
		expect(paths.toSorted()).toEqual(
			["/opt/omp/bin", "/opt/natives/pi_natives.node", "/src/oh-my-pi", "/scratch/snap.sh"].toSorted(),
		);
	});

	it("folds inputs nested under another runtime path and uses Windows rules", () => {
		const paths = ompRuntimePaths("win32", {
			execPath: "C:\\omp\\omp.exe",
			nativeAddonPath: "C:\\OMP\\natives\\pi_natives.node",
		});
		expect(paths).toEqual(["C:\\omp"]);
	});
});

describe("hostMatches", () => {
	const patterns = ["github.com", "*.githubusercontent.com", "Registry.NPMJS.org."];
	it.each([
		["github.com", true],
		["GitHub.COM", true],
		["github.com.", true],
		["api.github.com", false],
		["raw.githubusercontent.com", true],
		["a.b.githubusercontent.com", true],
		["githubusercontent.com", false],
		["evilgithubusercontent.com", false],
		["registry.npmjs.org", true],
		["npmjs.org", false],
		["", false],
	])("%s → %p", (host, expected) => {
		expect(hostMatches(host, patterns)).toBe(expected);
	});
});

describe("readSandboxConfig: project may only tighten", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		state = beginSettingsTest();
		delete process.env.PI_SANDBOX;
		delete Bun.env.PI_SANDBOX;
		delete process.env.PI_CONFIG_FILES;
		delete Bun.env.PI_CONFIG_FILES;
		tempDir = TempDir.createSync("@pi-sandbox-policy-");
		agentDir = tempDir.join("agent");
		cwd = tempDir.join("project");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		tempDir.removeSync();
	});

	async function load(global: RawSettings, project: RawSettings): Promise<SandboxConfig> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(global));
		await Bun.write(path.join(cwd, ".omp", "config.yml"), YAML.stringify(project));
		return readSandboxConfig(await Settings.loadReadOnly({ agentDir, cwd }));
	}

	const ignoredIds = (result: SandboxConfig): string[] => result.ignored.map(entry => entry.id);

	it.each<[string, RawSettings, RawSettings, Partial<SandboxConfig>]>([
		["enabled", { sandbox: { enabled: false } }, { sandbox: { enabled: true } }, { enabled: true }],
		["mode", { sandbox: { mode: "workspace-write" } }, { sandbox: { mode: "read-only" } }, { mode: "read-only" }],
		["fallback", { sandbox: { fallback: "warn" } }, { sandbox: { fallback: "block" } }, { fallback: "block" }],
		[
			"readScope",
			{ sandbox: { filesystem: { readScope: "all" } } },
			{ sandbox: { filesystem: { readScope: "workspace" } } },
			{ readScope: "workspace" },
		],
		[
			"network allow → allowlist",
			{ sandbox: { network: { mode: "allow" } } },
			{ sandbox: { network: { mode: "allowlist" } } },
			{ networkMode: "allowlist" },
		],
		[
			"network allowlist → deny",
			{ sandbox: { network: { mode: "allowlist" } } },
			{ sandbox: { network: { mode: "deny" } } },
			{ networkMode: "deny" },
		],
		[
			"extra scope",
			{ sandbox: { scope: ["bash"] } },
			{ sandbox: { scope: ["exec", "bash"] } },
			{ scope: ["bash", "exec"] },
		],
		[
			"extra denyRead",
			{ sandbox: { filesystem: { denyRead: ["~/.ssh"] } } },
			{ sandbox: { filesystem: { denyRead: ["~/.ssh", "~/vault"] } } },
			{ denyRead: ["~/.ssh", "~/vault"] },
		],
		[
			"fewer allowWrite",
			{ sandbox: { filesystem: { allowWrite: ["~/a", "~/b"] } } },
			{ sandbox: { filesystem: { allowWrite: ["~/a"] } } },
			{ allowWrite: ["~/a"] },
		],
		[
			"fewer allowRead",
			{ sandbox: { filesystem: { allowRead: ["~/a", "~/b"] } } },
			{ sandbox: { filesystem: { allowRead: ["~/b"] } } },
			{ allowRead: ["~/b"] },
		],
		[
			"fewer allowedHosts",
			{ sandbox: { network: { allowedHosts: ["a.test", "b.test"] } } },
			{ sandbox: { network: { allowedHosts: ["b.test"] } } },
			{ allowedHosts: ["b.test"] },
		],
	])("applies a project tightening: %s", async (_name, global, project, expected) => {
		const result = await load(global, project);
		expect(result).toMatchObject(expected);
		expect(result.ignored).toEqual([]);
	});

	it.each<[string, RawSettings, RawSettings, Partial<SandboxConfig>, string]>([
		[
			"enabled",
			{ sandbox: { enabled: true } },
			{ sandbox: { enabled: false } },
			{ enabled: true },
			"sandbox.enabled",
		],
		[
			"mode",
			{ sandbox: { mode: "read-only" } },
			{ sandbox: { mode: "workspace-write" } },
			{ mode: "read-only" },
			"sandbox.mode",
		],
		[
			"fallback",
			{ sandbox: { fallback: "block" } },
			{ sandbox: { fallback: "warn" } },
			{ fallback: "block" },
			"sandbox.fallback",
		],
		[
			"readScope",
			{ sandbox: { filesystem: { readScope: "workspace" } } },
			{ sandbox: { filesystem: { readScope: "all" } } },
			{ readScope: "workspace" },
			"sandbox.filesystem.readScope",
		],
		[
			"network deny → allowlist",
			{ sandbox: { network: { mode: "deny" } } },
			{ sandbox: { network: { mode: "allowlist" } } },
			{ networkMode: "deny" },
			"sandbox.network.mode",
		],
		[
			"network allowlist → allow",
			{ sandbox: { network: { mode: "allowlist" } } },
			{ sandbox: { network: { mode: "allow" } } },
			{ networkMode: "allowlist" },
			"sandbox.network.mode",
		],
		[
			"scope",
			{ sandbox: { scope: ["bash", "eval"] } },
			{ sandbox: { scope: ["bash"] } },
			{ scope: ["bash", "eval"] },
			"sandbox.scope",
		],
		[
			"denyRead (removal mixed with an addition)",
			{ sandbox: { filesystem: { denyRead: ["~/.ssh", "~/.aws"] } } },
			{ sandbox: { filesystem: { denyRead: ["~/.aws", "~/vault"] } } },
			{ denyRead: ["~/.ssh", "~/.aws", "~/vault"] },
			"sandbox.filesystem.denyRead",
		],
		[
			"allowWrite (addition mixed with a removal)",
			{ sandbox: { filesystem: { allowWrite: ["~/a", "~/b"] } } },
			{ sandbox: { filesystem: { allowWrite: ["~/a", "/etc"] } } },
			{ allowWrite: ["~/a"] },
			"sandbox.filesystem.allowWrite",
		],
		[
			"allowRead",
			{ sandbox: { filesystem: { allowRead: [] } } },
			{ sandbox: { filesystem: { allowRead: ["~/.ssh"] } } },
			{ allowRead: [] },
			"sandbox.filesystem.allowRead",
		],
		[
			"allowedHosts",
			{ sandbox: { network: { allowedHosts: ["a.test"] } } },
			{ sandbox: { network: { allowedHosts: ["a.test", "exfil.test"] } } },
			{ allowedHosts: ["a.test"] },
			"sandbox.network.allowedHosts",
		],
		[
			"windowsListDrives",
			{ sandbox: { enabled: true } },
			{ sandbox: { filesystem: { windowsListDrives: true } } },
			{ listDrives: false },
			"sandbox.filesystem.windowsListDrives",
		],
		[
			"windowsLoopback",
			{ sandbox: { enabled: true } },
			{ sandbox: { network: { windowsLoopback: true } } },
			{ loopback: false },
			"sandbox.network.windowsLoopback",
		],
		// A project `null` resets a setting to its default; it must not bypass the clamp.
		[
			"null enabled",
			{ sandbox: { enabled: true } },
			{ sandbox: { enabled: null } },
			{ enabled: true },
			"sandbox.enabled",
		],
		[
			"null mode",
			{ sandbox: { mode: "read-only" } },
			{ sandbox: { mode: null } },
			{ mode: "read-only" },
			"sandbox.mode",
		],
		[
			"null fallback",
			{ sandbox: { fallback: "block" } },
			{ sandbox: { fallback: null } },
			{ fallback: "block" },
			"sandbox.fallback",
		],
		[
			"null readScope",
			{ sandbox: { filesystem: { readScope: "workspace" } } },
			{ sandbox: { filesystem: { readScope: null } } },
			{ readScope: "workspace" },
			"sandbox.filesystem.readScope",
		],
		[
			"null network.mode",
			{ sandbox: { network: { mode: "deny" } } },
			{ sandbox: { network: { mode: null } } },
			{ networkMode: "deny" },
			"sandbox.network.mode",
		],
		[
			"null denyRead",
			{ sandbox: { filesystem: { denyRead: ["~/vault"] } } },
			{ sandbox: { filesystem: { denyRead: null } } },
			{ denyRead: expect.arrayContaining(["~/vault"]) },
			"sandbox.filesystem.denyRead",
		],
		[
			"null allowedHosts",
			{ sandbox: { network: { allowedHosts: ["github.com", "a.test"] } } },
			{ sandbox: { network: { allowedHosts: null } } },
			{ allowedHosts: ["github.com"] },
			"sandbox.network.allowedHosts",
		],
	])("ignores and reports a project loosening: %s", async (_name, global, project, expected, id) => {
		const result = await load(global, project);
		expect(result).toMatchObject(expected);
		expect(ignoredIds(result)).toEqual([id]);
	});

	it("keeps the defaults when the operator only enables the sandbox and the project loosens the lists", async () => {
		const result = await load(
			{ sandbox: { enabled: true } },
			{ sandbox: { filesystem: { denyRead: [], allowWrite: ["~"] }, network: { allowedHosts: ["exfil.test"] } } },
		);
		expect(result.denyRead).toEqual(cfgSandboxDenyRead.default);
		expect(result.allowWrite).toEqual([]);
		expect(result.allowedHosts).toEqual([]);
		expect(ignoredIds(result).toSorted()).toEqual([
			"sandbox.filesystem.allowWrite",
			"sandbox.filesystem.denyRead",
			"sandbox.network.allowedHosts",
		]);
	});

	it("names each dropped setting and keeps the tightening parts of a mixed project config", async () => {
		const result = await load(
			{ sandbox: { enabled: true, network: { mode: "allowlist", allowedHosts: ["a.test"] } } },
			{
				sandbox: {
					enabled: false,
					mode: "read-only",
					network: { mode: "deny", allowedHosts: ["a.test", "exfil.test"] },
				},
			},
		);
		expect(result).toMatchObject({ enabled: true, mode: "read-only", networkMode: "deny", allowedHosts: ["a.test"] });
		expect(ignoredIds(result).toSorted()).toEqual(["sandbox.enabled", "sandbox.network.allowedHosts"]);
	});

	describe("PI_SANDBOX", () => {
		afterEach(() => restoreEnvValue("PI_SANDBOX", undefined));

		it("a truthy value enables the sandbox", async () => {
			restoreEnvValue("PI_SANDBOX", "1");
			expect((await load({}, {})).enabled).toBe(true);
		});

		it("any other value cannot disable an operator-enabled sandbox", async () => {
			restoreEnvValue("PI_SANDBOX", "0");
			expect((await load({ sandbox: { enabled: true } }, {})).enabled).toBe(true);
		});
	});

	it("honours loosening values from the global layer", async () => {
		const result = await load(
			{
				sandbox: {
					enabled: false,
					network: { mode: "allow", allowedHosts: ["x.test"] },
					filesystem: { allowWrite: ["/data"] },
				},
			},
			{},
		);
		expect(result).toMatchObject({
			enabled: false,
			networkMode: "allow",
			allowedHosts: ["x.test"],
			allowWrite: ["/data"],
		});
		expect(result.ignored).toEqual([]);
	});
});
