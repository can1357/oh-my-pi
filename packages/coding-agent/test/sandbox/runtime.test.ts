import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disposePyToolBridge, ensurePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { nativeAddonDir } from "@oh-my-pi/pi-coding-agent/sandbox/context";
import { isWithin, networkPackages } from "@oh-my-pi/pi-coding-agent/sandbox/platform";
import {
	networkModeUnavailable,
	SandboxRuntime,
	SandboxUnavailableError,
} from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import type { SandboxChild } from "@oh-my-pi/pi-coding-agent/sandbox/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowRead,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxLoopback,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { type SandboxSupport, sandboxSupport } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";
import { git } from "../helpers/sandbox-test-state";

const UNAVAILABLE = { supported: false, reason: "test: no backend", proxy: false, warnings: [], networkMissing: [] };
const backend = sandboxSupport();

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/outside`, realpath'd: outside both the workspace and the (spied) tmpdir. */
let outside: string;
/** `<scratch>/tmp`, realpath'd: the stand-in system temp dir (spied `os.tmpdir()`). */
let systemTmp: string;
/** Tests that need the real system temp dir (short socket paths) restore it through this. */
let tmpdirSpy: { mockRestore(): void };
let runtimes: SandboxRuntime[];

async function runtime(dir = workspace): Promise<SandboxRuntime> {
	const instance = await SandboxRuntime.for(dir);
	runtimes.push(instance);
	return instance;
}

/** The host environment minus proxy variables, so only MXC's injected proxy settings apply. */
function childEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !/_proxy$/i.test(key)) env[key] = value;
	}
	return env;
}

async function run(
	instance: SandboxRuntime,
	script: string,
	options: { extraRead?: string[]; network?: "allow" | "deny" | "allowlist" } = {},
): Promise<{ code: number; stdout: string; stderr: string; child: SandboxChild }> {
	const child = await instance.spawn({
		argv: ["/bin/sh", "-c", script],
		cwd: workspace,
		env: childEnv(),
		extraRead: options.extraRead,
		network: options.network,
	});
	child.stdin.end();
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr, child };
}

/** `<outside>/main` with a linked worktree at `<outside>/wt`: the main repo's `.git`, the worktree's git dir and root. */
function linkedWorktree(): { commonDir: string; gitDir: string; worktree: string } {
	const main = path.join(outside, "main");
	const worktree = path.join(outside, "wt");
	fs.mkdirSync(main);
	git(main, "init", "-q");
	git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
	git(main, "worktree", "add", "-q", worktree);
	const commonDir = path.join(main, ".git");
	return { commonDir, gitDir: path.join(commonDir, "worktrees", "wt"), worktree };
}

beforeEach(() => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp, so `outside` would be
	// invisible to contained commands rather than read-only.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-sandbox-runtime-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	systemTmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, systemTmp]) fs.mkdirSync(dir);
	// Stands in for the system temp dir: the runtime's private temp dirs land (and get cleaned) here.
	tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(systemTmp);
	runtimes = [];
	SandboxRuntime.resetForTest();
});

afterEach(async () => {
	try {
		for (const instance of runtimes) await instance.dispose();
		SandboxRuntime.resetForTest();
		SandboxRuntime.setWarningSink(undefined);
		SandboxRuntime.setHostApprover(undefined);
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		// Persisted settings opened <agentDir>/agent.db; Windows cannot delete an open file.
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe("SandboxRuntime", () => {
	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true, cwd: workspace });
	});

	it.skipIf(process.platform === "win32")("returns one runtime per resolved workspace, through symlinks", async () => {
		const link = path.join(path.dirname(workspace), "link");
		fs.symlinkSync(workspace, link);
		expect(await runtime(link)).toBe(await runtime());
	});

	it("is off and applies nowhere while disabled, also for a workspace that does not exist", async () => {
		const instance = await runtime(path.join(workspace, "deleted"));
		expect(instance.status()).toEqual({ state: "off" });
		expect(instance.applies("bash")).toBe(false);
		expect(instance.applies("mcp")).toBe(false);
		expect(instance.resultMeta({ output: "Operation not permitted" })).toBeUndefined();
	});

	it("changes the fingerprint and notifies listeners when a sandbox setting changes", async () => {
		const instance = await runtime();
		const changed = Promise.withResolvers<void>();
		instance.onChange(changed.resolve);
		const before = instance.fingerprint();
		cfgSandboxMode.set(settings, "read-only");
		expect(instance.fingerprint()).not.toBe(before);
		await changed.promise;
		cfgSandboxMode.set(settings, "workspace-write");
		expect(instance.fingerprint()).toBe(before);
	});

	describe("resultMeta", () => {
		const MSYS_FATAL =
			"      0 [main] sh (9364) C:\\Program Files\\Git\\usr\\bin\\sh.exe: *** fatal error - NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-1888ae32e00d56aa): 0xC0000022";

		async function activeRuntime(): Promise<SandboxRuntime> {
			SandboxRuntime.resetForTest({ ...UNAVAILABLE, supported: true, backend: "seatbelt", proxy: true });
			const instance = await runtime();
			cfgSandboxEnabled.set(settings, true);
			return instance;
		}

		it("flags the Windows `Access is denied` wording as a denial, whatever its case", async () => {
			const instance = await activeRuntime();
			expect(instance.resultMeta({ output: "Access is denied.\n", exitCode: 1 })?.denied).toBe(true);
			expect(instance.resultMeta({ output: "ACCESS IS DENIED", exitCode: 1 })?.denied).toBe(true);
			expect(instance.resultMeta({ output: "all fine", exitCode: 1 })?.denied).toBeUndefined();
		});

		it("flags the macOS sqlite and dyld sandbox wordings as a denial", async () => {
			const instance = await activeRuntime();
			expect(
				instance.resultMeta({ output: "Error: unable to open database: authorization denied\n", exitCode: 1 })
					?.denied,
			).toBe(true);
			expect(
				instance.resultMeta({
					output: "dyld[123]: file system sandbox blocked open() of '/opt/lib/libx.dylib'\n",
					exitCode: 134,
				})?.denied,
			).toBe(true);
		});

		// One row per alternative of the patterns, each matching only that alternative.
		const RESOLUTION_FAILURES = [
			"curl: (6) Could not resolve host: example.com",
			"getaddrinfo EAI_AGAIN example.com",
			"socket.gaierror: [Errno 8] nodename nor servname provided, or not known",
			"socket.gaierror: [Errno -3] Temporary failure in name resolution",
			"Error: ENOTFOUND",
		];
		const REFUSED_CONNECTIONS = [
			"curl: (7) Couldn't connect to server",
			"ConnectionRefusedError: [Errno 111] Connection refused",
			"Error: connect ECONNREFUSED 127.0.0.1:5432",
		];

		it("flags a resolve or refused-connect failure as network-off only while the network mode is deny", async () => {
			const instance = await activeRuntime();
			const failures = [...RESOLUTION_FAILURES, ...REFUSED_CONNECTIONS];
			cfgSandboxNetworkMode.set(settings, "deny");
			for (const output of failures) {
				expect(instance.resultMeta({ output, exitCode: 1 })?.networkOff).toBe(true);
			}
			expect(instance.resultMeta({ output: "error: 404 Not Found", exitCode: 1 })?.networkOff).toBeUndefined();
			cfgSandboxNetworkMode.set(settings, "allowlist");
			for (const output of failures) {
				expect(instance.resultMeta({ output, exitCode: 1 })?.networkOff).toBeUndefined();
			}
		});

		it("flags a failure as network-off when a configured allowlist the host cannot enforce runs as deny", async () => {
			SandboxRuntime.resetForTest({
				supported: true,
				backend: "bubblewrap",
				proxy: false,
				warnings: [],
				networkMissing: ["slirp4netns"],
			});
			const instance = await runtime();
			cfgSandboxEnabled.set(settings, true);
			cfgSandboxNetworkMode.set(settings, "allowlist");
			expect(instance.status()).toMatchObject({ network: "deny" });
			expect(instance.resultMeta({ output: RESOLUTION_FAILURES[0], exitCode: 1 })?.networkOff).toBe(true);
		});

		it("does not count a refused connection as network-off while Windows loopback is open in deny mode", async () => {
			const instance = await activeRuntime();
			cfgSandboxNetworkMode.set(settings, "deny");
			cfgSandboxLoopback.set(settings, true);
			const platform = Object.getOwnPropertyDescriptor(process, "platform");
			if (!platform) throw new Error("process.platform has no descriptor");
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			try {
				for (const output of REFUSED_CONNECTIONS) {
					expect(instance.resultMeta({ output, exitCode: 1 })?.networkOff).toBeUndefined();
				}
				// A failed name resolution is the off network whatever the loopback does.
				for (const output of RESOLUTION_FAILURES) {
					expect(instance.resultMeta({ output, exitCode: 1 })?.networkOff).toBe(true);
				}
			} finally {
				Object.defineProperty(process, "platform", platform);
			}
		});

		it.skipIf(process.platform !== "win32")(
			"flags the MSYS runtime's fatal error as a start failure, not a bare 0xC0000022",
			async () => {
				const instance = await activeRuntime();
				expect(
					instance.resultMeta({ output: `error: hook failed\n${MSYS_FATAL}\n`, exitCode: 1 })?.startFailed,
				).toBe(true);
				// Only the `\BaseNamedObjects\msys-` object name, without the NtCreateDirectoryObject call, still matches.
				expect(
					instance.resultMeta({
						output:
							"      0 [main] sh (1) sh.exe: *** fatal error - can't create \\BaseNamedObjects\\msys-2.0S5-ab12",
						exitCode: 1,
					})?.startFailed,
				).toBe(true);
				// STATUS_ACCESS_DENIED from any other program, or a fatal error naming no MSYS object, is not it.
				expect(
					instance.resultMeta({ output: "tool: failed with status 0xC0000022", exitCode: 1 })?.startFailed,
				).toBeUndefined();
				expect(
					instance.resultMeta({ output: "git: *** fatal error - bad object", exitCode: 1 })?.startFailed,
				).toBeUndefined();
			},
		);

		it.skipIf(process.platform === "win32")("never reports a start failure off Windows", async () => {
			const instance = await activeRuntime();
			expect(instance.resultMeta({ output: MSYS_FATAL, exitCode: 1 })?.startFailed).toBeUndefined();
		});
	});

	it("honours the scope selection; mcp only needs the sandbox enabled", async () => {
		SandboxRuntime.resetForTest({ ...UNAVAILABLE, supported: true, backend: "seatbelt", proxy: true });
		const instance = await runtime();
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxScope.set(settings, ["eval"]);
		expect(instance.applies("bash")).toBe(false);
		expect(instance.applies("eval")).toBe(true);
		expect(instance.applies("mcp")).toBe(true);
		expect(await SandboxRuntime.forScope(workspace, "eval")).toBe(instance);
	});

	it("throws the reason when unavailable with fallback block", async () => {
		SandboxRuntime.resetForTest(UNAVAILABLE);
		const instance = await runtime();
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxFallback.set(settings, "block");
		expect(instance.status()).toEqual({ state: "unavailable", reason: UNAVAILABLE.reason, fallback: "block" });
		let error: unknown;
		try {
			instance.applies("bash");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SandboxUnavailableError);
		expect((error as SandboxUnavailableError).reason).toBe(UNAVAILABLE.reason);
	});

	it("warns once and runs unsandboxed when unavailable with fallback warn", async () => {
		SandboxRuntime.resetForTest(UNAVAILABLE);
		const warnings: string[] = [];
		SandboxRuntime.setWarningSink(message => warnings.push(message));
		const instance = await runtime();
		cfgSandboxEnabled.set(settings, true);
		expect(instance.applies("bash")).toBe(false);
		expect(instance.applies("eval")).toBe(false);
		expect(instance.applies("mcp")).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(UNAVAILABLE.reason);
	});

	describe("network modes this host cannot enforce", () => {
		const BUBBLEWRAP: SandboxSupport = {
			supported: true,
			backend: "bubblewrap",
			proxy: false,
			warnings: [],
			networkMissing: [],
		};

		it("names the missing packages and commands; deny always runs", () => {
			SandboxRuntime.resetForTest({ ...BUBBLEWRAP, networkMissing: ["slirp4netns", "ip"] });
			expect(networkModeUnavailable("allow")).toBe(
				'Network mode "allow" is unavailable on this host: packages slirp4netns, iproute2 are missing (commands: slirp4netns, ip). Install them to use this mode.',
			);
			expect(networkModeUnavailable("allowlist")).toBe(
				'Network mode "allowlist" is unavailable on this host: packages slirp4netns, iproute2 are missing (commands: slirp4netns, ip). Install them to use this mode.',
			);
			expect(networkModeUnavailable("deny")).toBeUndefined();
		});

		it("names one package once, in the singular, for several of its commands", () => {
			SandboxRuntime.resetForTest({ ...BUBBLEWRAP, networkMissing: ["iptables", "ip6tables-restore"] });
			expect(networkModeUnavailable("allow")).toBe(
				'Network mode "allow" is unavailable on this host: package iptables is missing (commands: iptables, ip6tables-restore). Install it to use this mode.',
			);
			SandboxRuntime.resetForTest({ ...BUBBLEWRAP, networkMissing: ["nsenter"] });
			expect(networkModeUnavailable("allow")).toBe(
				'Network mode "allow" is unavailable on this host: package util-linux is missing (command: nsenter). Install it to use this mode.',
			);
		});

		it("lists packages in table order, then commands the table does not know under their own name", () => {
			expect(networkPackages(["newtool", "iptables", "slirp4netns", "ip6tables"])).toEqual([
				"slirp4netns",
				"iptables",
				"newtool",
			]);
		});

		it("names util-linux once for nsenter and unshare", () => {
			expect(networkPackages(["unshare", "nsenter"])).toEqual(["util-linux"]);
			expect(networkPackages(["unshare"])).toEqual(["util-linux"]);
		});

		it("gives the backend's reason when no command is missing", () => {
			SandboxRuntime.resetForTest({ ...BUBBLEWRAP, networkReason: "unprivileged user namespaces are disabled." });
			expect(networkModeUnavailable("allow")).toBe(
				'Network mode "allow" is unavailable on this host: unprivileged user namespaces are disabled.',
			);
		});

		it.each(["seatbelt", "bubblewrap", "processcontainer"] as const)(
			"allows every mode on %s with proxy confinement",
			backend => {
				SandboxRuntime.resetForTest({ ...BUBBLEWRAP, backend, proxy: true });
				for (const mode of ["allow", "allowlist", "deny"] as const)
					expect(networkModeUnavailable(mode)).toBeUndefined();
			},
		);

		it("refuses only allowlist on processcontainer without the loopback proxy capability", () => {
			SandboxRuntime.resetForTest({
				...BUBBLEWRAP,
				backend: "processcontainer",
				networkReason: "the IdentitylessLoopbackProxy capability is missing",
			});
			expect(networkModeUnavailable("allowlist")).toBe(
				'Network mode "allowlist" is unavailable on this host: the IdentitylessLoopbackProxy capability is missing.',
			);
			expect(networkModeUnavailable("allow")).toBeUndefined();
		});

		it("reports nothing when no backend contains processes", () => {
			SandboxRuntime.resetForTest(UNAVAILABLE);
			expect(networkModeUnavailable("allowlist")).toBeUndefined();
		});

		it("denies the network and says why once in the status, without MXC's network warning", async () => {
			SandboxRuntime.resetForTest({
				...BUBBLEWRAP,
				warnings: ["unrelated diagnostic"],
				networkMissing: ["slirp4netns"],
				networkReason: "Bubblewrap: runtimeConfig.networkProxy requires 'slirp4netns' on PATH",
			});
			const instance = await runtime();
			cfgSandboxEnabled.set(settings, true);
			cfgSandboxNetworkMode.set(settings, "allow");
			expect(instance.status()).toEqual({
				state: "active",
				backend: "bubblewrap",
				network: "deny",
				warnings: [
					"unrelated diagnostic",
					'Network mode "allow" is unavailable on this host: package slirp4netns is missing (command: slirp4netns). Install it to use this mode. Network is denied instead.',
				],
			});
			cfgSandboxNetworkMode.set(settings, "deny");
			expect(instance.status()).toEqual({
				state: "active",
				backend: "bubblewrap",
				network: "deny",
				warnings: ["unrelated diagnostic"],
			});
		});

		it("degrades allowlist but not allow on seatbelt without proxy confinement", async () => {
			SandboxRuntime.resetForTest({ ...BUBBLEWRAP, backend: "seatbelt" });
			const instance = await runtime();
			cfgSandboxEnabled.set(settings, true);
			cfgSandboxNetworkMode.set(settings, "allowlist");
			expect(instance.status()).toEqual({
				state: "active",
				backend: "seatbelt",
				network: "deny",
				warnings: [
					'Network mode "allowlist" is unavailable on this host: the sandbox backend cannot confine network access here. Network is denied instead.',
				],
			});
			cfgSandboxNetworkMode.set(settings, "allow");
			expect(instance.status()).toEqual({ state: "active", backend: "seatbelt", network: "allow", warnings: [] });
		});
	});

	it("resolves an effective policy of existing realpaths, never the filesystem root", async () => {
		const instance = await runtime();
		cfgSandboxDenyRead.set(settings, [outside, path.join(outside, "missing")]);
		const policy = instance.effectivePolicy();
		expect(policy.readwritePaths).toContain(workspace);
		expect(policy.deniedPaths).toEqual([outside]);
		for (const entry of [...policy.readwritePaths, ...policy.readonlyPaths, ...policy.deniedPaths]) {
			expect(entry).not.toBe("/");
			expect(fs.realpathSync(entry)).toBe(entry);
		}
	});

	it("grants a private temp dir instead of the system temp dir", async () => {
		const instance = await runtime();
		const tempDir = instance.tempDir();
		expect(path.dirname(tempDir)).toBe(systemTmp);
		// Windows has no POSIX permission bits.
		if (process.platform !== "win32") expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
		const { readwritePaths } = instance.effectivePolicy();
		expect(readwritePaths).toContain(tempDir);
		expect(readwritePaths).not.toContain(systemTmp);
	});

	it("removes the private temp dir on dispose", async () => {
		const instance = await runtime();
		const tempDir = instance.tempDir();
		fs.writeFileSync(path.join(tempDir, "left-behind"), "x");
		await instance.dispose();
		expect(fs.existsSync(tempDir)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"replaces a private temp dir swapped for a symlink instead of following it",
		async () => {
			const instance = await runtime();
			const tempDir = instance.tempDir();
			fs.rmSync(tempDir, { recursive: true });
			fs.symlinkSync(outside, tempDir);
			const replaced = instance.tempDir();
			expect(replaced).not.toBe(tempDir);
			expect(instance.effectivePolicy().readwritePaths).not.toContain(outside);
			fs.unlinkSync(tempDir);
		},
	);

	it("re-reads path existence on every policy computation", async () => {
		const instance = await runtime();
		const later = path.join(outside, "later");
		cfgSandboxDenyRead.set(settings, [later]);
		expect(instance.effectivePolicy().deniedPaths).toEqual([]);
		fs.mkdirSync(later);
		expect(instance.effectivePolicy().deniedPaths).toEqual([later]);
	});

	// bubblewrap refuses a whole request that names a path the invoking user cannot read (`/root`).
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"drops granted paths the user cannot access",
		async () => {
			const locked = path.join(outside, "locked");
			const open = path.join(outside, "open");
			fs.mkdirSync(locked, { mode: 0o000 });
			fs.mkdirSync(open);
			try {
				cfgSandboxReadScope.set(settings, "workspace");
				cfgSandboxAllowRead.set(settings, [locked, open]);
				const policy = (await runtime()).effectivePolicy();
				expect(policy.readonlyPaths).toContain(open);
				expect(policy.readonlyPaths).not.toContain(locked);
			} finally {
				fs.chmodSync(locked, 0o700);
			}
		},
	);

	it("follows a settings change into the policy; read-only leaves only the private temp dir writable", async () => {
		const instance = await runtime();
		expect(instance.effectivePolicy().readwritePaths).toContain(workspace);
		cfgSandboxMode.set(settings, "read-only");
		expect(instance.effectivePolicy().readwritePaths).toEqual([instance.tempDir()]);
	});

	it("ignores a forged linked-worktree common dir in the workspace", async () => {
		const gitDir = path.join(workspace, "forged", "worktrees", "wt");
		fs.mkdirSync(gitDir, { recursive: true });
		fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		fs.writeFileSync(path.join(gitDir, "commondir"), `${outside}\n`);
		fs.writeFileSync(path.join(gitDir, "gitdir"), `${path.join(workspace, ".git")}\n`);
		fs.writeFileSync(path.join(workspace, ".git"), `gitdir: ${gitDir}\n`);
		cfgSandboxReadScope.set(settings, "workspace");
		const policy = (await runtime()).effectivePolicy();
		expect(policy.readwritePaths).not.toContain(outside);
		expect(policy.readonlyPaths).not.toContain(outside);
	});

	it.skipIf(!Bun.which("git"))(
		"grants a linked worktree its common dir's stores, never the shared hooks or config",
		async () => {
			const { commonDir, gitDir, worktree } = linkedWorktree();
			cfgSandboxMode.set(settings, "read-only");
			cfgSandboxReadScope.set(settings, "workspace");
			expect((await runtime(worktree)).effectivePolicy().readonlyPaths).toContain(commonDir);
			cfgSandboxMode.set(settings, "workspace-write");
			const policy = (await runtime(worktree)).effectivePolicy();
			expect(policy.readonlyPaths).toContain(commonDir);
			for (const store of [gitDir, path.join(commonDir, "objects"), path.join(commonDir, "refs")]) {
				expect(policy.readwritePaths).toContain(store);
			}
			expect(policy.readwritePaths).not.toContain(commonDir);
			// A workspace in the worktree's subdirectory gets the same grant.
			const pkg = path.join(worktree, "pkg");
			fs.mkdirSync(pkg);
			const nested = (await runtime(pkg)).effectivePolicy();
			expect(nested.readwritePaths).toContain(gitDir);
			expect(nested.readwritePaths).toContain(path.join(commonDir, "objects"));
			expect(nested.readwritePaths).not.toContain(commonDir);
		},
	);

	it.skipIf(!Bun.which("git") || process.platform === "win32")(
		"ignores a workspace .git symlinked to another worktree's entry",
		async () => {
			const { commonDir, worktree } = linkedWorktree();
			fs.symlinkSync(path.join(worktree, ".git"), path.join(workspace, ".git"));
			cfgSandboxReadScope.set(settings, "workspace");
			const policy = (await runtime()).effectivePolicy();
			expect(policy.readwritePaths).not.toContain(commonDir);
			expect(policy.readonlyPaths).not.toContain(commonDir);
		},
	);

	it.skipIf(!Bun.which("git"))(
		"keeps git hooks and config read-only inside the writable workspace until a grant at or below them",
		async () => {
			git(workspace, "init", "-q");
			const instance = await runtime();
			const hooks = path.join(workspace, ".git", "hooks");
			const config = path.join(workspace, ".git", "config");
			const policy = instance.effectivePolicy();
			expect(policy.readwritePaths).toContain(workspace);
			expect(policy.readonlyPaths).toEqual(expect.arrayContaining([hooks, config]));
			const hook = [{ kind: "write" as const, target: path.join(hooks, "pre-commit") }];
			expect(instance.accessDenial(hook)).toMatchObject({ liftable: true, target: hooks });
			// An ancestor grant does not lift it; one below lifts only its own subtree.
			instance.grantPath("write", path.join(workspace, ".git"), "session");
			const below = path.join(hooks, "lib");
			instance.grantPath("write", below, "session");
			expect(instance.effectivePolicy().readwritePaths).toContain(below);
			expect(instance.accessDenial([{ kind: "write", target: path.join(below, "x") }])).toBeUndefined();
			expect(instance.accessDenial(hook)).toMatchObject({ target: hooks });
			instance.grantPath("write", hooks, "session");
			expect(instance.accessDenial(hook)).toBeUndefined();
			expect(instance.effectivePolicy().readonlyPaths).not.toContain(hooks);
			expect(instance.effectivePolicy().readonlyPaths).toContain(config);
		},
	);

	it.skipIf(!Bun.which("git") || process.platform === "win32")(
		"protects nested submodule git dirs, checkout pointers and redirect files, each directory above them a writable entry",
		async () => {
			git(workspace, "init", "-q");
			const gitDir = path.join(workspace, ".git");
			const modules = path.join(gitDir, "modules");
			// A name holding a slash (`vendor/lib`), and `b` nested under submodule `a` (a git dir by its HEAD).
			const named = path.join(modules, "vendor", "lib");
			const parent = path.join(modules, "a");
			const nested = path.join(parent, "modules", "b");
			const other = path.join(gitDir, "worktrees", "other");
			for (const dir of [named, path.join(nested, "hooks"), other]) fs.mkdirSync(dir, { recursive: true });
			for (const file of [path.join(named, "config"), path.join(parent, "config"), path.join(nested, "HEAD")]) {
				fs.writeFileSync(file, "");
			}
			fs.writeFileSync(path.join(other, "commondir"), "../..\n");
			// A real submodule: its checkout's `.git` pointer is found through the `core.worktree`
			// `git submodule add` writes into the (protected) submodule config.
			const source = path.join(outside, "source");
			fs.mkdirSync(source);
			git(source, "init", "-q");
			git(source, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
			git(workspace, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "deps/real");
			const pointer = path.join(workspace, "deps", "real", ".git");
			// An unreadable directory under `modules/` is skipped, never thrown out of policy building.
			const locked = path.join(modules, "locked");
			fs.mkdirSync(locked, { mode: 0 });
			try {
				const instance = await runtime();
				const policy = instance.effectivePolicy();
				expect(policy.readonlyPaths).toEqual(
					expect.arrayContaining([
						path.join(named, "config"),
						path.join(parent, "config"),
						path.join(nested, "hooks"),
						path.join(other, "commondir"),
						pointer,
					]),
				);
				expect(policy.readwritePaths).toEqual(
					expect.arrayContaining([gitDir, modules, path.join(modules, "vendor"), named, parent, nested, other]),
				);
				expect(instance.accessDenial([{ kind: "write", target: pointer }])).toMatchObject({
					target: pointer,
					protectedPath: true,
				});
				// Missing, it is refused in-process: a contained process cannot create it (no write grant).
				const commondir = path.join(gitDir, "commondir");
				expect(instance.accessDenial([{ kind: "write", target: commondir }])).toMatchObject({
					target: commondir,
					protectedPath: true,
				});
				// A denied `.git` gets no deeper entry: one would reopen the denied mount for contained processes.
				cfgSandboxDenyRead.set(settings, [gitDir]);
				const denied = instance.effectivePolicy();
				expect(denied.deniedPaths).toContain(gitDir);
				const under = [...denied.readwritePaths, ...denied.readonlyPaths].filter(entry =>
					isWithin(entry, gitDir, process.platform),
				);
				expect(under).toEqual([]);
			} finally {
				fs.chmodSync(locked, 0o700);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses writes through a protected entry that is or becomes a symlink, until a grant of its target",
		async () => {
			const instance = await runtime();
			const write = (target: string) => instance.accessDenial([{ kind: "write", target }]);
			const omp = path.join(workspace, ".omp");
			const evil = path.join(workspace, "evil");
			// Gathered while `.omp` is missing; then pointed at `evil`, from where omp would load it.
			expect(write(path.join(evil, "x"))).toBeUndefined();
			fs.mkdirSync(evil);
			fs.symlinkSync(evil, omp);
			expect(write(path.join(evil, "x"))).toMatchObject({ target: omp, protectedPath: true });
			// Granting `.omp` grants its target, which lifts the link too.
			instance.grantPath("write", omp, "session");
			expect(write(path.join(omp, "x"))).toBeUndefined();
			expect(instance.effectivePolicy().readonlyPaths).not.toContain(evil);
			// A symlink below the entry: only the lexical path shows the write lands in `.cursor`.
			const cursor = path.join(workspace, ".cursor");
			fs.mkdirSync(cursor);
			fs.mkdirSync(path.join(workspace, "other"));
			fs.symlinkSync(path.join(workspace, "other"), path.join(cursor, "sub"));
			expect(write(path.join(cursor, "sub", "x"))).toMatchObject({ target: cursor, protectedPath: true });
		},
	);

	it("lets a session grant of a missing protected file write it, without creating a directory there", async () => {
		const instance = await runtime();
		const mcp = path.join(workspace, ".mcp.json");
		instance.grantPath("write", mcp, "session");
		instance.effectivePolicy();
		expect(fs.existsSync(mcp)).toBe(false);
		expect(instance.accessDenial([{ kind: "write", target: mcp }])).toBeUndefined();
		// A repeat grant (the first now lifts the protection) must not create a directory either.
		instance.grantPath("write", mcp, "session");
		instance.grantPath("write", mcp, "always");
		instance.effectivePolicy();
		expect(fs.existsSync(mcp)).toBe(false);
	});

	it.skipIf(!Bun.which("git"))(
		"protects core.hooksPath relative to the repository root, read before any caller gets the runtime",
		async () => {
			const { repo, pkg } = repoWithPackage();
			git(repo, "config", "core.hooksPath", ".githooks");
			// Concurrent with the call that creates the runtime: it must not see it before the read.
			const first = runtime(pkg);
			const instance = await runtime(pkg);
			const hook = [{ kind: "write" as const, target: path.join(repo, ".githooks", "pre-commit") }];
			expect(instance.accessDenial(hook)).toMatchObject({
				target: path.join(repo, ".githooks"),
				protectedPath: true,
			});
			await first;
			const before = instance.fingerprint();
			git(repo, "config", "core.hooksPath", ".husky");
			await instance.dispose();
			const next = await runtime(pkg);
			expect(next.fingerprint()).not.toBe(before);
			expect(next.effectivePolicy().protectedPaths.map(({ entry }) => entry)).toContain(path.join(repo, ".husky"));
		},
	);

	/** Ordinary checkout at `<outside>/repo` with a `pkg` subdirectory; returns both. */
	function repoWithPackage(): { repo: string; pkg: string } {
		const repo = path.join(outside, "repo");
		const pkg = path.join(repo, "pkg");
		fs.mkdirSync(pkg, { recursive: true });
		git(repo, "init", "-q");
		return { repo, pkg };
	}

	it.skipIf(!Bun.which("git"))("grants the enclosing repository's .git to a workspace in a subdirectory", async () => {
		const { repo, pkg } = repoWithPackage();
		expect((await runtime(pkg)).effectivePolicy().readwritePaths).toContain(path.join(repo, ".git"));
	});

	it.skipIf(!Bun.which("git"))("never grants the .git of a repository rooted at the home directory", async () => {
		const { repo, pkg } = repoWithPackage();
		vi.spyOn(os, "homedir").mockReturnValue(repo);
		const policy = (await runtime(pkg)).effectivePolicy();
		expect(policy.readwritePaths).not.toContain(path.join(repo, ".git"));
	});

	it("keeps omp's own executable and natives addon readable under the workspace read scope", async () => {
		// Only a bare PATH for the discovered tool paths, so the runtime paths alone must cover them.
		restoreEnvValue("PATH", "/usr/bin:/bin");
		cfgSandboxReadScope.set(settings, "workspace");
		const policy = (await runtime()).effectivePolicy();
		const roots = [...policy.readonlyPaths, ...policy.readwritePaths];
		const addonDir = nativeAddonDir();
		const required = [path.dirname(fs.realpathSync(process.execPath))];
		if (addonDir !== undefined) required.push(fs.realpathSync(addonDir));
		for (const dir of required) {
			expect(
				roots.some(root => isWithin(dir, root, process.platform)),
				dir,
			).toBe(true);
		}
	});
});

describe("SandboxRuntime always grant with layered allowlists", () => {
	it("appends only the granted host to the global list", async () => {
		const agentDir = path.join(path.dirname(workspace), "agent");
		await Bun.write(
			path.join(workspace, ".omp", "config.yml"),
			YAML.stringify({ sandbox: { network: { allowedHosts: ["exfil.test"] } } }),
		);
		settings = await Settings.init({ agentDir, cwd: workspace });
		const instance = await runtime();
		instance.grantHost("granted.test", "always");
		const global = cfgSandboxAllowedHosts.get(settings.grantAuthority());
		expect(global).toContain("granted.test");
		expect(global).not.toContain("exfil.test");
	});

	it("persists only the granted host when a --config overlay lists more hosts", async () => {
		const agentDir = path.join(path.dirname(workspace), "agent");
		const overlay = path.join(path.dirname(workspace), "overlay.yml");
		await Bun.write(overlay, YAML.stringify({ sandbox: { network: { allowedHosts: ["overlay.test"] } } }));
		settings = await Settings.init({ agentDir, cwd: workspace, configFiles: [overlay] });
		expect(cfgSandboxAllowedHosts.get(settings.grantAuthority())).toContain("overlay.test");
		const instance = await runtime();
		instance.grantHost("granted.test", "always");
		expect(settings.getGlobalSettings()).toMatchObject({
			sandbox: { network: { allowedHosts: [...cfgSandboxAllowedHosts.default, "granted.test"] } },
		});
	});
});

describe.skipIf(!backend.supported || process.platform === "win32")("SandboxRuntime spawn", () => {
	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "deny");
	});

	it("writes inside the workspace, not outside, and marks the child env", async () => {
		const instance = await runtime();
		const inside = path.join(workspace, "inside.txt");
		const blocked = path.join(outside, "outside.txt");
		const result = await run(instance, `echo "$OMP_SANDBOX" && echo ok > '${inside}' && echo bad > '${blocked}'`);
		expect(result.stdout).toBe("1\n");
		expect(fs.readFileSync(inside, "utf8")).toBe("ok\n");
		expect(fs.existsSync(blocked)).toBe(false);
		expect(result.code).not.toBe(0);
		expect(result.child.exitCode).toBe(result.code);
		expect(instance.resultMeta({ output: result.stderr })?.denied).toBe(true);
	});

	it.skipIf(!Bun.which("git"))(
		"cannot write the workspace's git config while the workspace stays writable",
		async () => {
			git(workspace, "init", "-q");
			const config = path.join(workspace, ".git", "config");
			const before = fs.readFileSync(config, "utf8");
			const result = await run(await runtime(), "echo ok > ok.txt; echo x >> .git/config");
			expect(result.code).not.toBe(0);
			expect(fs.readFileSync(path.join(workspace, "ok.txt"), "utf8")).toBe("ok\n");
			expect(fs.readFileSync(config, "utf8")).toBe(before);
		},
	);

	// Path-rule backends (Seatbelt) cannot pin a directory: that is the identity watch's job.
	it.skipIf(!Bun.which("git") || backend.backend !== "bubblewrap")(
		"cannot rename .git away and plant a writable git config in its place",
		async () => {
			git(workspace, "init", "-q");
			const config = path.join(workspace, ".git", "config");
			const before = fs.readFileSync(config, "utf8");
			const result = await run(
				await runtime(),
				"echo ok > ok.txt; mv .git .git-old && mkdir -p .git/hooks && echo x > .git/config",
			);
			expect(result.code).not.toBe(0);
			expect(fs.readFileSync(path.join(workspace, "ok.txt"), "utf8")).toBe("ok\n");
			expect(fs.existsSync(path.join(workspace, ".git-old"))).toBe(false);
			expect(fs.readFileSync(config, "utf8")).toBe(before);
		},
	);

	it.skipIf(!backend.proxy)(
		"replaces the parent's proxy variables with the egress proxy in allowlist mode",
		async () => {
			cfgSandboxNetworkMode.set(settings, "allowlist");
			const instance = await runtime();
			const corp = "http://corp-proxy.invalid:3128";
			const child = await instance.spawn({
				argv: ["/bin/sh", "-c", 'printf "%s\\n%s\\n%s\\n" "$HTTP_PROXY" "$all_proxy" "$NO_PROXY"'],
				cwd: workspace,
				env: { ...childEnv(), HTTP_PROXY: corp, all_proxy: corp, NO_PROXY: "*" },
			});
			child.stdin.end();
			const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			const [httpProxy, allProxy, noProxy] = stdout.split("\n");
			// A parent proxy would route traffic past the egress proxy into the denied network. MXC names
			// the egress proxy by address: loopback, or slirp's host gateway on bubblewrap.
			expect(httpProxy).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+/);
			expect(allProxy).not.toBe(corp);
			expect(noProxy).not.toBe("*");
		},
	);

	it.skipIf(!Bun.which("git"))(
		"commits from a linked worktree but cannot plant a hook in the shared common dir",
		async () => {
			const { commonDir, worktree } = linkedWorktree();
			const instance = await runtime(worktree);
			const hook = path.join(commonDir, "hooks", "post-checkout");
			const child = await instance.spawn({
				argv: [
					"/bin/sh",
					"-c",
					`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m contained && echo committed; echo evil > '${hook}'`,
				],
				cwd: worktree,
				env: { ...childEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			});
			child.stdin.end();
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stdout, stderr).toBe("committed\n");
			expect(code).not.toBe(0);
			expect(fs.existsSync(hook)).toBe(false);
		},
	);

	it("writes its private TMPDIR but not the system temp dir", async () => {
		const instance = await runtime();
		const direct = path.join(systemTmp, "direct.txt");
		const realSystem = path.join(path.dirname(path.dirname(systemTmp)), `omp-sb-test-${process.pid}.txt`);
		try {
			const result = await run(
				instance,
				`echo ok > "$TMPDIR/x" && [ "$TMP" = "$TMPDIR" ] && [ "$TEMP" = "$TMPDIR" ] && echo "$TMPDIR"; echo bad > '${direct}'; echo bad > '${realSystem}'`,
			);
			expect(result.stdout).toBe(`${instance.tempDir()}\n`);
			expect(fs.readFileSync(path.join(instance.tempDir(), "x"), "utf8")).toBe("ok\n");
			expect(fs.existsSync(direct)).toBe(false);
			expect(fs.existsSync(realSystem)).toBe(false);
		} finally {
			fs.rmSync(realSystem, { force: true });
		}
	});

	it("reads a parent-staged file outside the workspace scope only through extraRead, and cannot modify it", async () => {
		const staged = path.join(systemTmp, "runner.sh");
		fs.writeFileSync(staged, "echo staged\n");
		cfgSandboxReadScope.set(settings, "workspace");
		const instance = await runtime();
		expect((await run(instance, `cat '${staged}'`)).code).not.toBe(0);
		const result = await run(instance, `cat '${staged}'; echo evil >> '${staged}'`, { extraRead: [staged] });
		expect(result.stdout).toBe("echo staged\n");
		expect(result.code).not.toBe(0);
		expect(fs.readFileSync(staged, "utf8")).toBe("echo staged\n");
	});

	it("cannot connect to a Unix socket in the system temp dir, only to one in its private dir", async () => {
		// Real system temp dir: socket paths must fit `sun_path` (104 bytes on macOS).
		tmpdirSpy.mockRestore();
		const outsideSocket = path.join(fs.realpathSync(os.tmpdir()), `omp-sbt-${process.pid}.sock`);
		const instance = await runtime();
		const insideSocket = path.join(instance.tempDir(), "t.sock");
		// The listener leaves closing to the client: one that ends the connection on accept can reset it
		// before the client's connect completes (`ECONNRESET`), which would read as a denial.
		const listeners = [outsideSocket, insideSocket].map(unix => Bun.listen({ unix, socket: { data() {} } }));
		try {
			const connect = async (sock: string) => {
				const child = await instance.spawn({
					argv: [
						process.execPath,
						"-e",
						"(await Bun.connect({ unix: process.env.SOCK, socket: { data() {} } })).end()",
					],
					cwd: workspace,
					env: { ...childEnv(), SOCK: sock },
				});
				child.stdin.end();
				await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
				return child.exited;
			};
			expect(await connect(insideSocket)).toBe(0);
			expect(await connect(outsideSocket)).not.toBe(0);
		} finally {
			for (const listener of listeners) listener.stop(true);
			fs.rmSync(outsideSocket, { force: true });
		}
	});

	it("keeps the Python tool bridge socket path short enough for sun_path", async () => {
		tmpdirSpy.mockRestore();
		const instance = await runtime();
		const info = await ensurePyToolBridge(instance.tempDir());
		try {
			const socketPath = info.url.slice("unix:".length);
			expect(path.dirname(socketPath)).toBe(instance.tempDir());
			expect(Buffer.byteLength(socketPath)).toBeLessThan(100);
		} finally {
			await disposePyToolBridge();
		}
	});

	it("cannot read a denied path while its sibling stays readable", async () => {
		const denied = path.join(outside, "denied");
		fs.mkdirSync(denied);
		fs.writeFileSync(path.join(denied, "secret.txt"), "secret\n");
		fs.writeFileSync(path.join(outside, "visible.txt"), "visible\n");
		cfgSandboxDenyRead.set(settings, [denied]);
		const instance = await runtime();
		const result = await run(instance, `cat '${path.join(outside, "visible.txt")}'; cat '${denied}/secret.txt'`);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("visible\n");
	});

	it("denies the host loopback under the configured deny mode", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served") });
		try {
			const result = await run(await runtime(), `curl -sS --max-time 10 http://127.0.0.1:${server.port}/`);
			expect(result.code).not.toBe(0);
		} finally {
			await server.stop(true);
		}
	});

	// bubblewrap's `allow` runs in a private netns whose loopback is not the host's.
	it.skipIf(backend.backend === "bubblewrap")("lets a request override the configured network mode", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served") });
		try {
			const curl = `curl -sS --max-time 10 http://127.0.0.1:${server.port}/`;
			const allowed = await run(await runtime(), curl, { network: "allow" });
			expect(allowed.stdout).toBe("served");
		} finally {
			await server.stop(true);
		}
	});

	it("delivers stdin in write order and closes stdout at EOF", async () => {
		const instance = await runtime();
		const child = await instance.spawn({ argv: ["/bin/cat"], cwd: workspace, env: childEnv() });
		child.stdin.write("a");
		child.stdin.write(new TextEncoder().encode("b"));
		child.stdin.write("c");
		child.stdin.end();
		expect(await new Response(child.stdout).text()).toBe("abc");
		expect(await child.exited).toBe(0);
	});

	it("kill() ends a sleeping child with 137 and is idempotent", async () => {
		const instance = await runtime();
		const child = await instance.spawn({ argv: ["/bin/sleep", "30"], cwd: workspace, env: childEnv() });
		child.kill();
		child.kill();
		expect(await child.exited).toBe(137);
		expect(child.exitCode).toBe(137);
	});

	it.skipIf(!backend.proxy)(
		"allowlist refuses unlisted hosts; a session grant passes them with prompt-approved rules",
		async () => {
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served") });
			try {
				// The proxy runs in this process: resolve test names here and route the private
				// address to the local server instead of dialling it.
				const records: Record<string, string> = { "intranet.test": "10.0.0.5" };
				vi.spyOn(Bun.dns, "lookup").mockImplementation(async (hostname: string) => {
					const address = records[hostname];
					if (!address) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
					return [{ address, family: 4, ttl: 0 }];
				});
				const realConnect = Bun.connect.bind(Bun);
				vi.spyOn(Bun, "connect").mockImplementation(options => {
					if ("hostname" in options && options.hostname === "10.0.0.5") {
						return realConnect({ ...options, hostname: "127.0.0.1" });
					}
					// Narrowed per branch so each call resolves to its own `Bun.connect` overload.
					return "unix" in options ? realConnect(options) : realConnect(options);
				});
				cfgSandboxNetworkMode.set(settings, "allowlist");
				cfgSandboxAllowedHosts.set(settings, []);
				const instance = await runtime();
				const since = Date.now();
				// Explicit `--proxy`: curl ignores upper-case HTTP_PROXY for http:// URLs.
				const curl = (host: string) =>
					`curl -sS --max-time 10 --proxy "$HTTP_PROXY" -w ' %{http_code}' http://${host}:${server.port}/`;
				expect((await run(instance, `${curl("intranet.test")} -o /dev/null`)).stdout).toBe(" 403");
				expect(instance.blockedHosts()).toEqual(["intranet.test"]);
				expect(instance.resultMeta({ blockedSince: since })?.blockedHosts).toEqual(["intranet.test"]);

				instance.grantHost("intranet.test", "session");
				expect((await run(instance, curl("intranet.test"))).stdout).toBe("served 200");
				expect(instance.blockedHosts()).toEqual([]);
			} finally {
				await server.stop(true);
			}
		},
	);
});

