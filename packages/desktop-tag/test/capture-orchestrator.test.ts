import { describe, expect, it } from "bun:test";

import { CaptureOrchestrator } from "../src/capture/orchestrator";
import type {
	CaptureRun,
	CaptureRunEvent,
	CaptureRunStatus,
	CollaborationAdapter,
	CollaborationMessageRef,
} from "../src/capture/types";
import { baseRequest, createTestStore, FakeRunnerAdapter, PNG_BASE64, waitFor } from "./helpers/capture-fakes";

class RecordingAdapter implements CollaborationAdapter {
	readonly id = "recording";
	readonly published: CaptureRun[] = [];
	readonly events: CaptureRunEvent[] = [];
	readonly results: Array<{ status: CaptureRunStatus; text: string }> = [];

	async publishTask(run: CaptureRun): Promise<CollaborationMessageRef | undefined> {
		this.published.push(run);
		return { channelId: "-100", messageId: String(this.published.length) };
	}

	async publishEvent(_run: CaptureRun, event: CaptureRunEvent): Promise<void> {
		this.events.push(event);
	}

	async publishResult(_run: CaptureRun, result: { status: CaptureRunStatus; text: string }): Promise<void> {
		this.results.push(result);
	}

	async parseInboundMessage(): Promise<null> {
		return null;
	}
}

function setup() {
	const { store } = createTestStore();
	const runner = new FakeRunnerAdapter();
	const adapter = new RecordingAdapter();
	const orchestrator = new CaptureOrchestrator({ store, runner, maxScreenshotBytes: 1024 * 1024 });
	orchestrator.registerCollaborationAdapter(adapter);
	return { store, runner, adapter, orchestrator };
}

