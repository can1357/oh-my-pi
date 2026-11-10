import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disposePyToolBridge, ensurePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type SandboxChild, SandboxRuntime, SandboxUnavailableError } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowRead,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { sandboxSupport } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const UNAVAILABLE = { supported: false, reason: "test: no backend", proxy: false, warnings: [] };
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
	options: { stdin?: string; extraRead?: string[]; network?: "allow" | "deny" | "allowlist" } = {},
): Promise<{ code: number; stdout: string; stderr: string; child: SandboxChild }> {
	const child = await instance.spawn({
		argv: ["/bin/sh", "-c", script],
		cwd: workspace,
		env: childEnv(),
		extraRead: options.extraRead,
		network: options.network,
	});
	if (options.stdin !== undefined) child.stdin.write(options.stdin);
	child.stdin.end();
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr, child };
}

function git(cwd: string, ...args: string[]): void {
	// Isolated from the developer's global/system git config (signing, hooks, templates).
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "ignore", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

beforeEach(() => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	scratch = TempDir.createSync("@omp-sandbox-runtime-");
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

	it("accepts a workspace that does not exist", async () => {
		const instance = await runtime(path.join(workspace, "deleted"));
		expect(instance.status()).toEqual({ state: "off" });
		expect(instance.applies("exec")).toBe(false);
	});

	it("is off and applies nowhere while disabled", async () => {
		const instance = await runtime();
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

	it("gives different workspaces different fingerprints", async () => {
		expect((await runtime()).fingerprint()).not.toBe((await runtime(outside)).fingerprint());
	});

	it("honours the scope selection; mcp only needs the sandbox enabled", async () => {
		SandboxRuntime.resetForTest({ ...UNAVAILABLE, supported: true, backend: "seatbelt", proxy: true });
		const instance = await runtime();
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxScope.set(settings, ["eval"]);
		expect(instance.applies("bash")).toBe(false);
		expect(instance.applies("eval")).toBe(true);
		expect(instance.applies("mcp")).toBe(true);
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

	it("degrades allowlist to deny with a status warning when proxy confinement is missing", async () => {
		SandboxRuntime.resetForTest({ ...UNAVAILABLE, supported: true, backend: "seatbelt", proxy: false });
		const instance = await runtime();
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "allowlist");
		const degraded = instance.status();
		expect(degraded).toMatchObject({ state: "active", backend: "seatbelt", network: "deny" });
		const warnings = degraded.state === "active" ? degraded.warnings : [];
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("allowlist");
		cfgSandboxNetworkMode.set(settings, "allow");
		expect(instance.status()).toEqual({ state: "active", backend: "seatbelt", network: "allow", warnings: [] });
	});

	it("degrades allow to deny on bubblewrap without the host networking tools", async () => {
		SandboxRuntime.resetForTest({ ...UNAVAILABLE, supported: true, backend: "bubblewrap", proxy: false });
		const instance = await runtime();
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "allow");
		const degraded = instance.status();
		expect(degraded).toMatchObject({ state: "active", backend: "bubblewrap", network: "deny" });
		const warnings = degraded.state === "active" ? degraded.warnings : [];
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("bubblewrap");
	});

	it("persists an always grant to the global allowlist; a session grant stays out of settings", async () => {
		const instance = await runtime();
		await instance.grantHost("example.test", "always");
		expect(cfgSandboxAllowedHosts.get(settings)).toContain("example.test");
		await instance.grantHost("session.test", "session");
		expect(cfgSandboxAllowedHosts.get(settings)).not.toContain("session.test");
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
		expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
		const { readwritePaths } = instance.effectivePolicy();
		expect(readwritePaths).toContain(tempDir);
		expect(readwritePaths).not.toContain(systemTmp);
		expect(instance.tempDir()).toBe(tempDir);
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

	/** `<outside>/main` with a linked worktree at `<outside>/wt`; returns the main repo's `.git`. */
	function linkedWorktree(): { commonDir: string; worktree: string } {
		const main = path.join(outside, "main");
		const worktree = path.join(outside, "wt");
		fs.mkdirSync(main);
		git(main, "init", "-q");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
		git(main, "worktree", "add", "-q", worktree);
		return { commonDir: path.join(main, ".git"), worktree };
	}

	it.skipIf(!Bun.which("git"))("grants a real linked worktree's common dir", async () => {
		const { commonDir, worktree } = linkedWorktree();
		cfgSandboxMode.set(settings, "read-only");
		cfgSandboxReadScope.set(settings, "workspace");
		expect((await runtime(worktree)).effectivePolicy().readonlyPaths).toContain(commonDir);
		cfgSandboxMode.set(settings, "workspace-write");
		expect((await runtime(worktree)).effectivePolicy().readwritePaths).toContain(commonDir);
	});

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
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(repo);
		try {
			const policy = (await runtime(pkg)).effectivePolicy();
			expect(policy.readwritePaths).not.toContain(path.join(repo, ".git"));
		} finally {
			homeSpy.mockRestore();
		}
	});

	it.skipIf(!Bun.which("git"))(
		"grants the common dir to a workspace in a linked worktree's subdirectory",
		async () => {
			const { commonDir, worktree } = linkedWorktree();
			const pkg = path.join(worktree, "pkg");
			fs.mkdirSync(pkg);
			expect((await runtime(pkg)).effectivePolicy().readwritePaths).toContain(commonDir);
		},
	);

	it("resolves no runtime for a scope while disabled, without creating one", async () => {
		const live = SandboxRuntime.liveCountForTest();
		expect(await SandboxRuntime.forScope(path.join(outside, "fresh"), "bash")).toBeUndefined();
		expect(SandboxRuntime.liveCountForTest()).toBe(live);
	});

	it("resolves the runtime only for an enabled scope", async () => {
		SandboxRuntime.resetForTest({ ...UNAVAILABLE, supported: true, backend: "seatbelt", proxy: true });
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxScope.set(settings, ["eval"]);
		const instance = await runtime();
		expect(await SandboxRuntime.forScope(workspace, "eval")).toBe(instance);
		expect(await SandboxRuntime.forScope(workspace, "bash")).toBeUndefined();
	});
});

describe("SandboxRuntime always grant with a project-layer allowlist", () => {
	it("appends only the granted host to the global list", async () => {
		const agentDir = path.join(path.dirname(workspace), "agent");
		await Bun.write(
			path.join(workspace, ".omp", "config.yml"),
			YAML.stringify({ sandbox: { network: { allowedHosts: ["exfil.test"] } } }),
		);
		settings = await Settings.init({ agentDir, cwd: workspace });
		const instance = await runtime();
		await instance.grantHost("granted.test", "always");
		const global = cfgSandboxAllowedHosts.get(settings.grantAuthority());
		expect(global).toContain("granted.test");
		expect(global).not.toContain("exfil.test");
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

	it("reads but cannot modify a parent-staged file in the system temp dir passed as extraRead", async () => {
		const staged = path.join(systemTmp, "runner.sh");
		fs.writeFileSync(staged, "echo staged\n");
		cfgSandboxReadScope.set(settings, "workspace");
		const instance = await runtime();
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
		const listeners = [outsideSocket, insideSocket].map(unix =>
			Bun.listen({
				unix,
				socket: {
					data() {},
					open(socket) {
						socket.end();
					},
				},
			}),
		);
		try {
			const connect = async (sock: string) => {
				const child = await instance.spawn({
					argv: [process.execPath, "-e", "await Bun.connect({ unix: process.env.SOCK, socket: { data() {} } })"],
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
		const info = await ensurePyToolBridge("unix", instance.tempDir());
		try {
			const socketPath = info.url.slice("unix:".length);
			expect(path.dirname(socketPath)).toBe(instance.tempDir());
			expect(Buffer.byteLength(socketPath)).toBeLessThan(100);
		} finally {
			await disposePyToolBridge();
		}
	});

	it("stops writing to the workspace once the mode switches to read-only", async () => {
		const instance = await runtime();
		const target = path.join(workspace, "file.txt");
		expect((await run(instance, `echo one > '${target}'`)).code).toBe(0);
		cfgSandboxMode.set(settings, "read-only");
		expect(instance.effectivePolicy().readwritePaths).not.toContain(workspace);
		expect((await run(instance, `echo two > '${target}'`)).code).not.toBe(0);
		expect(fs.readFileSync(target, "utf8")).toBe("one\n");
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

	it("reads outside the workspace scope only through extraRead", async () => {
		const file = path.join(outside, "data.txt");
		fs.writeFileSync(file, "data\n");
		cfgSandboxReadScope.set(settings, "workspace");
		const instance = await runtime();
		expect((await run(instance, `cat '${file}'`)).code).not.toBe(0);
		const granted = await run(instance, `cat '${file}'`, { extraRead: [outside] });
		expect(granted.code).toBe(0);
		expect(granted.stdout).toBe("data\n");
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
		const result = await run(instance, "cat", { stdin: "one " });
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("one ");
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
				const records: Record<string, string> = { "intranet.test": "10.0.0.5", "loopback.test": "127.0.0.1" };
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

				await instance.grantHost("intranet.test", "session");
				expect((await run(instance, curl("intranet.test"))).stdout).toBe("served 200");
				expect(instance.blockedHosts()).toEqual([]);

				// A session grant is not an exact entry: a name resolving to loopback stays refused.
				await instance.grantHost("loopback.test", "session");
				expect((await run(instance, `${curl("loopback.test")} -o /dev/null`)).stdout).toBe(" 403");
				expect(instance.blockedHosts()).toEqual(["loopback.test"]);
			} finally {
				await server.stop(true);
			}
		},
	);
});
