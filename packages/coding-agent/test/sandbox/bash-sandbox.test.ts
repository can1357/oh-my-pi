// oxlint-disable no-template-curly-in-string -- literal shell `${…}` expansions
/**
 * Agent bash with the OS sandbox enabled, end to end: `executeBash`, the bash tool and the PTY run
 * the embedded shell in a contained sandbox host. The contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import * as direnv from "@oh-my-pi/pi-coding-agent/exec/direnv";
import {
	type BashExecutorOptions,
	executeBash,
	releaseShellSessions,
} from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { SandboxRuntime, SandboxUnavailableError } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowWrite,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import {
	SandboxedPtySession,
	sandboxHostPids,
	sandboxHostPoolSize,
} from "@oh-my-pi/pi-coding-agent/sandbox/shell-client";
import { buildSandboxPrompt, cfgSystemPromptInputs } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { runInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-interactive";
import * as natives from "@oh-my-pi/pi-natives";
import { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";
import { CONTAINED_SOURCE_RUNS } from "../helpers/sandbox-test-state";

const UNAVAILABLE = { supported: false, reason: "test: no backend", proxy: false, warnings: [] };

const supported =
	typeof natives.sandboxSupport === "function" &&
	typeof natives.SandboxProcess === "function" &&
	natives.sandboxSupport().supported;
/** The allowlist needs the loopback proxy; without it the runtime degrades the mode to `deny`. */
const proxySupported = supported && natives.sandboxSupport().proxy;

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/outside`: outside the workspace and the (spied) tmpdir. */
let outside: string;
let sessionKey: string;
let sessionCounter = 0;

/** One agent bash call; `keepShellCwd` runs in the persistent shell's own working directory. */
function bash(command: string, extra: Partial<BashExecutorOptions> & { keepShellCwd?: boolean } = {}) {
	const { keepShellCwd, ...options } = extra;
	return executeBash(command, {
		cwd: keepShellCwd ? undefined : workspace,
		sessionKey,
		sandboxWorkspace: workspace,
		...options,
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function toolSession(overrides: Partial<ToolSession> = {}, toolSettings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => sessionKey,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			...toolSettings,
		}),
		getClientBridge: () => undefined,
		...overrides,
	} as unknown as ToolSession;
}

function toolText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

/** A UI whose `custom()` mounts the overlay against a headless TUI and resolves with its result. */
function headlessUi(): Pick<NonNullable<AgentToolContext["ui"]>, "custom"> {
	return {
		custom: async <T>(
			factory: (tui: TUI, uiTheme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => unknown,
		): Promise<T> => {
			const { promise, resolve } = Promise.withResolvers<T>();
			await factory(new TUI(new VirtualTerminal(100, 30)), theme, KeybindingsManager.inMemory(), resolve);
			return promise;
		},
	};
}

beforeEach(async () => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	scratch = TempDir.createSync("@omp-bash-sandbox-");
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, tmp]) fs.mkdirSync(dir);
	// The sandbox always grants tmpdir; keep it away from the workspace and `outside`.
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	// `deny` keeps the egress proxy out of these filesystem-focused cases.
	cfgSandboxNetworkMode.set(settings, "deny");
	sessionKey = `bash-sandbox-test-${++sessionCounter}`;
	SandboxRuntime.resetForTest();
});

afterEach(async () => {
	try {
		releaseShellSessions(sessionKey);
		await (await SandboxRuntime.for(workspace)).dispose();
		SandboxRuntime.resetForTest();
		SandboxRuntime.setWarningSink(undefined);
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		// Persisted settings opened <agentDir>/agent.db; Windows cannot delete an open file.
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe("agent bash when the sandbox does not contain it", () => {
	it("leaves the bash tool's streaming updates unmarked", async () => {
		const updates: { details?: { sandbox?: unknown } }[] = [];
		await new BashTool(toolSession()).execute("call-plain", { command: "echo plain" }, undefined, update =>
			updates.push(update),
		);
		for (const update of updates) expect(update.details?.sandbox).toBeUndefined();
	});

	it("starts no sandbox host and carries no sandbox meta", async () => {
		const result = await bash("echo plain");
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("plain\n");
		expect(result.sandbox).toBeUndefined();
		expect(sandboxHostPoolSize(sessionKey)).toBe(0);
	});

	it("fails the call when the sandbox is required but unavailable", async () => {
		SandboxRuntime.resetForTest(UNAVAILABLE);
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxFallback.set(settings, "block");
		await expect(bash("echo never")).rejects.toBeInstanceOf(SandboxUnavailableError);
		// The bash tool surfaces the same error as the call's failure.
		await expect(new BashTool(toolSession()).execute("call-block", { command: "echo never" })).rejects.toBeInstanceOf(
			SandboxUnavailableError,
		);
		expect(sandboxHostPoolSize(sessionKey)).toBe(0);
	});

	it("runs unsandboxed when unavailable with the warn fallback", async () => {
		SandboxRuntime.resetForTest(UNAVAILABLE);
		SandboxRuntime.setWarningSink(() => {});
		cfgSandboxEnabled.set(settings, true);
		const result = await bash("echo uncontained");
		expect(result.output).toBe("uncontained\n");
		expect(result.sandbox).toBeUndefined();
		expect(sandboxHostPoolSize(sessionKey)).toBe(0);
	});

	it("leaves the system prompt without a sandbox block while off or unavailable", async () => {
		expect(await buildSandboxPrompt(settings, workspace)).toBeUndefined();
		SandboxRuntime.resetForTest(UNAVAILABLE);
		SandboxRuntime.setWarningSink(() => {});
		cfgSandboxEnabled.set(settings, true);
		expect(await buildSandboxPrompt(settings, workspace)).toBeUndefined();
	});
});

describe.skipIf(!supported || !CONTAINED_SOURCE_RUNS)("agent bash in the sandbox", () => {
	beforeEach(() => {
		cfgSandboxEnabled.set(settings, true);
	});

	it("writes inside the workspace and reports sandbox meta", async () => {
		const result = await bash("echo inside > inside.txt && cat inside.txt");
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("inside\n");
		expect(fs.readFileSync(path.join(workspace, "inside.txt"), "utf8")).toBe("inside\n");
		expect(result.sandbox).toEqual({
			backend: natives.sandboxSupport().backend ?? "unknown",
			mode: "workspace-write",
			network: "deny",
		});
		expect(sandboxHostPoolSize(sessionKey)).toBe(1);
	});

	for (const [kind, write] of [
		["a redirect", (target: string) => `echo x > ${target}`],
		["a builtin", (target: string) => `touch ${target}`],
		["an external command", (target: string) => `/usr/bin/touch ${target}`],
	] as const) {
		it(`refuses a write outside the workspace through ${kind}`, async () => {
			const target = path.join(outside, "escaped.txt");
			const result = await bash(write(target));
			expect(result.exitCode).not.toBe(0);
			expect(fs.existsSync(target)).toBe(false);
			expect(result.sandbox?.denied).toBe(true);
		});
	}

	it("keeps cd and export state across calls; async jobs share the session's host", async () => {
		fs.mkdirSync(path.join(workspace, "sub"));
		expect((await bash("cd sub && export OMP_SANDBOX_STATE=kept")).exitCode).toBe(0);
		const result = await bash('pwd; echo "$OMP_SANDBOX_STATE"; echo "$OMP_SANDBOX"', { keepShellCwd: true });
		expect(result.output).toBe(`${path.join(workspace, "sub")}\nkept\n1\n`);
		const job = await bash('echo "$OMP_SANDBOX"', { sessionKey: `${sessionKey}:async:job-1` });
		expect(job.output).toBe("1\n");
		expect(sandboxHostPoolSize(sessionKey)).toBe(1);
	});

	it("loads no direnv environment for a contained command", async () => {
		// An allowed `.envrc` would be evaluated by the trusted parent; the contained agent can write it.
		fs.writeFileSync(path.join(workspace, ".envrc"), "export OMP_DIRENV_PROBE=loaded\n");
		const loadDirenv = vi.spyOn(direnv, "loadDirenvEnv");
		const result = await bash('echo "probe:${OMP_DIRENV_PROBE:-unset}"');
		expect(result.output).toBe("probe:unset\n");
		expect(loadDirenv).not.toHaveBeenCalled();
	});

	it("contains an eval cell's shell under the eval scope only", async () => {
		cfgSandboxScope.set(settings, ["eval"]);
		expect((await bash('echo "${OMP_SANDBOX:-none}"', { sandboxScope: "eval" })).output).toBe("1\n");
		expect((await bash('echo "${OMP_SANDBOX:-none}"', { sessionKey: `${sessionKey}-bash` })).output).toBe("none\n");
	});

	it("relays an interactive PTY from a contained host", async () => {
		const runtime = await SandboxRuntime.for(workspace);
		const session = new SandboxedPtySession(runtime, { cwd: workspace });
		let output = "";
		const result = await session.start(
			{ command: "if [ -t 1 ]; then echo tty; else echo notty; fi; exit 4", cwd: workspace, cols: 80, rows: 24 },
			(error, chunk) => {
				if (!error) output += chunk;
			},
		);
		expect(result.exitCode).toBe(4);
		expect(output).toContain("tty");
		expect(output).not.toContain("notty");
	});

	it("routes the agent's interactive PTY through the sandbox", async () => {
		initTheme();
		const result = await runInteractiveBashPty(headlessUi(), {
			command:
				'echo "pty:${OMP_SANDBOX:-none}"; echo "tmp:$TMPDIR"; f=$(mktemp) && echo ok > "$f" && echo "wrote:$(cat "$f")"',
			cwd: workspace,
			sandboxWorkspace: workspace,
		});
		expect(result.output).toContain("pty:1");
		expect(result.output).toContain(`tmp:${(await SandboxRuntime.for(workspace)).tempDir()}`);
		expect(result.output).toContain("wrote:ok");
		expect(result.sandbox?.mode).toBe("workspace-write");
	});

	it("gives contained commands the runtime's private temp dir", async () => {
		const tempDir = (await SandboxRuntime.for(workspace)).tempDir();
		expect((await bash('echo "$TMPDIR|$TMP|$TEMP"')).output).toBe(`${tempDir}|${tempDir}|${tempDir}\n`);
		const written = await bash('f=$(mktemp) && echo ok > "$f" && cat "$f"');
		expect(written.exitCode).toBe(0);
		expect(written.output).toBe("ok\n");
	});

	it("applies policy changes from the next call, returning to an earlier policy included", async () => {
		cfgSandboxAllowWrite.set(settings, [outside]);
		expect((await bash(`echo one > ${path.join(outside, "one.txt")}`)).exitCode).toBe(0);
		cfgSandboxAllowWrite.set(settings, []);
		const result = await bash(`echo two > ${path.join(outside, "two.txt")}`);
		expect(result.exitCode).not.toBe(0);
		expect(fs.existsSync(path.join(outside, "two.txt"))).toBe(false);
		cfgSandboxMode.set(settings, "read-only");
		expect((await bash("true")).sandbox?.mode).toBe("read-only");
		// Back to the first policy: its retired host's cached shell must not be reused.
		cfgSandboxMode.set(settings, "workspace-write");
		cfgSandboxAllowWrite.set(settings, [outside]);
		expect((await bash(`echo three > ${path.join(outside, "three.txt")}`)).exitCode).toBe(0);
		expect(sandboxHostPoolSize(sessionKey)).toBe(1);
	});

	it("ends the session's hosts when its shells are released", async () => {
		await bash("echo up");
		const pids = await sandboxHostPids(sessionKey);
		expect(pids).toHaveLength(1);
		releaseShellSessions(sessionKey);
		expect(sandboxHostPoolSize(sessionKey)).toBe(0);
		// The retired host exits on its own once idle.
		for (let i = 0; i < 80 && isAlive(pids[0]); i++) await Bun.sleep(25);
		expect(isAlive(pids[0])).toBe(false);
	});

	it("retires the session's host when the sandbox is switched off", async () => {
		await bash("echo up");
		cfgSandboxEnabled.set(settings, false);
		expect((await bash('echo "${OMP_SANDBOX:-none}"')).output).toBe("none\n");
		expect(sandboxHostPoolSize(sessionKey)).toBe(0);
	});

	it("gives the bash tool's result the sandbox meta and the denial notice", async () => {
		const tool = new BashTool(toolSession());
		const denied = await tool.execute("call-denied", { command: `echo x > ${path.join(outside, "escaped.txt")}` });
		expect(denied.isError).toBe(true);
		expect(denied.details?.sandbox?.denied).toBe(true);
		expect(toolText(denied)).toContain("[OS sandbox:");
		// Denial-looking output from a command that succeeded is not a denial.
		const clean = await tool.execute("call-clean", { command: "echo 'Permission denied'" });
		expect(clean.details?.sandbox).toBeDefined();
		expect(clean.details?.sandbox?.denied).toBeUndefined();
		expect(toolText(clean)).not.toContain("[OS sandbox:");
	});

	it("marks the bash tool's streaming updates with the sandbox before the call settles", async () => {
		const updates: { details?: { sandbox?: unknown } }[] = [];
		const result = await new BashTool(toolSession()).execute(
			"call-live",
			{ command: "echo one; sleep 0.2; echo two" },
			undefined,
			update => updates.push(update),
		);
		const meta = {
			backend: natives.sandboxSupport().backend ?? "unknown",
			mode: "workspace-write",
			network: "deny",
		} as const;
		expect(updates.length).toBeGreaterThan(0);
		expect(updates[0].details?.sandbox).toEqual(meta);
		for (const update of updates) expect(update.details?.sandbox).toEqual(meta);
		expect(result.details?.sandbox).toEqual(meta);
	});

	it("marks a contained async job's start result and its frames with the sandbox", async () => {
		const manager = new AsyncJobManager({});
		try {
			const updates: { details?: { sandbox?: unknown } }[] = [];
			const tool = new BashTool(toolSession({ asyncJobManager: manager }, { "async.enabled": true }));
			const started = await tool.execute(
				"call-async",
				{ command: "echo one; sleep 0.2; echo two", async: true },
				undefined,
				update => updates.push(update),
			);
			const meta = {
				backend: natives.sandboxSupport().backend ?? "unknown",
				mode: "workspace-write",
				network: "deny",
			} as const;
			expect(started.details?.async?.state).toBe("running");
			expect(started.details?.sandbox).toEqual(meta);
			await manager.waitForAll();
			expect(updates.length).toBeGreaterThan(0);
			for (const update of updates) expect(update.details?.sandbox).toEqual(meta);
		} finally {
			await manager.dispose();
		}
	});

	it.skipIf(!proxySupported)("names a refused host to the model only when the command failed", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		const tool = new BashTool(toolSession());
		const url = "https://blocked.omp-sandbox-test.invalid/";
		const failed = await tool.execute("call-blocked", { command: `curl -sS --max-time 10 ${url}` });
		expect(failed.details?.sandbox?.blockedHosts).toContain("blocked.omp-sandbox-test.invalid");
		expect(toolText(failed)).toContain("[OS sandbox:");
		const succeeded = await tool.execute("call-blocked-ok", { command: `curl -sS --max-time 10 ${url} || true` });
		expect(succeeded.details?.sandbox?.blockedHosts).toContain("blocked.omp-sandbox-test.invalid");
		expect(toolText(succeeded)).not.toContain("[OS sandbox:");
	});

	it.skipIf(!proxySupported)("passes the parent's proxy variables through except under the allowlist", async () => {
		const config = settings.getShellConfig();
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			...config,
			env: { ...config.env, HTTPS_PROXY: "http://parent-proxy.invalid:3128" },
		});
		cfgSandboxNetworkMode.set(settings, "allow");
		expect((await bash('echo "$HTTPS_PROXY"')).output).toBe("http://parent-proxy.invalid:3128\n");
		cfgSandboxNetworkMode.set(settings, "allowlist");
		const contained = (await bash('echo "$HTTPS_PROXY"')).output;
		expect(contained).not.toContain("parent-proxy.invalid");
		expect(contained).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+/);
	});

	it("releases the session's eval `sh()` shells and hosts with the session", async () => {
		const evalKey = `eval:${sessionKey}`;
		expect((await bash('echo "$OMP_SANDBOX"', { sessionKey: evalKey, sandboxScope: "eval" })).output).toBe("1\n");
		expect(sandboxHostPoolSize(evalKey)).toBe(1);
		releaseShellSessions(sessionKey);
		expect(sandboxHostPoolSize(evalKey)).toBe(0);
	});

	it("keeps `local://` writable while the rest of the agent directory stays protected", async () => {
		const artifacts = path.join(outside, "agent", "session-artifacts");
		fs.mkdirSync(artifacts, { recursive: true });
		const tool = new BashTool(toolSession({ getArtifactsDir: () => artifacts } as Partial<ToolSession>));
		const wrote = await tool.execute("call-local", { command: "echo data > local://note.md && cat local://note.md" });
		expect(toolText(wrote)).toContain("data");
		const sibling = path.join(outside, "agent", "other.txt");
		await tool.execute("call-agent-dir", { command: `echo x > ${sibling}` });
		expect(fs.existsSync(sibling)).toBe(false);
	});

	it("refuses services and skips the client terminal under the sandbox", async () => {
		const createTerminal = vi.fn();
		const tool = new BashTool(
			toolSession(
				{
					getClientBridge: () => ({ capabilities: { terminal: true }, createTerminal }),
				} as unknown as Partial<ToolSession>,
				{ "launch.enabled": true },
			),
		);
		await expect(tool.execute("call-service", { command: "sleep 1", name: "svc" })).rejects.toThrow(
			/Services cannot run inside the OS sandbox/,
		);
		const result = await tool.execute("call-bridge", { command: 'echo "${OMP_SANDBOX:-none}"' });
		expect(toolText(result)).toContain("1");
		expect(createTerminal).not.toHaveBeenCalled();
	});

	it("adds the sandbox block to the system prompt while active and rebuilds on a change", async () => {
		const active = await buildSandboxPrompt(settings, workspace);
		expect(active).toContain(workspace);
		expect(active).toContain("`bash` commands");
		const rebuilt = Promise.withResolvers<void>();
		const stop = cfgSystemPromptInputs.listen(settings, () => rebuilt.resolve());
		cfgSandboxMode.set(settings, "read-only");
		await rebuilt.promise;
		stop();
		// Read-only: the workspace is no longer among the writable roots.
		expect(await buildSandboxPrompt(settings, workspace)).not.toContain(workspace);
	});
});