describe("CaptureOrchestrator", () => {
	it("creates a new session for a capture request and completes with a result", async () => {
		const { store, runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest());
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		const runId = submitted.value.id;

		await waitFor(() => runner.dispatches.length === 1);
		expect(runner.last.kind).toBe("create");
		runner.finish("Root cause: missing null check in gateway.ts.");

		await waitFor(() => store.getRun(runId)?.status === "completed");
		const run = store.getRun(runId);
		expect(run?.sessionId).toBe("session-1");
		expect(run?.sessionFile).toBe("/fake/sessions/s1.jsonl");
		expect(run?.resultSummary).toContain("missing null check");
	});

	it("resumes the selected existing session instead of creating a new one", async () => {
		const { runner, orchestrator, store } = setup();
		const first = await orchestrator.submitTask(baseRequest());
		if (!first.ok) throw new Error("submit failed");
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("done");
		await waitFor(() => store.getRun(first.value.id)?.status === "completed");

		const second = await orchestrator.submitTask(baseRequest({ routing: { sessionId: "session-1" } }));
		expect(second.ok).toBe(true);
		await waitFor(() => runner.dispatches.length === 2);
		expect(runner.last.kind).toBe("resume");
		expect(runner.last.session.sessionId).toBe("session-1");
		expect(runner.last.session.sessionFile).toBe("/fake/sessions/s1.jsonl");
		runner.finish("continued");
	});

	it("is idempotent on requestId", async () => {
		const { runner, orchestrator } = setup();
		const request = baseRequest();
		const first = await orchestrator.submitTask(request);
		const second = await orchestrator.submitTask(request);
		if (!first.ok || !second.ok) throw new Error("submit failed");
		expect(second.value.id).toBe(first.value.id);
		await waitFor(() => runner.dispatches.length === 1);
		await Bun.sleep(20);
		expect(runner.dispatches.length).toBe(1);
		expect(orchestrator.metrics.requestsDeduplicated).toBe(1);
		runner.finish("done");
	});

	it("preserves screenshot metadata and stores the asset", async () => {
		const { store, runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(
			baseRequest({ screenshot: { mimeType: "image/png", data: PNG_BASE64, width: 640, height: 480 } }),
		);
		if (!submitted.ok) throw new Error(submitted.error);
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("looked at it");
		await waitFor(() => store.getRun(submitted.value.id)?.status === "completed");

		const run = store.getRun(submitted.value.id);
		expect(run?.screenshotAssetId).toBeDefined();
		const asset = store.getAsset(run?.screenshotAssetId ?? "");
		expect(asset?.width).toBe(640);
		expect(asset?.height).toBe(480);
		expect(asset?.mimeType).toBe("image/png");

		// The agent turn received the screenshot as an attached image.
		const input = runner.dispatches[0]?.input as { images?: unknown[] };
		expect(input.images).toHaveLength(1);
	});

	it("rejects invalid requests", async () => {
		const { orchestrator } = setup();
		const result = await orchestrator.submitTask({ instruction: "no request id" });
		expect(result.ok).toBe(false);
	});

	it("routes to the requested runner and records it", async () => {
		const { store, runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest({ routing: { runnerId: "msi-windows-main" } }));
		if (!submitted.ok) throw new Error(submitted.error);
		await waitFor(() => runner.dispatches.length === 1);
		expect(store.getRun(submitted.value.id)?.runnerId).toBe("msi-windows-main");
		const input = runner.dispatches[0]?.input as { runnerId?: string };
		expect(input.runnerId).toBe("msi-windows-main");
		runner.finish("done");
	});

	it("resumes the same session for a follow-up after completion", async () => {
		const { store, runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		const runId = submitted.value.id;
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("first answer");
		await waitFor(() => store.getRun(runId)?.status === "completed");

		const followUp = await orchestrator.followUp(runId, {
			text: "Do the same for the mobile view.",
			source: "telegram",
			participant: "@teammate",
		});
		expect(followUp.accepted).toBe(true);
		await waitFor(() => runner.dispatches.length === 2);
		expect(runner.last.kind).toBe("resume");
		expect(runner.last.session.sessionId).toBe("session-1");
		const turn = runner.last.input as { message: string };
		expect(turn.message).toContain("Do the same for the mobile view.");
		expect(turn.message).toContain("@teammate");
		runner.finish("mobile view done");
		await waitFor(() => store.getRun(runId)?.status === "completed");
	});

	it("queues follow-ups that arrive while a turn is executing", async () => {
		const { store, runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		const runId = submitted.value.id;
		await waitFor(() => runner.dispatches.length === 1);

		// Two concurrent replies while the first turn is still running.
		const [a, b] = await Promise.all([
			orchestrator.followUp(runId, { text: "also check X", source: "telegram" }),
			orchestrator.followUp(runId, { text: "and Y", source: "telegram" }),
		]);
		expect(a.accepted).toBe(true);
		expect(b.accepted).toBe(true);
		expect(runner.dispatches.length).toBe(1);

		runner.finish("first done");
		await waitFor(() => runner.dispatches.length === 2);
		runner.finish("second done");
		await waitFor(() => runner.dispatches.length === 3);
		runner.finish("third done");
		await waitFor(() => store.getRun(runId)?.status === "completed");
	});

	it("deduplicates follow-ups by idempotency key", async () => {
		const { store, runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		const runId = submitted.value.id;
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("done");
		await waitFor(() => store.getRun(runId)?.status === "completed");

		const first = await orchestrator.followUp(runId, {
			text: "again",
			source: "telegram",
			idempotencyKey: "telegram:1",
		});
		expect(first.accepted).toBe(true);
		await waitFor(() => runner.dispatches.length === 2);
		const duplicate = await orchestrator.followUp(runId, {
			text: "again",
			source: "telegram",
			idempotencyKey: "telegram:1",
		});
		expect(duplicate.accepted).toBe(true);
		expect(duplicate.reason).toBe("duplicate");
		expect(runner.dispatches.length).toBe(2);
		runner.finish("done");
	});

	it("cancels an active run without deleting the session mapping", async () => {
		const { store, runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		const runId = submitted.value.id;
		await waitFor(() => runner.dispatches.length === 1);

		const cancelled = await orchestrator.cancel(runId, "@alice");
		expect(cancelled.accepted).toBe(true);
		await waitFor(() => store.getRun(runId)?.status === "cancelled");
		expect(runner.cancelled).toHaveLength(1);
		expect(store.getRun(runId)?.sessionId).toBe("session-1");
		expect(store.listAudit(runId).some(entry => entry.action === "task.cancelled")).toBe(true);
	});

	it("fails cleanly when no runner can be dispatched", async () => {
		const { store, runner, orchestrator } = setup();
		runner.failNextDispatch = new Error("runner offline");
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		await waitFor(() => store.getRun(submitted.value.id)?.status === "failed");
		expect(store.getRun(submitted.value.id)?.error).toContain("runner offline");
	});

	it("rejects follow-ups for runs without a persisted session", async () => {
		const { store, runner, orchestrator } = setup();
		runner.failNextDispatch = new Error("boom");
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		await waitFor(() => store.getRun(submitted.value.id)?.status === "failed");
		const result = await orchestrator.followUp(submitted.value.id, { text: "retry", source: "api" });
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain("no persisted session");
	});

	it("publishes task, progress, and sanitized results to collaboration adapters", async () => {
		const { store, runner, adapter, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		const runId = submitted.value.id;
		await waitFor(() => runner.dispatches.length === 1);
		runner.emit({ type: "agent_start" });
		runner.emit({ type: "tool_start", toolCallId: "t1", toolName: "bash" });
		runner.emit({ type: "text_delta", text: "Done. The token was sk-abcdef1234567890abcdef." });
		runner.emit({ type: "agent_end", hasError: false, session: runner.last.session });
		runner.last.channel.close();
		await waitFor(() => store.getRun(runId)?.status === "completed");

		expect(adapter.published).toHaveLength(1);
		// Root message mapping was persisted for reply routing.
		expect(store.getRun(runId)?.telegramRootMessageId).toBe("1");
		expect(adapter.events.some(event => event.type === "run.tool" && event.summary === "Running a command")).toBe(
			true,
		);
		expect(adapter.results).toHaveLength(1);
		expect(adapter.results[0]?.text).not.toContain("sk-abcdef1234567890abcdef");
		expect(adapter.results[0]?.text).toContain("[redacted]");
	});

	it("skips collaboration when the request opts out", async () => {
		const { store, runner, adapter, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest({ collaboration: { disabled: true } }));
		if (!submitted.ok) throw new Error(submitted.error);
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("quiet");
		await waitFor(() => store.getRun(submitted.value.id)?.status === "completed");
		expect(adapter.published).toHaveLength(0);
	});

	it("keeps concurrent capture tasks isolated", async () => {
		const { store, runner, orchestrator } = setup();
		const first = await orchestrator.submitTask(baseRequest());
		const second = await orchestrator.submitTask(baseRequest());
		if (!first.ok || !second.ok) throw new Error("submit failed");
		await waitFor(() => runner.dispatches.length === 2);

		// Start the first task, then finish only the second.
		runner.dispatches[0]?.channel.push({ type: "agent_start" });
		runner.finish("second result");
		await waitFor(() => store.getRun(second.value.id)?.status === "completed");
		await waitFor(() => store.getRun(first.value.id)?.status === "running");

		runner.dispatches[0]?.channel.push({
			type: "agent_end",
			hasError: false,
			session: runner.dispatches[0].session,
		});
		runner.dispatches[0]?.channel.close();
		await waitFor(() => store.getRun(first.value.id)?.status === "completed");
		expect(store.getRun(first.value.id)?.sessionId).toBe("session-1");
		expect(store.getRun(second.value.id)?.sessionId).toBe("session-2");
	});

	it("streams replayed and live events to subscribers", async () => {
		const { runner, orchestrator } = setup();
		const submitted = await orchestrator.submitTask(baseRequest());
		if (!submitted.ok) throw new Error(submitted.error);
		const runId = submitted.value.id;
		await waitFor(() => runner.dispatches.length === 1);

		const seen: string[] = [];
		const abort = new AbortController();
		const consume = (async () => {
			for await (const event of orchestrator.subscribeEvents(runId, abort.signal)) {
				seen.push(event.type === "run.status" ? `status:${event.status}` : event.type);
				if (event.type === "run.status" && event.status === "completed") break;
			}
		})();
		runner.finish("streamed answer");
		await consume;
		expect(seen).toContain("status:starting");
		expect(seen).toContain("run.result");
		expect(seen[seen.length - 1]).toBe("status:completed");
		abort.abort();
	});
});
