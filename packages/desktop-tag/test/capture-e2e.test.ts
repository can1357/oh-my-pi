/**
 * End-to-end capture workflow test with a fake Telegram transport and a fake
 * runner: desktop capture request → run → Telegram root message → progress →
 * result → teammate reply → same-session resume → restart survival.
 */
import { describe, expect, it } from "bun:test";

import type { TelegramCaptureConfig } from "../src/capture/config";
import { CaptureHttpRouter } from "../src/capture/http";
import { CaptureOrchestrator } from "../src/capture/orchestrator";
import { CaptureStore } from "../src/capture/store";
import { TelegramBridge } from "../src/capture/telegram";
import {
	baseRequest,
	FakeRunnerAdapter,
	FakeTelegramTransport,
	PNG_BASE64,
	tempDataDir,
	waitFor,
} from "./helpers/capture-fakes";

const TELEGRAM_CONFIG: TelegramCaptureConfig = {
	enabled: true,
	botToken: "12345:token",
	webhookSecret: "hook-secret",
	allowedChatIds: new Set(["-100"]),
	allowedUserIds: new Set(),
	defaultChatId: "-100",
	longPollEnabled: false,
};

function buildStack(dataDir: string, transport = new FakeTelegramTransport(), runner = new FakeRunnerAdapter()) {
	const store = new CaptureStore({ dataDir });
	const bridge = new TelegramBridge({ config: TELEGRAM_CONFIG, store, transport });
	const orchestrator = new CaptureOrchestrator({ store, runner });
	bridge.bindOrchestrator(orchestrator);
	orchestrator.registerCollaborationAdapter(bridge);
	const router = new CaptureHttpRouter({ orchestrator, telegram: bridge });
	return { store, bridge, orchestrator, router, transport, runner };
}

function webhook(update: Record<string, unknown>): Request {
	return new Request("http://127.0.0.1:18087/api/capture/telegram/webhook", {
		method: "POST",
		headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
		body: JSON.stringify(update),
	});
}

