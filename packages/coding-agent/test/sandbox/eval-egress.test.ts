/**
 * Eval cells in the sandbox's `allowlist` mode, end to end: the contained JS evaluator, the Python
 * kernel and the cell's `sh()` shell have their own egress proxy port, so a refusal they caused is
 * named on the eval call's result even when the cell succeeds.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { checkPythonKernelAvailability } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled, cfgSandboxNetworkMode } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as natives from "@oh-my-pi/pi-natives";
import { MIN_BUN_VERSION, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { CONTAINED_SOURCE_RUNS } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const proxySupported =
	typeof natives.sandboxSupport === "function" && natives.sandboxSupport().supported && natives.sandboxSupport().proxy;
/** The CLI (and so the production JS selector and the bash sandbox host) refuses an older Bun. */
const cliRuns = Bun.semver.order(Bun.version, MIN_BUN_VERSION) >= 0;
const pythonAvailable = (await checkPythonKernelAvailability(os.tmpdir(), undefined, { forceProbe: true })).ok;

const NOTICE = "[OS sandbox:";

let temp: TempDir;
let settingsState: SettingsTestState;
let workspace: string;

function session(): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "eval.autoProvision": false }),
	} as unknown as ToolSession;
}

async function runCell(language: "js" | "py", code: string) {
	const result = await new EvalTool(session()).execute("call", { language, code, timeout: 60 });
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
	return { result, text, own: result.details?.sandbox?.ownBlockedHosts };
}

describe.skipIf(!proxySupported || !cliRuns || !CONTAINED_SOURCE_RUNS)("eval egress refusals", () => {
	beforeEach(async () => {
		settingsState = beginSettingsTest();
		// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp.
		temp = TempDir.createSync(path.join(os.homedir(), ".omp-eval-egress-"));
		workspace = fs.realpathSync(temp.path());
		setAgentDir(path.join(workspace, "agent"));
		const settings = await Settings.init({ inMemory: true, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "allowlist");
		SandboxRuntime.resetForTest();
	});

	afterEach(async () => {
		try {
			await disposeAllVmContexts();
			await disposeAllKernelSessions();
			releaseShellSessions("eval:");
			await (await SandboxRuntime.for(workspace)).dispose();
			SandboxRuntime.resetForTest();
		} finally {
			restoreSettingsTestState(settingsState);
			AgentStorage.close();
			temp.removeSync();
		}
	});

	it("names a host the evaluator's own fetch was refused, though the cell succeeded", async () => {
		const { result, text, own } = await runCell(
			"js",
			'const response = await fetch("http://kernel.omp-sandbox-test.invalid/"); console.log("status", response.status);',
		);
		expect(result.isError).toBeFalsy();
		expect(text).toContain("status 403");
		expect(own).toEqual(["kernel.omp-sandbox-test.invalid"]);
		expect(text).toContain(NOTICE);
	}, 60_000);

	it("names a host refused to the cell's `sh()` command, though the cell succeeded", async () => {
		const { result, text, own } = await runCell(
			"js",
			'const out = await sh("curl -s -o /dev/null --max-time 10 http://shell.omp-sandbox-test.invalid/; echo rc=$?"); console.log(out.output ?? out);',
		);
		expect(result.isError).toBeFalsy();
		expect(own).toEqual(["shell.omp-sandbox-test.invalid"]);
		expect(text).toContain(NOTICE);
	}, 60_000);

	it.skipIf(!pythonAvailable)(
		"names a host the Python kernel's own request was refused, though the cell succeeded",
		async () => {
			const { result, text, own } = await runCell(
				"py",
				[
					"import urllib.request, urllib.error",
					"try:",
					'    urllib.request.urlopen("http://py.omp-sandbox-test.invalid/", timeout=10)',
					"except urllib.error.HTTPError as error:",
					'    print("status", error.code)',
				].join("\n"),
			);
			expect(result.isError).toBeFalsy();
			expect(text).toContain("status 403");
			expect(own).toEqual(["py.omp-sandbox-test.invalid"]);
			expect(text).toContain(NOTICE);
		},
		60_000,
	);
});
