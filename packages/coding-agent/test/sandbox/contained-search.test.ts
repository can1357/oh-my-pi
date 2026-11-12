/**
 * Search tools under the OS sandbox: grep, glob and the ast_edit preview walk and read inside the
 * contained host, so the container refuses a file omp's path check never saw (a symlink inside the
 * workspace, or a call that skipped the check). The contained cases skip where no backend exists.
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
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
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
/** `<scratch>/outside`: not the workspace, and denied for reads in these tests. */
let outside: string;
/** `<scratch>/artifacts`: the session's artifacts dir. */
let artifacts: string;
let sessionKey: string;
let sessionCounter = 0;

function toolSession(): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => sessionKey,
		getArtifactsDir: () => artifacts,
		settings: Settings.isolated({ "lsp.enabled": false }),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

/**
 * What the model would see of `call`: its text, or the failure's message. A refused file may fail
 * the call or just yield nothing; either way its content must not appear.
 */
async function outcome(call: Promise<{ content: { type: string; text?: string }[] }>): Promise<string> {
	try {
		const result = await call;
		return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

beforeEach(async () => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp, so `outside` would be
	// invisible to contained processes rather than denied.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-contained-search-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	artifacts = path.join(root, "artifacts");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, artifacts, tmp]) fs.mkdirSync(dir);
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxNetworkMode.set(settings, "deny");
	cfgSandboxEnabled.set(settings, true);
	cfgSandboxDenyRead.set(settings, [outside]);
	sessionKey = `contained-search-test-${++sessionCounter}`;
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

describe.skipIf(!supported || !CONTAINED_SOURCE_RUNS)("contained search tools", () => {
	it("greps workspace files and never returns the matches of a symlinked denied file", async () => {
		fs.writeFileSync(path.join(workspace, "plain.txt"), "PUBLIC_VALUE_7\n");
		fs.writeFileSync(path.join(outside, "secret.txt"), "TOPSECRET_VALUE_42\n");
		fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "innocent.txt"));
		const tool = new GrepTool(toolSession());
		const pattern = "(TOPSECRET|PUBLIC)_\\w+";

		const walk = await outcome(tool.execute("call-walk", { pattern, path: "." }));
		expect(walk).toContain("PUBLIC_VALUE_7");
		expect(walk).not.toContain("VALUE_42");

		// Named directly, the link is resolved by the search itself: only the container can refuse it.
		const direct = await outcome(tool.execute("call-direct", { pattern, path: "innocent.txt" }));
		expect(direct).not.toContain("VALUE_42");
	});

	it("lists workspace files with glob", async () => {
		fs.writeFileSync(path.join(workspace, "one.txt"), "1\n");
		fs.mkdirSync(path.join(workspace, "sub"));
		fs.writeFileSync(path.join(workspace, "sub", "two.txt"), "2\n");
		const listing = await outcome(new GlobTool(toolSession()).execute("call-glob", { path: "**/*.txt" }));
		expect(listing).toContain("one.txt");
		expect(listing).toContain("two.txt");
	});

	it("previews an AST rewrite in the workspace and shows none for a symlinked denied file", async () => {
		const source = "const value = oldName();\n";
		fs.writeFileSync(path.join(workspace, "inside.ts"), source);
		fs.writeFileSync(path.join(outside, "beyond.ts"), source);
		fs.symlinkSync(path.join(outside, "beyond.ts"), path.join(workspace, "linked.ts"));
		const tool = new AstEditTool(toolSession());
		const ops = [{ pat: "oldName()", out: "newName()" }];

		const inside = await outcome(tool.execute("call-inside", { ops, paths: ["inside.ts"] }));
		expect(inside).toContain("newName");

		const linked = await outcome(tool.execute("call-linked", { ops, paths: ["linked.ts"] }));
		expect(linked).not.toContain("newName");
		// A preview writes nothing.
		expect(fs.readFileSync(path.join(outside, "beyond.ts"), "utf8")).toBe(source);
		expect(fs.readFileSync(path.join(workspace, "inside.ts"), "utf8")).toBe(source);
	});
});
