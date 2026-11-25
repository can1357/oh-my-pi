import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { EgressProxyOptions } from "@oh-my-pi/pi-coding-agent/sandbox/egress-proxy";
import { EVAL_EGRESS_SCOPE, SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled, cfgSandboxNetworkMode } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { captureEgressProxyHooks, SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/** The notice's opening marker; its presence is the branch contract, its prose is not tested. */
const NOTICE = "[OS sandbox:";

let temp: TempDir;
let settingsState: SettingsTestState;

function makeSession(): ToolSession {
	return {
		cwd: temp.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "eval.autoProvision": false }),
	};
}

/**
 * Runs one eval call whose backend prints `output` and ends as `end` says, running `during` while
 * the cell executes. The backend is stubbed: a real contained JS worker cannot load this source
 * checkout on Windows, and the notice depends only on what the backend and the proxy report.
 */
async function runCell(output: string, end: { exitCode?: number; cancelled: boolean }, during?: () => void) {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(async (_code, options) => {
		during?.();
		options.onChunk(output);
		return {
			output,
			exitCode: end.exitCode,
			cancelled: end.cancelled,
			truncated: false,
			artifactId: undefined,
			totalLines: 1,
			totalBytes: output.length,
			outputLines: 1,
			outputBytes: output.length,
			displayOutputs: [],
		};
	});
	const result = await new EvalTool(makeSession()).execute("call", { language: "js", code: "1", timeout: 60 });
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
	return { result, text, own: result.details?.sandbox?.ownBlockedHosts };
}

describe("eval sandbox denial notice", () => {
	beforeEach(async () => {
		settingsState = beginSettingsTest();
		temp = TempDir.createSync("@eval-sandbox-notice-");
		setAgentDir(path.join(temp.path(), "agent"));
		const settings = await Settings.init({ inMemory: true, cwd: temp.path() });
		cfgSandboxEnabled.set(settings, true);
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await (await SandboxRuntime.for(temp.path())).dispose();
		SandboxRuntime.resetForTest();
		restoreSettingsTestState(settingsState);
		AgentStorage.close();
		temp.removeSync();
	});

	it("puts the notice between a failed cell's denial output and its exit line", async () => {
		const { result, text } = await runCell("EACCES: Permission denied", { exitCode: 1, cancelled: false });
		expect(result.isError).toBe(true);
		expect(result.details?.sandbox?.denied).toBe(true);
		const at = text.indexOf(NOTICE);
		expect(at).toBeGreaterThan(text.indexOf("EACCES: Permission denied"));
		expect(at).toBeLessThan(text.indexOf("Command exited with code 1"));
	});

	it("adds no notice to a failed cell without denial text", async () => {
		const { result, text } = await runCell("boom", { exitCode: 1, cancelled: false });
		expect(result.isError).toBe(true);
		expect(result.details?.sandbox?.denied).toBeUndefined();
		expect(text).not.toContain(NOTICE);
	});

	it("adds no notice to a cancelled cell, even with denial text in its output", async () => {
		const { result, text } = await runCell("EACCES: Permission denied", { exitCode: undefined, cancelled: true });
		expect(result.isError).toBe(true);
		expect(result.details?.sandbox?.denied).toBeUndefined();
		expect(text).not.toContain(NOTICE);
	});

	describe("hosts the egress proxy refused", () => {
		let hooks: EgressProxyOptions;

		beforeEach(async () => {
			cfgSandboxNetworkMode.set(await Settings.init(), "allowlist");
			hooks = await captureEgressProxyHooks(temp.path());
		});

		it("names a host refused to the call's own kernels even when the cell succeeds", async () => {
			const { result, text, own } = await runCell("fetched", { exitCode: 0, cancelled: false }, () =>
				hooks.onBlocked?.("kernel.test", 443, { listener: EVAL_EGRESS_SCOPE }),
			);
			expect(result.isError).toBeFalsy();
			expect(own).toEqual(["kernel.test"]);
			expect(text.indexOf(NOTICE)).toBeGreaterThan(text.indexOf("fetched"));
			expect(text).toContain("kernel.test");
		});

		it("names a refusal without a known origin only when the cell failed", async () => {
			const refuse = () => hooks.onBlocked?.("anonymous.test", 443, {});
			const succeeded = await runCell("fetched", { exitCode: 0, cancelled: false }, refuse);
			expect(succeeded.result.details?.sandbox?.blockedHosts).toEqual(["anonymous.test"]);
			expect(succeeded.own).toBeUndefined();
			expect(succeeded.text).not.toContain(NOTICE);
			const failed = await runCell("boom", { exitCode: 1, cancelled: false }, refuse);
			expect(failed.text).toContain(NOTICE);
			expect(failed.text).toContain("anonymous.test");
		});

		it("leaves out a refusal attributed to another call, even from a failed cell", async () => {
			// Without a call watching that port the refusal is unattributed: the failed cell names it.
			const unwatched = await runCell("boom", { exitCode: 1, cancelled: false }, () =>
				hooks.onBlocked?.("elsewhere.test", 443, { listener: "pty:other" }),
			);
			expect(unwatched.text).toContain("elsewhere.test");
			expect(unwatched.own).toBeUndefined();
			const other = (await SandboxRuntime.for(temp.path())).beginEgressCall(["pty:other"]);
			try {
				const watched = await runCell("boom", { exitCode: 1, cancelled: false }, () =>
					hooks.onBlocked?.("theirs.test", 443, { listener: "pty:other" }),
				);
				expect(watched.result.details?.sandbox?.blockedHosts ?? []).not.toContain("theirs.test");
				expect(watched.text).not.toContain("theirs.test");
			} finally {
				other?.end();
			}
		});
	});
});
