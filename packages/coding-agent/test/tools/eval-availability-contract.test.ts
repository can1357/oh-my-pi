import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pythonBackend } from "@oh-my-pi/pi-coding-agent/eval";
import * as probe from "@oh-my-pi/pi-coding-agent/eval/probe";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pyRuntime from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

function languages(tool: EvalTool): string[] {
	const wire = toolWireSchema(tool) as { properties: { language: { enum?: string[]; const?: string } } };
	const language = wire.properties.language;
	return language.enum ?? (language.const ? [language.const] : []);
}

describe("eval Python availability contract", () => {
	let dir: TempDir;
	let savedPy: string | undefined;
	let savedJs: string | undefined;

	beforeEach(() => {
		dir = TempDir.createSync("@eval-availability-contract-");
		savedPy = Bun.env.PI_PY;
		savedJs = Bun.env.PI_JS;
		delete Bun.env.PI_PY;
		delete Bun.env.PI_JS;
		vi.spyOn(pyRuntime, "enumeratePythonRuntimes").mockReturnValue([{ pythonPath: "/tmp/broken-python", env: {} }]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnvValue("PI_PY", savedPy);
		restoreEnvValue("PI_JS", savedJs);
		await dir.remove();
	});

	function session(overrides: Record<string, unknown> = {}): ToolSession {
		return {
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(overrides),
		};
	}

	it("publishes a failed probe before the next schema and prelude are requested", async () => {
		const owner = session();
		const tool = new EvalTool(owner);
		const failure = "/tmp/broken-python (exit code 1)";
		const candidateProbe = vi.spyOn(probe, "probeCandidates").mockResolvedValue({
			ok: false,
			aborted: false,
			failures: [failure],
		});
		vi.spyOn(pythonBackend, "checkAvailability").mockImplementation((_session, options) =>
			pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { ...options, forceProbe: true }),
		);
		expect(languages(tool)).toEqual(["py", "js"]);
		expect(candidateProbe).not.toHaveBeenCalled();
		const execution = tool.execute("py-unavailable", { language: "py", code: "print(1)" });
		await expect(execution).rejects.toThrow(failure);
		await expect(execution).rejects.toThrow(/Python 3\.8\+.*PATH/);
		await expect(execution).rejects.not.toThrow("install the python kernel");
		expect(languages(tool)).toEqual(["js"]);
		expect(tool.description).not.toContain("Python:");
		expect(tool.description).not.toContain("Python (kwargs)");
		expect(tool.docTopics().helpers).not.toContain("%pip install");
		expect(tool.summary).toContain("JavaScript");
		expect(tool.summary).not.toContain("Python");
		expect(candidateProbe).toHaveBeenCalledTimes(1);
	});

	it("refreshes failed and successful availability instead of retaining a stale language enum", async () => {
		const owner = session();
		const tool = new EvalTool(owner);
		const candidateProbe = vi.spyOn(probe, "probeCandidates").mockResolvedValue({
			ok: false,
			aborted: false,
			failures: ["broken"],
		});
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["js"]);
		candidateProbe.mockResolvedValue({ ok: true, index: 0 });
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["py", "js"]);
		expect(tool.description).toContain("Python:");
		candidateProbe.mockResolvedValue({ ok: false, aborted: false, failures: ["broken again"] });
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["js"]);
		expect(candidateProbe).toHaveBeenCalledTimes(3);
	});

	it("does not turn a cancelled or deadline-limited probe into permanent unavailability", async () => {
		const owner = session();
		const tool = new EvalTool(owner);
		const candidateProbe = vi.spyOn(probe, "probeCandidates").mockResolvedValue({
			ok: false,
			aborted: true,
			failures: [],
		});
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["py", "js"]);
		candidateProbe.mockResolvedValue({
			ok: false,
			aborted: false,
			timedOut: true,
			failures: ["/tmp/broken-python (probe timed out)"],
		});
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["py", "js"]);
	});

	it("does not advertise Python again when it is the only enabled runtime and its probe failed", async () => {
		const owner = session({ "eval.js": false });
		const tool = new EvalTool(owner);
		expect(languages(tool)).toEqual(["py"]);
		vi.spyOn(probe, "probeCandidates").mockResolvedValue({ ok: false, aborted: false, failures: ["broken"] });
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual([]);
		expect(tool.description).not.toContain("Python:");
		expect(tool.description).not.toContain("Python (kwargs)");
		expect(tool.summary).not.toContain("Python or JavaScript");
	});

	it("never probes or advertises Python when settings allow only JavaScript", () => {
		const candidateProbe = vi.spyOn(probe, "probeCandidates");
		const tool = new EvalTool(session({ "eval.py": false }));
		expect(languages(tool)).toEqual(["js"]);
		expect(tool.description).not.toContain("Python:");
		expect(candidateProbe).not.toHaveBeenCalled();
	});

	it("drops a failed snapshot when PATH changes so a repaired runtime can be discovered", async () => {
		const owner = session();
		const tool = new EvalTool(owner);
		vi.spyOn(probe, "probeCandidates").mockResolvedValue({ ok: false, aborted: false, failures: ["broken"] });
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["js"]);
		const previousPath = Bun.env.PATH;
		try {
			Bun.env.PATH = `${dir.path()}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
			expect(languages(tool)).toEqual(["py", "js"]);
		} finally {
			restoreEnvValue("PATH", previousPath);
		}
	});

	it("does not retain a startup failure after the Python module search environment changes", async () => {
		const owner = session();
		const tool = new EvalTool(owner);
		vi.spyOn(probe, "probeCandidates").mockResolvedValue({ ok: false, aborted: false, failures: ["startup failed"] });
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["js"]);
		const previousPath = Bun.env.PYTHONPATH;
		try {
			Bun.env.PYTHONPATH = dir.path();
			expect(languages(tool)).toEqual(["py", "js"]);
		} finally {
			restoreEnvValue("PYTHONPATH", previousPath);
		}
	});
});
