import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionFor(root: string, manager?: AsyncJobManager): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(root, "artifacts"),
		getSessionId: () => "capture-regression",
		allocateOutputArtifact: async () => ({ path: root, id: "failed" }),
		asyncJobManager: manager,
		settings: Settings.isolated({
			"async.enabled": true,
			"bashInterceptor.enabled": false,
			"bash.autoBackground.enabled": false,
			"eval.autoBackground.enabled": true,
			"eval.autoBackground.thresholdMs": 0,
			"tools.outputMaxColumns": 8,
		}),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("capture failure across background and cancellation boundaries", () => {
	it("retains the capture warning on a foreground bash abort", async () => {
		await using temp = await TempDir.create("@capture-abort-");
		const controller = new AbortController();
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			controller.abort();
			return {
				output: "partial command output",
				exitCode: undefined,
				cancelled: true,
				timedOut: false,
				truncated: true,
				totalBytes: 1000,
				totalLines: 1,
				outputBytes: 22,
				outputLines: 1,
				artifactError: "open",
			};
		});
		let error: unknown;
		try {
			await new BashTool(sessionFor(temp.path())).execute("cancel", { command: "echo example" }, controller.signal);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ToolAbortError);
		if (!(error instanceof Error)) throw new Error("Expected cancellation error");
		expect(error.message).toContain("partial command output");
		expect(error.message).toContain("not saved completely");
		expect(error.message).not.toContain("artifact://");
	});

	it("delivers capture warnings for successful async bash without changing its outcome", async () => {
		await using temp = await TempDir.create("@capture-background-bash-");
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (_id, text) => {
				deliveries.push(text);
			},
		});
		const session = sessionFor(temp.path(), manager);
		const sessionManager = SessionManager.inMemory(temp.path());
		try {
			vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
				output: "x".repeat(20_000),
				exitCode: 0,
				cancelled: false,
				timedOut: false,
				truncated: true,
				totalBytes: 200_000,
				totalLines: 1,
				outputBytes: 20_000,
				outputLines: 1,
				artifactError: "write",
			});
			const result = await new BashTool(session).execute("background", { command: "echo example", async: true });
			const jobId = result.details?.async?.jobId;
			if (!jobId) throw new Error("Expected background job");
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries();
			expect(manager.getJob(jobId)?.status).toBe("completed");
			expect(deliveries[0]).toContain("not saved completely");
			expect(deliveries[0]).not.toContain("artifact://");
		} finally {
			await manager.dispose();
			await sessionManager.close();
		}
	});

	it("delivers an eval background capture failure without failing the completed cell", async () => {
		await using temp = await TempDir.create("@capture-background-eval-");
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (_id, text) => {
				deliveries.push(text);
			},
		});
		try {
			const gate = Promise.withResolvers<void>();
			vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(async (_code, options) => {
				options.onChunk("x".repeat(80));
				await gate.promise;
				return {
					output: "completed cell",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 1,
					totalBytes: 80,
					outputLines: 1,
					outputBytes: 14,
					displayOutputs: [],
					artifactId: undefined,
				};
			});
			const result = await new EvalTool(sessionFor(temp.path(), manager)).execute("eval", {
				language: "js",
				code: "display('example')",
			});
			const jobId = result.details?.async?.jobId;
			if (!jobId) throw new Error("Expected background eval");
			gate.resolve();
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries();
			expect(manager.getJob(jobId)?.status).toBe("completed");
			expect(deliveries[0]).toContain("completed cell");
			expect(deliveries[0]).toContain("not saved completely");
			expect(deliveries[0]).not.toContain("artifact://");
		} finally {
			await manager.dispose();
		}
	});
});
