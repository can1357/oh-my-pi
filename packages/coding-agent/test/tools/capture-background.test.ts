import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { HubTool, hubToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { CoordinationDetails, JobSnapshot } from "@oh-my-pi/pi-coding-agent/tools/hub/types";
import {
	formatOutputNotice,
	type OutputMeta,
	wrapToolWithMetaNotice,
} from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
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

function snapshotSessionFor(root: string, manager: AsyncJobManager, store: SessionManager): ToolSession {
	store.adoptArtifactManager(new ArtifactManager(path.join(root, "artifacts")));
	const session = sessionFor(root, manager);
	session.settings.override("tools.artifactSpillThreshold", 1);
	session.settings.override("tools.artifactHeadBytes", 1);
	session.settings.override("tools.artifactTailBytes", 1);
	session.settings.override("tools.artifactTailLines", 10);
	session.settings.override("tools.outputMaxColumns", 0);
	session.localProtocolOptions = {
		getArtifactsDir: () => store.getArtifactsDir(),
		getSessionId: () => store.getSessionId(),
	};
	return session;
}

function registerResult(manager: AsyncJobManager, id: string, text: string, meta?: OutputMeta, failed = false): string {
	const jobId = manager.register(
		"bash",
		id,
		async ({ reportProgress }) => {
			const result = text + formatOutputNotice(meta);
			await reportProgress(result, { meta });
			if (failed) throw new Error(result);
			return result;
		},
		{ id },
	);
	manager.acknowledgeDeliveries([jobId]);
	return jobId;
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

	it("keeps a mixed snapshot's complete job result recoverable after both results are consumed", async () => {
		await using temp = await TempDir.create("@capture-mixed-snapshot-");
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_id, text) => {
				deliveries.push(text);
			},
		});
		const store = SessionManager.inMemory(temp.path());
		const session = snapshotSessionFor(temp.path(), manager, store);
		const context = { sessionManager: store, settings: session.settings } as unknown as AgentToolContext;
		const tool = wrapToolWithMetaNotice(new HubTool(session));
		const reader = wrapToolWithMetaNotice(new ReadTool(session));
		const marker = "COMPLETE-JOB-UNIQUE-MIDDLE-MARKER";
		const complete = `${"healthy head line\n".repeat(300)}${marker}\n${"healthy tail line\n".repeat(300)}`;
		const failedCaptureId = registerResult(manager, "failed-capture", "surviving preview", {
			artifactError: "write",
		});
		const completeId = registerResult(manager, "complete-capture", complete);
		try {
			await Promise.all([manager.getJob(failedCaptureId)!.promise, manager.getJob(completeId)!.promise]);
			const snapshot = await tool.execute("mixed", { op: "jobs" }, undefined, undefined, context);
			const text = snapshot.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).not.toContain(marker);
			expect(text).toMatch(/artifact:\/\/\d+ for full report/);
			expect(text).not.toMatch(/artifact:\/\/\d+ for full output/);
			expect(text.match(/not saved completely/g)).toHaveLength(1);
			expect(manager.isJobResultConsumed(failedCaptureId)).toBe(true);
			expect(manager.isJobResultConsumed(completeId)).toBe(true);
			expect(manager.getJob(failedCaptureId)?.status).toBe("completed");
			await manager.drainDeliveries();
			expect(deliveries).toEqual([]);

			const artifactUrl = text.match(/artifact:\/\/\d+/)?.[0];
			if (!artifactUrl) throw new Error("Expected recoverable snapshot report");
			const read = await reader.execute(
				"recover",
				{ path: `${artifactUrl}:raw:1-1000` },
				undefined,
				undefined,
				context,
			);
			const recovered = read.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(recovered).toContain(complete);
			expect(recovered).toContain("surviving preview");
			expect(recovered.match(/not saved completely/g)).toHaveLength(1);

			const next = await tool.execute("consumed", { op: "jobs" }, undefined, undefined, context);
			const nextText = next.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(nextText).toContain("already delivered or recovered");
			expect(nextText).not.toContain("surviving preview");
			expect(nextText).not.toContain(marker);
			const reread = await reader.execute("recover-again", { path: `${artifactUrl}:raw:1-1000` });
			expect(reread.content.map(block => (block.type === "text" ? block.text : "")).join("\n")).toContain(complete);
		} finally {
			await manager.dispose();
			await store.close();
		}
	});

	it("shows each short job capture warning once in model text and live or rebuilt Hub rows", async () => {
		await using temp = await TempDir.create("@capture-short-snapshot-");
		const manager = new AsyncJobManager({});
		const store = SessionManager.inMemory(temp.path());
		const session = snapshotSessionFor(temp.path(), manager, store);
		const successful = registerResult(manager, "successful-command", "success preview", { artifactError: "open" });
		const failed = registerResult(
			manager,
			"failed-command",
			"Command exited with code 7",
			{ artifactError: "write" },
			true,
		);
		try {
			await Promise.all([manager.getJob(successful)!.promise, manager.getJob(failed)!.promise]);
			const snapshot = await wrapToolWithMetaNotice(new HubTool(session)).execute(
				"short",
				{ op: "jobs" },
				undefined,
				undefined,
				{ sessionManager: store, settings: session.settings } as unknown as AgentToolContext,
			);
			const text = snapshot.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).not.toContain("artifact://");
			expect(text.match(/artifact open failed/g)).toHaveLength(1);
			expect(text.match(/artifact write failed/g)).toHaveLength(1);
			expect(text).toContain("successful-command [bash] — completed");
			expect(text).toContain("failed-command [bash] — failed");
			expect(text).toContain("Command exited with code 7");
			const uiTheme = await getThemeByName("dark");
			if (!uiTheme) throw new Error("Expected dark theme");
			const persisted = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
			for (const result of [snapshot, persisted]) {
				for (const expanded of [false, true]) {
					const rendered = hubToolRenderer
						.renderResult(result, { expanded, isPartial: false }, uiTheme)
						.render(180)
						.map(line => Bun.stripANSI(line))
						.join("\n");
					expect(rendered.match(/artifact open failed/g)).toHaveLength(1);
					expect(rendered.match(/artifact write failed/g)).toHaveLength(1);
				}
			}
		} finally {
			await manager.dispose();
			await store.close();
		}
	});

	it("retains each legacy Hub capture warning once when rebuilding short and truncated rows", async () => {
		const jobs: JobSnapshot[] = [
			{
				id: "legacy-short",
				type: "bash",
				status: "completed",
				label: "short command",
				durationMs: 1,
				artifactError: "open",
				resultText: "short preview" + formatOutputNotice({ artifactError: "open" }),
			},
			{
				id: "legacy-long",
				type: "bash",
				status: "failed",
				label: "long command",
				durationMs: 1,
				artifactError: "write",
				errorText: "long preview\n".repeat(20) + formatOutputNotice({ artifactError: "write" }),
			},
		];
		const details = JSON.parse(
			JSON.stringify({ op: "jobs", meta: { artifactError: "open" }, jobs }),
		) as CoordinationDetails;
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("Expected dark theme");
		for (const expanded of [false, true]) {
			const rendered = hubToolRenderer
				.renderResult({ content: [], details }, { expanded, isPartial: false }, uiTheme)
				.render(180)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered.match(/artifact open failed/g)).toHaveLength(1);
			expect(rendered.match(/artifact write failed/g)).toHaveLength(1);
		}
	});

	it("retains a historical Hub aggregate warning when no persisted row identifies the failed capture", async () => {
		const details: CoordinationDetails = {
			op: "jobs",
			meta: { artifactError: "end" },
			jobs: [
				{
					id: "legacy-root",
					type: "bash",
					status: "completed",
					label: "legacy command",
					durationMs: 1,
					resultText: "long preview\n".repeat(20) + formatOutputNotice({ artifactError: "end" }),
				},
			],
		};
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("Expected dark theme");
		for (const expanded of [false, true]) {
			const rendered = hubToolRenderer
				.renderResult({ content: [], details }, { expanded, isPartial: false }, uiTheme)
				.render(180)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered.match(/artifact end failed/g)).toHaveLength(1);
		}
	});

	it("spills a single incomplete job as a report without advertising its preview as the full command log", async () => {
		await using temp = await TempDir.create("@capture-single-snapshot-");
		const manager = new AsyncJobManager({});
		const store = SessionManager.inMemory(temp.path());
		const session = snapshotSessionFor(temp.path(), manager, store);
		const preview = `${"surviving head\n".repeat(100)}PREVIEW-MIDDLE\n${"surviving tail\n".repeat(100)}Command exited with code 7`;
		const id = registerResult(manager, "single-failed-command", preview, { artifactError: "end" }, true);
		try {
			await manager.getJob(id)!.promise;
			const snapshot = await wrapToolWithMetaNotice(new HubTool(session)).execute(
				"single",
				{ op: "wait", ids: [id] },
				undefined,
				undefined,
				{ sessionManager: store, settings: session.settings } as unknown as AgentToolContext,
			);
			const text = snapshot.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).not.toContain("PREVIEW-MIDDLE");
			expect(text).toMatch(/artifact:\/\/\d+ for full report/);
			expect(text).not.toMatch(/artifact:\/\/\d+ for full output/);
			expect(text.match(/artifact end failed/g)).toHaveLength(1);
			expect(manager.getJob(id)?.status).toBe("failed");
			const artifactUrl = text.match(/artifact:\/\/\d+/)?.[0];
			if (!artifactUrl) throw new Error("Expected recoverable snapshot report");
			const read = await new ReadTool(session).execute("recover-single", { path: `${artifactUrl}:raw` });
			const recovered = read.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(recovered).toContain(preview);
			expect(recovered.match(/artifact end failed/g)).toHaveLength(1);
		} finally {
			await manager.dispose();
			await store.close();
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