describe.skipIf(!backend.supported || !backend.proxy || process.platform === "win32")(
	"SandboxRuntime allowlist across a project reload",
	() => {
		it("a running process keeps the allowlist it started under when a later project allows more", async () => {
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served") });
			const agentDir = path.join(path.dirname(workspace), "agent");
			const projectB = path.join(outside, "project-b");
			fs.mkdirSync(projectB);
			try {
				await Bun.write(
					path.join(agentDir, "config.yml"),
					YAML.stringify({
						sandbox: { enabled: true, network: { mode: "allowlist", allowedHosts: ["127.0.0.1"] } },
					}),
				);
				// Project A drops the host from its allowlist; project B leaves the global list as is.
				await Bun.write(
					path.join(workspace, ".omp", "config.yml"),
					YAML.stringify({ sandbox: { network: { allowedHosts: [] } } }),
				);
				settings = await Settings.init({ agentDir, cwd: workspace });
				const instance = await runtime();
				const curl = `curl -sS --max-time 10 --proxy "$HTTP_PROXY" -o /dev/null -w '%{http_code}' http://127.0.0.1:${server.port}/`;
				const child = await instance.spawn({
					argv: ["/bin/sh", "-c", `read go; ${curl}`],
					cwd: workspace,
					env: childEnv(),
				});
				await settings.reloadForCwd(projectB);
				// Under B's settings a new process reaches the host...
				const fresh = await run(await runtime(projectB), curl);
				expect(fresh.stdout).toBe("200");
				// ...but the process started under A still does not.
				child.stdin.write("go\n");
				child.stdin.end();
				const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
				expect(stdout).toBe("403");
			} finally {
				await server.stop(true);
			}
		});
	},
);
