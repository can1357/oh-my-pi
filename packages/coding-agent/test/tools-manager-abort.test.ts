import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type DownloadActivity, onDownloadActivity } from "@oh-my-pi/pi-coding-agent/downloads/activity";
import { ensureTool } from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as ptree from "@oh-my-pi/pi-utils/ptree";

describe("ensureTool signal abort handling", () => {
	const originalPath = process.env.PATH;

	beforeEach(() => {
		process.env.PATH = "/mock/hermetic/path";
		vi.spyOn(Bun, "which").mockImplementation(cmd => {
			if (cmd === "trafilatura") return null;
			if (cmd === "uv") return "/mock/bin/uv";
			if (cmd === "pip" || cmd === "pip3") return "/mock/bin/pip";
			return null;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.PATH = originalPath;
	});

	it("returns undefined without spawning installer when signal is already aborted", async () => {
		const execSpy = vi.spyOn(ptree, "exec");
		const signal = AbortSignal.abort(new Error("pre-aborted"));

		const result = await ensureTool("trafilatura", { signal, silent: true });
		expect(result).toBeUndefined();
		expect(execSpy).not.toHaveBeenCalled();
	});

	it("does not fall through to pip if uv is aborted", async () => {
		const controller = new AbortController();
		const executedCommands: string[][] = [];

		vi.spyOn(ptree, "exec").mockImplementation(async cmd => {
			executedCommands.push(cmd);
			if (cmd.some(arg => arg.includes("uv"))) {
				controller.abort(new Error("aborted during uv"));
				return {
					stdout: "",
					stderr: "aborted",
					exitCode: null,
					ok: false,
					exitError: new ptree.AbortError("aborted", "cancelled"),
				};
			}
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				ok: true,
			};
		});

		const result = await ensureTool("trafilatura", { signal: controller.signal, silent: true });
		expect(result).toBeUndefined();
		expect(executedCommands.length).toBeGreaterThan(0);
		const ranUv = executedCommands.some(cmd => cmd.some(arg => arg.includes("uv")));
		const ranPip = executedCommands.some(cmd => cmd.some(arg => arg.includes("pip")));
		expect(ranUv).toBe(true);
		expect(ranPip).toBe(false);
	});

	it("settles the download tracker on cancellation without failing", async () => {
		const controller = new AbortController();

		vi.spyOn(ptree, "exec").mockImplementation(async cmd => {
			if (cmd.some(arg => arg.includes("uv"))) {
				controller.abort(new Error("aborted during uv"));
				return {
					stdout: "",
					stderr: "aborted",
					exitCode: null,
					ok: false,
					exitError: new ptree.AbortError("aborted", "cancelled"),
				};
			}
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				ok: true,
			};
		});

		const activities: DownloadActivity[] = [];
		const unsub = onDownloadActivity(a => activities.push(a));
		try {
			const result = await ensureTool("trafilatura", { signal: controller.signal, silent: true });
			expect(result).toBeUndefined();
			expect(activities.map(a => a.state)).toEqual(["running", "done"]);
		} finally {
			unsub();
		}
	});
});
