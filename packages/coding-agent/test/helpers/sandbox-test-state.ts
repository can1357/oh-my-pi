import { vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled, cfgSandboxNetworkMode } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./settings-test-state";

/** Backend probe of a host where seatbelt contains processes, with proxy confinement. */
export const SANDBOX_SUPPORTED = {
	supported: true,
	backend: "seatbelt" as const,
	proxy: true,
	warnings: [],
	networkMissing: [],
};
/** Backend probe of a host without a usable backend. */
export const SANDBOX_UNAVAILABLE = {
	supported: false,
	reason: "test: no backend",
	proxy: false,
	warnings: [],
	networkMissing: [],
};
/**
 * Whether a contained child can load omp from this source checkout. On Windows, Bun cannot open
 * directories under the processcontainer's read-only roots, so it cannot resolve the TypeScript
 * sources a contained shell host or evaluator re-enters (docs/sandbox.md, "Windows"); there only
 * the compiled binary runs contained, which `omp --smoke-test` covers. Lift once
 * oven-sh/bun#48581 or microsoft/mxc#1467 (including `FILE_READ_EA`) is fixed.
 */
export const CONTAINED_SOURCE_RUNS = process.platform !== "win32";

/** Whether this host has a sandbox backend a contained call can run under. */
export const SANDBOX_BACKEND_PRESENT =
	typeof natives.sandboxSupport === "function" &&
	typeof natives.SandboxProcess === "function" &&
	natives.sandboxSupport().supported;

/** Runs `git args` in `cwd`, isolated from the developer's global/system git config (signing, hooks, templates). */
export function git(cwd: string, ...args: string[]): void {
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "ignore", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** The process settings over `agentDir` and `workspace`, with optional global and project `sandbox:` sections. */
export async function initSandboxSettings(
	dirs: { agentDir: string; workspace: string },
	layers: { global?: object; project?: object } = {},
): Promise<Settings> {
	if (layers.global) {
		await Bun.write(path.join(dirs.agentDir, "config.yml"), YAML.stringify({ sandbox: layers.global }));
	}
	if (layers.project) {
		await Bun.write(path.join(dirs.workspace, ".omp", "config.yml"), YAML.stringify({ sandbox: layers.project }));
	}
	return Settings.init({ agentDir: dirs.agentDir, cwd: dirs.workspace });
}

/** One contained-tool test's sandbox: enabled, network denied, over a scratch tree of its own. */
export interface ContainedSandboxTest {
	state: SettingsTestState;
	scratch: TempDir;
	/** The in-memory process settings the runtime reads. */
	settings: Settings;
	/** `<scratch>/workspace`, realpath'd. */
	workspace: string;
	/** `<scratch>/outside`: neither the workspace nor the (spied) tmpdir, so read-only when contained. */
	outside: string;
	/** `<scratch>/artifacts`: the session's artifacts dir, whose `local` child is the `local://` root. */
	artifacts: string;
	sessionKey: string;
}

let sessionCounter = 0;

/** Sets up a {@link ContainedSandboxTest}; `name` prefixes its scratch dir and session key. */
export async function beginContainedSandboxTest(name: string): Promise<ContainedSandboxTest> {
	const state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp, so `outside` would be
	// invisible to contained processes rather than read-only.
	const scratch = TempDir.createSync(path.join(os.homedir(), `.omp-${name}-`));
	const root = fs.realpathSync(scratch.path());
	const workspace = path.join(root, "workspace");
	const outside = path.join(root, "outside");
	const artifacts = path.join(root, "artifacts");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, artifacts, tmp]) fs.mkdirSync(dir);
	// The sandbox always grants tmpdir; keep it away from the workspace and `outside`.
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	const settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxNetworkMode.set(settings, "deny");
	cfgSandboxEnabled.set(settings, true);
	SandboxRuntime.resetForTest();
	return { state, scratch, settings, workspace, outside, artifacts, sessionKey: `${name}-test-${++sessionCounter}` };
}

/** Retires `test`'s hosts and runtime, then restores what {@link beginContainedSandboxTest} changed. */
export async function endContainedSandboxTest(test: ContainedSandboxTest): Promise<void> {
	try {
		releaseShellSessions(test.sessionKey);
		await (await SandboxRuntime.for(test.workspace)).dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(test.state);
		AgentStorage.close();
		test.scratch.removeSync();
	}
}

/** A tool session in `test`'s workspace, with session id `sessionId`. */
export function containedToolSession(
	test: ContainedSandboxTest,
	sessionId: string | null = test.sessionKey,
): ToolSession {
	return {
		cwd: test.workspace,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getArtifactsDir: () => test.artifacts,
		settings: Settings.isolated({ "lsp.enabled": false }),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

/**
 * The rejection of `promise`, settled before any `expect`: `rejects` drains only microtasks, never
 * the host's reply I/O.
 */
export function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

/**
 * What the model would see of `call`: its text, or the failure's message. A refusal's errno varies
 * by backend (EACCES/EPERM, or ENOENT where the denied path is hidden from the container); the
 * contract is that the denied content never comes back.
 */
export function outcome(call: Promise<{ content: { type: string; text?: string }[] }>): Promise<string> {
	return call.then(
		result => result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n"),
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}
