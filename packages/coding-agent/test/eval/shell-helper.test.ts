import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import * as shellBridge from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
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
function makeSession(settingsOverrides: Record<string, unknown> = {}): ToolSession {
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
			...settingsOverrides,
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

const MARKER_COMMAND = "printf approved > guard-marker";

function promptedSession(approve: () => Promise<"once" | "deny">): ToolSession {
	const session = makeSession({
		"tools.approvalMode": "yolo",
		"bash.patterns": [{ match: MARKER_COMMAND, approval: "prompt" }],
	});
	session.getToolContext = () =>
		({
			settings: session.settings,
			hasUI: true,
			toolNames: ["bash"],
			ui: { approve },
		}) as unknown as AgentToolContext;
	return session;
}

describe("eval sh approval", () => {
	it.each(["pattern", "tool"] as const)("does not execute a command denied by %s policy under yolo", async policy => {
		const session = makeSession({
			"tools.approvalMode": "yolo",
			"bash.patterns": policy === "pattern" ? [{ match: MARKER_COMMAND, approval: "deny" }] : [],
			"tools.approval": policy === "tool" ? { bash: "deny" } : {},
		});

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session })).rejects.toThrow(/blocked/);
		expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
	});

	it("intercepts a compound command without forwarding unsupported service fields", async () => {
		const session = makeSession({
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": [{ pattern: "^printf approved", tool: "bash", message: "probe blocked" }],
		});
		session.getToolContext = () => ({ settings: session.settings, toolNames: ["bash"] }) as AgentToolContext;

		await expect(
			shellBridge.runEvalShell({ command: `cd sub && ${MARKER_COMMAND}`, name: "untrusted-service" }, { session }),
		).rejects.toThrow(/probe blocked/);
		expect(await Bun.file(path.join(temp.path(), "sub", "guard-marker")).exists()).toBe(false);
	});

	it("does not execute a command requiring approval without an interactive UI", async () => {
		const session = makeSession({ "bash.patterns": [{ match: MARKER_COMMAND, approval: "prompt" }] });

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session })).rejects.toThrow(
			/requires approval[\s\S]*Prompt required by bash pattern/,
		);
		expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
	});

	it("requires approval for unmatched commands in always-ask mode", async () => {
		const session = makeSession({ "tools.approvalMode": "always-ask" });

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session })).rejects.toThrow(
			/requires approval/,
		);
		expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
	});

	it("honors an explicit allow for a plain command in always-ask mode", async () => {
		const command = "printf explicitly-allowed";
		const session = makeSession({
			"tools.approvalMode": "always-ask",
			"bash.patterns": [{ match: command, approval: "allow" }],
		});

		expect(await shellBridge.runEvalShell({ command }, { session })).toMatchObject({
			output: "explicitly-allowed",
			exitCode: 0,
		});
	});

	it("requires approval for an explicit restricted cwd even under yolo", async () => {
		const session = makeSession({
			"tools.approvalMode": "yolo",
			"tools.restrictedFolders": [path.join(temp.path(), "sub")],
		});

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND, cwd: "sub" }, { session })).rejects.toThrow(
			/requires approval[\s\S]*Restricted folder/,
		);
		expect(await Bun.file(path.join(temp.path(), "sub", "guard-marker")).exists()).toBe(false);
	});

	it("honors disabled Bash in a bare SDK session", async () => {
		const session = makeSession({ "bash.enabled": false });

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session })).rejects.toThrow(/enabled/);
		expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
	});

	it("waits for approval and executes in the authorized cwd despite fresh permission proxies", async () => {
		const shown = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<"once">();
		const session = promptedSession(() => {
			shown.resolve();
			return answer.promise;
		});
		const bash: Tool = new BashTool(session);
		session.getToolByName = () => bash;
		session.getToolForEvalBridge = () => new Proxy(bash, {});
		const result = shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session });
		try {
			await shown.promise;
			expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
			session.cwd = path.join(temp.path(), "sub");
			answer.resolve("once");
			expect((await result).exitCode).toBe(0);
			expect(await Bun.file(path.join(temp.path(), "guard-marker")).text()).toBe("approved");
			expect(await Bun.file(path.join(temp.path(), "sub", "guard-marker")).exists()).toBe(false);
		} finally {
			answer.resolve("once");
			await result.catch(() => undefined);
		}
	});

	it("does not execute after the user refuses approval", async () => {
		const session = promptedSession(async () => "deny");

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session })).rejects.toThrow(
			/denied by user/,
		);
		expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
	});

	it("does not fall back to an available registration when Bash is disabled", async () => {
		const session = makeSession();
		const bash: Tool = new BashTool(session);
		session.getToolByName = () => bash;
		session.getToolForEvalBridge = () => undefined;

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session })).rejects.toThrow(/enabled/);
		expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
	});

	it("does not recreate a missing Bash tool when a registry is present", async () => {
		const session = makeSession();
		session.getToolByName = () => undefined;

		await expect(shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session })).rejects.toThrow(/enabled/);
		expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
	});

	it.each(["disabled", "replaced", "session", "bare-disabled"] as const)(
		"does not execute if authorization becomes stale through %s while prompting",
		async change => {
			const shown = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<"once">();
			const session = promptedSession(() => {
				shown.resolve();
				return answer.promise;
			});
			let bash: Tool | undefined = new BashTool(session);
			if (change !== "bare-disabled") {
				session.getToolByName = () => bash;
				session.getToolForEvalBridge = () => (bash ? new Proxy(bash, {}) : undefined);
			}
			const result = shellBridge.runEvalShell({ command: MARKER_COMMAND }, { session });
			try {
				await shown.promise;
				if (change === "session") session.getSessionId = () => "different-session";
				else if (change === "bare-disabled") session.settings = Settings.isolated({ "bash.enabled": false });
				else bash = change === "replaced" ? new BashTool(session) : undefined;
				answer.resolve("once");
				await expect(result).rejects.toThrow(/authorization became stale/);
				expect(await Bun.file(path.join(temp.path(), "guard-marker")).exists()).toBe(false);
			} finally {
				answer.resolve("once");
				await result.catch(() => undefined);
			}
		},
	);

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: an approval after a timed-out cell cannot execute the pending shell command",
		async () => {
			const shown = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<"once" | "deny">();
			const caller = new AbortController();
			let late = false;
			const session = promptedSession(() => {
				if (!late) return Promise.resolve("once");
				shown.resolve();
				return answer.promise;
			});
			session.hasUI = true;
			const tool = new EvalTool(session);
			let pending: Promise<unknown> | undefined;
			try {
				// The real Python subprocess deadline cannot be advanced with JS fake timers.
				await tool.execute("warmup", { language: "py", code: "print('warm')", timeout: 30 }, caller.signal);
				const early = await tool.execute(
					"early-approval",
					{ language: "py", code: `sh(${JSON.stringify(MARKER_COMMAND)}); print("EARLY_DONE")`, timeout: 30 },
					caller.signal,
				);
				expect(early.content.some(part => part.type === "text" && part.text.includes("EARLY_DONE"))).toBe(true);
				const marker = path.join(temp.path(), "guard-marker");
				expect(await Bun.file(marker).text()).toBe("approved");
				await fs.unlink(marker);

				late = true;
				const shellFinished = Promise.withResolvers<void>();
				const executeShell = shellBridge.runEvalShell;
				spyOn(shellBridge, "runEvalShell").mockImplementation(async (...args) => {
					try {
						return await executeShell(...args);
					} finally {
						shellFinished.resolve();
					}
				});
				const run = tool.execute(
					"late-approval",
					{ language: "py", code: `sh(${JSON.stringify(MARKER_COMMAND)})`, timeout: 1 },
					caller.signal,
				);
				pending = run;
				await Promise.race([
					shown.promise,
					run.then(() => {
						throw new Error("Cell ended before the approval request");
					}),
				]);
				const result = await run;
				expect(result.content.some(part => part.type === "text" && /timed out/.test(part.text))).toBe(true);
				expect(await Bun.file(marker).exists()).toBe(false);
				answer.resolve("once");
				await shellFinished.promise;
				expect(await Bun.file(marker).exists()).toBe(false);
			} finally {
				caller.abort();
				answer.resolve("deny");
				await pending?.catch(() => undefined);
			}
		},
		10_000,
	);
});