describe("capture-to-agent end to end", () => {
	it("runs the full acceptance workflow across a gateway restart", async () => {
		const dataDir = tempDataDir("capture-e2e-");
		const transport = new FakeTelegramTransport();
		const runner = new FakeRunnerAdapter();
		const stack = buildStack(dataDir, transport, runner);

		// 1-4. User captures a region and submits an instruction routed to a runner + Telegram.
		const submitResponse = await stack.router.handle(
			new Request("http://127.0.0.1:18087/api/capture/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					baseRequest({
						instruction:
							"Find the source of this error, fix it in the current repository, and run the relevant tests.",
						screenshot: { mimeType: "image/png", data: PNG_BASE64 },
						routing: { runnerId: "msi-windows-main" },
						collaboration: { telegramChatId: "-100" },
						submittedBy: "pk",
					}),
				),
			}),
			"/api/capture/tasks",
		);
		expect(submitResponse?.status).toBe(202);
		const { task } = (await submitResponse?.json()) as { task: { id: string } };

		// 5. The task appears in Telegram with a screenshot preview.
		await waitFor(() => transport.callsOf("sendMessage").length >= 1);
		const root = transport.callsOf("sendMessage")[0];
		expect(String(root?.payload.text)).toContain("Find the source of this error");
		expect(String(root?.payload.text)).toContain("Runner: msi-windows-main");
		expect(transport.callsOf("sendPhoto")).toHaveLength(1);
		await waitFor(() => stack.store.getRun(task.id)?.telegramRootMessageId !== undefined);
		const rootMessageId = stack.store.getRun(task.id)?.telegramRootMessageId;

		// 6-7. The agent works inside the selected runner; progress reaches Telegram.
		await waitFor(() => runner.dispatches.length === 1);
		runner.emit({ type: "agent_start" });
		runner.emit({ type: "tool_start", toolCallId: "t1", toolName: "read" });
		runner.emit({ type: "tool_start", toolCallId: "t2", toolName: "bash" });

		// 8. The agent posts its result (with a secret that must never reach Telegram).
		runner.emit({
			type: "text_delta",
			text: "Fixed the null check. Tests pass. (internal: OPENAI_KEY=sk-abcdef1234567890abcdef)",
		});
		runner.emit({ type: "agent_end", hasError: false, session: runner.last.session });
		runner.last.channel.close();
		await waitFor(() => stack.store.getRun(task.id)?.status === "completed");

		const resultMessages = transport.callsOf("sendMessage").slice(1);
		const resultText = resultMessages.map(call => String(call.payload.text)).join("\n");
		expect(resultText).toContain("Fixed the null check");
		expect(resultText).not.toContain("sk-abcdef1234567890abcdef");

		// Simulate a full gateway restart: fresh store/orchestrator/bridge over the same data dir.
		stack.store.close();
		const restarted = buildStack(dataDir, transport, runner);

		// 9-10. A teammate replies to the root message; the same session resumes.
		const replyOutcome = await restarted.bridge.handleWebhookRequest(
			webhook({
				update_id: 5001,
				message: {
					message_id: 700,
					chat: { id: -100 },
					from: { id: 8, username: "teammate" },
					reply_to_message: { message_id: Number(rootMessageId) },
					text: "Also add a regression test and explain why the original test suite missed it.",
				},
			}),
		);
		expect(replyOutcome.status).toBe(200);
		await waitFor(() => runner.dispatches.length === 2);

		// 11. The same runner session continues (same session mapping).
		expect(runner.last.kind).toBe("resume");
		expect(runner.last.session.sessionId).toBe("session-1");
		expect(runner.last.session.sessionFile).toBe("/fake/sessions/s1.jsonl");
		const turn = runner.last.input as { message: string };
		expect(turn.message).toContain("regression test");
		expect(turn.message).toContain("@teammate");

		// 12. The final response lands in the same Telegram thread.
		const priorSends = transport.callsOf("sendMessage").length;
		runner.finish("Added regression test; the suite missed it because the fixture stubbed the gateway.");
		await waitFor(() => restarted.store.getRun(task.id)?.status === "completed");
		await waitFor(() => transport.callsOf("sendMessage").length > priorSends);
		const finalText = String(transport.callsOf("sendMessage").at(-1)?.payload.text);
		expect(finalText).toContain("regression test");

		// Duplicate webhook delivery does not create a duplicate turn.
		await restarted.bridge.handleWebhookRequest(
			webhook({
				update_id: 5001,
				message: {
					message_id: 700,
					chat: { id: -100 },
					from: { id: 8, username: "teammate" },
					reply_to_message: { message_id: Number(rootMessageId) },
					text: "Also add a regression test and explain why the original test suite missed it.",
				},
			}),
		);
		await Bun.sleep(20);
		expect(runner.dispatches.length).toBe(2);
		restarted.store.close();
	});

	it("keeps working locally when Telegram delivery fails", async () => {
		const dataDir = tempDataDir("capture-e2e-offline-");
		const transport = new FakeTelegramTransport();
		transport.failOnce.set("sendMessage", "telegram unreachable");
		const runner = new FakeRunnerAdapter();
		const stack = buildStack(dataDir, transport, runner);

		const submitted = await stack.orchestrator.submitTask(baseRequest({ collaboration: { telegramChatId: "-100" } }));
		if (!submitted.ok) throw new Error(submitted.error);
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("finished without telegram");
		await waitFor(() => stack.store.getRun(submitted.value.id)?.status === "completed");
		expect(stack.store.getRun(submitted.value.id)?.resultSummary).toContain("finished without telegram");
		expect(stack.orchestrator.metrics.collaborationDeliveryFailures).toBeGreaterThan(0);
		stack.store.close();
	});

	it("cancelling from Telegram stops the active run and keeps the session", async () => {
		const dataDir = tempDataDir("capture-e2e-cancel-");
		const transport = new FakeTelegramTransport();
		const runner = new FakeRunnerAdapter();
		const stack = buildStack(dataDir, transport, runner);

		const submitted = await stack.orchestrator.submitTask(baseRequest({ collaboration: { telegramChatId: "-100" } }));
		if (!submitted.ok) throw new Error(submitted.error);
		await waitFor(() => runner.dispatches.length === 1);

		const response = await stack.bridge.handleWebhookRequest(
			webhook({
				update_id: 6001,
				message: { message_id: 800, chat: { id: -100 }, from: { id: 7 }, text: "/stop" },
			}),
		);
		expect(response.status).toBe(200);
		await waitFor(() => stack.store.getRun(submitted.value.id)?.status === "cancelled");
		expect(runner.cancelled).toHaveLength(1);
		expect(stack.store.getRun(submitted.value.id)?.sessionId).toBe("session-1");
		stack.store.close();
	});
});