describe.skipIf(!supported || process.platform === "win32")("host-side rc snapshot under the sandbox", () => {
	/** A shell named `name` that records each invocation in `marker` (outside the workspace), then is bash. */
	function recordingShell(dir: string, marker: string, name = "bash"): string {
		const shellPath = path.join(dir, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(shellPath, `#!/bin/sh\necho ran >> '${marker}'\nexec /bin/bash "$@"\n`);
		fs.chmodSync(shellPath, 0o755);
		return shellPath;
	}

	async function initWith(project: Record<string, unknown>, global: Record<string, unknown>): Promise<void> {
		const agentDir = path.join(path.dirname(workspace), "agent");
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(global));
		await Bun.write(path.join(workspace, ".omp", "config.yml"), YAML.stringify(project));
		// The suite already initialised in-memory settings; load these layers from disk instead.
		resetSettingsForTest();
		settings = await Settings.init({ agentDir, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "deny");
	}

	it("never runs a project-chosen shell in the parent", async () => {
		const marker = path.join(outside, "project-shell-ran");
		await initWith({ shellPath: recordingShell(path.join(workspace, "x"), marker) }, {});
		const result = await bash("echo contained");
		expect(result.output).toBe("contained\n");
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("still snapshots with an operator-chosen shell", async () => {
		const marker = path.join(outside, "operator-shell-ran");
		await initWith({}, { shellPath: recordingShell(path.join(outside, "operator-bin"), marker) });
		expect((await bash("echo contained")).output).toBe("contained\n");
		expect(fs.existsSync(marker)).toBe(true);
	});

	// Calls that run on the host while the sandbox is on: the user's `!` commands (snapshot path for a
	// bash-named shell, the user-shell command line otherwise) and an agent call outside any workspace.
	it.each([
		["a host call outside the sandbox", "bash", { sandboxWorkspace: undefined }],
		["a user `!` command (bash snapshot)", "bash", { useUserShell: true }],
		["a user `!` command (user-shell command line)", "mysh", { useUserShell: true }],
	] as const)("never runs a project-chosen shell for %s", async (_name, shellName, extra) => {
		const marker = path.join(outside, `planted-${shellName}-ran`);
		await initWith(
			{ shellPath: recordingShell(path.join(workspace, "planted"), marker, shellName) },
			// The operator's own shell, so the user-shell path does not pick up `$SHELL`.
			{ shellPath: "/bin/bash" },
		);
		const result = await bash("echo host", extra);
		expect(result.output).toBe("host\n");
		expect(fs.existsSync(marker)).toBe(false);
	});
});
