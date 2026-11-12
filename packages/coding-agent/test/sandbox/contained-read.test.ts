/**
 * The `read` tool under the OS sandbox: file contents come through the verified handle of the
 * contained host and directory listings are walked there, so the container refuses a read that
 * omp's path check never saw (a symlink, or a call that skipped the check). The contained cases
 * skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { sandboxHostPoolSize } from "@oh-my-pi/pi-coding-agent/sandbox/shell-client";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CONTAINED_SOURCE_RUNS } from "../helpers/sandbox-test-state";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const supported =
	typeof natives.sandboxSupport === "function" &&
	typeof natives.SandboxProcess === "function" &&
	natives.sandboxSupport().supported;

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/outside`: readable by the broad read scope unless denied. */
let outside: string;
let sessionKey: string;
let sessionCounter = 0;

function toolSession(): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => sessionKey,
		getArtifactsDir: () => path.join(path.dirname(workspace), "artifacts"),
		settings: Settings.isolated({ "lsp.enabled": false }),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

/**
 * What a call surfaced: its result text, or its error message. A refusal's errno varies by backend
 * (EACCES/EPERM, or ENOENT where the denied path is hidden from the container); the contract is
 * that the denied content never comes back.
 */
async function outcome(promise: Promise<{ content: Array<{ type: string; text?: string }> }>): Promise<string> {
	return promise.then(textOf, (error: unknown) => (error instanceof Error ? error.message : String(error)));
}

beforeEach(async () => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-contained-read-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, tmp, path.join(root, "artifacts")]) fs.mkdirSync(dir);
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxNetworkMode.set(settings, "deny");
	cfgSandboxEnabled.set(settings, true);
	sessionKey = `contained-read-test-${++sessionCounter}`;
	SandboxRuntime.resetForTest();
});

afterEach(async () => {
	try {
		releaseShellSessions(sessionKey);
		await (await SandboxRuntime.for(workspace)).dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe.skipIf(!supported || !CONTAINED_SOURCE_RUNS)("the read tool in the sandbox", () => {
	it("reads a workspace file through the session's contained host", async () => {
		fs.writeFileSync(path.join(workspace, "inside.txt"), "kept\nlines\n");
		const result = await new ReadTool(toolSession()).execute("call-inside", { path: "inside.txt:raw" });
		expect(textOf(result)).toContain("kept");
		expect(sandboxHostPoolSize(`files:${sessionKey}`)).toBe(1);
	});

	it("refuses a read through a workspace symlink to a denied file", async () => {
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(secret, "top secret\n");
		fs.symlinkSync(secret, path.join(workspace, "link.txt"));
		cfgSandboxDenyRead.set(settings, [outside]);
		// Called on the tool directly, so omp's path check never runs: the container must refuse it.
		const tool = new ReadTool(toolSession());
		for (const target of ["link.txt", "link.txt:raw", "link.txt:1-1"]) {
			expect(await outcome(tool.execute("call-escape", { path: target }))).not.toContain("top secret");
		}
		fs.writeFileSync(path.join(workspace, "inside.txt"), "kept\n");
		expect(textOf(await tool.execute("call-inside", { path: "inside.txt" }))).toContain("kept");
	});

	it("queries a workspace JSON file and refuses a symlink to a denied one", async () => {
		const secret = path.join(outside, "secret.json");
		fs.writeFileSync(secret, '{"a": "top secret"}\n');
		fs.writeFileSync(path.join(workspace, "data.json"), '{"a": "kept"}\n');
		fs.symlinkSync(secret, path.join(workspace, "link.json"));
		cfgSandboxDenyRead.set(settings, [outside]);
		const tool = new ReadTool(toolSession());
		expect(textOf(await tool.execute("call-json", { path: "data.json?q=.a" }))).toContain("kept");
		expect(await outcome(tool.execute("call-json-escape", { path: "link.json?q=.a" }))).not.toContain("top secret");
	});

	it("lists a directory without revealing the entries of a denied one", async () => {
		const vault = path.join(workspace, "vault");
		fs.mkdirSync(vault);
		fs.writeFileSync(path.join(vault, "key.txt"), "key\n");
		fs.writeFileSync(path.join(workspace, "visible.txt"), "visible\n");
		cfgSandboxDenyRead.set(settings, [vault]);
		const tool = new ReadTool(toolSession());
		const listing = textOf(await tool.execute("call-list", { path: "." }));
		expect(listing).toContain("visible.txt");
		expect(listing).not.toContain("key.txt");
		expect(await outcome(tool.execute("call-list-denied", { path: "vault" }))).not.toContain("key.txt");
	});
});
