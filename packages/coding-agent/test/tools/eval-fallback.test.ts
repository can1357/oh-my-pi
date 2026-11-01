import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { resolveEvalBackends } from "@oh-my-pi/pi-coding-agent/tools/eval-backends";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

import { cfgEvalJs, cfgEvalPy } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { cfgToolsMaxTimeout } from "@oh-my-pi/pi-coding-agent/tools/settings";

let originalPiPy: string | undefined;
let originalPiJs: string | undefined;

function restoreEnv(name: "PI_PY" | "PI_JS", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}
function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
};

describe("EvalTool language dispatch", () => {
	beforeEach(() => {
		originalPiPy = Bun.env.PI_PY;
		originalPiJs = Bun.env.PI_JS;
		delete Bun.env.PI_PY;
		delete Bun.env.PI_JS;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("PI_PY", originalPiPy);
		restoreEnv("PI_JS", originalPiJs);
	});

	it('dispatches to the JS backend when cell.language === "js"', async () => {
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-js", {
			language: "js",
			code: "const x = 1;",
		});

		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
		expect(pythonExecuteSpy).not.toHaveBeenCalled();
	});

	it('dispatches to the Python backend when cell.language === "py"', async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "checkAvailability").mockResolvedValue({ ok: true });
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", {
			language: "py",
			code: "print('hi')",
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});

	it("bounds backend probing by the effective global eval timeout and surfaces the probe reason", async () => {
		const settings = Settings.isolated();
		cfgToolsMaxTimeout.set(settings, 1);
		const reason = "No working Python interpreter found. Tried: /shims/python (exit code 1)";
		const probeSpy = vi.spyOn(evalIndex.pythonBackend, "checkAvailability").mockResolvedValue({ ok: false, reason });

		const tool = new EvalTool(makeSession(settings));
		const execution = tool.execute("call-py-probe-timeout", { language: "py", code: "never runs" });
		await expect(execution).rejects.toThrow(/Python backend is unavailable/);
		await expect(execution).rejects.toThrow(reason);

		expect(probeSpy.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 1_000 });
	});

	it("shortens home paths and bounds a failed Python probe list in the eval error", async () => {
		const home = os.homedir();
		const reason = `No working Python interpreter found. Tried: ${path.join(home, ".local", "share", "mise", "shims", "python")} (exit code 1);\t${Array.from({ length: 40 }, (_, index) => `/opt/broken-${index}/python (exit code 1)`).join("; ")}`;
		vi.spyOn(evalIndex.pythonBackend, "checkAvailability").mockResolvedValue({ ok: false, reason });

		let message = "";
		try {
			await new EvalTool(makeSession()).execute("call-py-probe-failure", { language: "py", code: "never runs" });
		} catch (err) {
			if (err instanceof Error) message = err.message;
		}

		expect(message).toContain("~/.local/share/mise/shims/python (exit code 1)");
		expect(message).not.toContain(home);
		expect(message).not.toContain("\t");
		const lines = message.split("\n");
		expect(lines).toHaveLength(2);
		expect(Bun.stringWidth(lines[1])).toBeLessThanOrEqual(TRUNCATE_LENGTHS.RECAP);
	});

	it("preserves caller cancellation during py availability probing", async () => {
		const settings = Settings.isolated();
		const controller = new AbortController();
		vi.spyOn(evalIndex.pythonBackend, "checkAvailability").mockImplementation(async () => {
			controller.abort();
			return { ok: false };
		});

		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-py-abort", { language: "py", code: "never runs" }, controller.signal),
		).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("dispatches each call to the backend named by its language", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "checkAvailability").mockResolvedValue({ ok: true });
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", { language: "py", code: "x = 1" });
		await tool.execute("call-js", { language: "js", code: "const y = 2;" });

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects py cells when eval.py is disabled", async () => {
		const settings = Settings.isolated();
		cfgEvalPy.set(settings, false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-py-disabled", {
				language: "py",
				code: "print('hi')",
			}),
		).rejects.toThrow(/eval\.py = false/);
	});

	it("rejects js cells when eval.js is disabled", async () => {
		const settings = Settings.isolated();
		cfgEvalJs.set(settings, false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-js-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/eval\.js = false/);
	});

	it("uses settings for eval backends whose env flag is unset", () => {
		Bun.env.PI_PY = "1";
		const settings = Settings.isolated();
		cfgEvalPy.set(settings, false);
		cfgEvalJs.set(settings, false);

		expect(resolveEvalBackends(makeSession(settings))).toEqual({
			python: true,
			js: false,
		});
	});

	it("lets PI_JS disable js execution even when eval.js is enabled", async () => {
		Bun.env.PI_JS = "0";
		const settings = Settings.isolated();
		cfgEvalJs.set(settings, true);
		const tool = new EvalTool(makeSession(settings));

		await expect(
			tool.execute("call-js-env-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/PI_JS=0/);
	});
});
