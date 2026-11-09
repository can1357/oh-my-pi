import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let temp: TempDir;
let settingsState: SettingsTestState;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-shell-helper-");
	setAgentDir(path.join(temp.path(), "agent"));
	await fs.mkdir(path.join(temp.path(), "sub"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	AgentStorage.close();
	temp.removeSync();
});

/** A session whose `bash` tool would auto-background anything slower than 10 ms; `sh` must not. */
function makeSession(): ToolSession {
	const id = `shell-helper-${crypto.randomUUID()}`;
	return {
		cwd: temp.path(),
		hasUI: false,
		skills: [],
		settings: Settings.isolated({
			"eval.autoProvision": false,
			"bash.autoBackground.enabled": true,
			"bash.autoBackground.thresholdMs": 10,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
	};
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

const CELLS = {
	js: [
		"const quoted = await sh`sleep 0.2; printf '%s|' ${['a b', \"c'd\"]} ${'$HOME'}`;",
		"await sh('cd sub');",
		"const cwd = [(await sh('pwd -P')).trim(), (await sh('pwd -P', { cwd: 'sub' })).trim()];",
		"let failure;",
		"try { await sh('echo boom; exit 3'); } catch (error) { failure = { name: error.name, code: error.exitCode, output: error.output }; }",
		"print('RESULT ' + JSON.stringify({ quoted, cwd, failure }));",
	].join("\n"),
	py: [
		"import json",
		"quoted = sh(\"sleep 0.2; printf '%s|' 'a b' $(echo nested)\")",
		'sh("cd sub")',
		'cwd = [sh("pwd -P").strip(), sh("pwd -P", cwd="sub").strip()]',
		"try:",
		'    sh("echo boom; exit 3")',
		"except ShellError as error:",
		'    failure = {"name": type(error).__name__, "code": error.exit_code, "output": error.output}',
		'print("RESULT " + json.dumps({"quoted": quoted, "cwd": cwd, "failure": failure}))',
	].join("\n"),
};

async function runCell(language: "js" | "py"): Promise<Record<string, unknown>> {
	const result = await new EvalTool(makeSession()).execute("call", { language, code: CELLS[language], timeout: 60 });
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
	const line = text.split("\n").find(entry => entry.startsWith("RESULT "));
	if (!line) throw new Error(`no RESULT line in eval output:\n${text}`);
	return JSON.parse(line.slice("RESULT ".length));
}

describe("eval sh helper", () => {
	it("js: quotes template values, starts each command in the session cwd or `cwd`, and throws ShellError without backgrounding", async () => {
		const result = await runCell("js");
		const root = await fs.realpath(temp.path());
		expect(result).toEqual({
			quoted: "a b|c'd|$HOME|",
			cwd: [root, path.join(root, "sub")],
			failure: { name: "ShellError", code: 3, output: "boom\n" },
		});
	});

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: starts each command in the session cwd or `cwd` and raises ShellError without backgrounding",
		async () => {
			const result = await runCell("py");
			const root = await fs.realpath(temp.path());
			expect(result).toEqual({
				quoted: "a b|nested|",
				cwd: [root, path.join(root, "sub")],
				failure: { name: "ShellError", code: 3, output: "boom\n" },
			});
		},
	);
});
