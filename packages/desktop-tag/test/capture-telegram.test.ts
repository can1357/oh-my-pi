import { describe, expect, it } from "bun:test";

import type { TelegramCaptureConfig } from "../src/capture/config";
import type { FollowUpInput, FollowUpResult } from "../src/capture/orchestrator";
import { type CaptureDispatcher, TelegramBridge, timingSafeEqualString } from "../src/capture/telegram";
import type { CaptureRun, ParseResult } from "../src/capture/types";
import { createTestStore, FakeTelegramTransport } from "./helpers/capture-fakes";

function config(overrides: Partial<TelegramCaptureConfig> = {}): TelegramCaptureConfig {
	return {
		enabled: true,
		botToken: "12345:token",
		webhookSecret: "hook-secret",
		allowedChatIds: new Set(["-100"]),
		allowedUserIds: new Set(),
		longPollEnabled: false,
		...overrides,
	};
}

function sampleRun(overrides: Partial<CaptureRun> = {}): CaptureRun {
	const now = "2026-07-11T00:00:00.000Z";
	return {
		id: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		instruction: "Investigate this error",
		sourceType: "screen-region",
		status: "starting",
		runnerId: "msi-windows-main",
		sessionId: "8f31a2ff-0000-0000-0000-000000000000",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

class FakeDispatcher implements CaptureDispatcher {
	readonly followUps: Array<{ runId: string; input: FollowUpInput }> = [];
	readonly cancels: string[] = [];
	readonly submitted: unknown[] = [];
	followUpResult: FollowUpResult = { accepted: true };

	async followUp(runId: string, input: FollowUpInput): Promise<FollowUpResult> {
		this.followUps.push({ runId, input });
		return this.followUpResult;
	}

	async cancel(runId: string): Promise<FollowUpResult> {
		this.cancels.push(runId);
		return { accepted: true };
	}

	async submitTask(rawRequest: unknown): Promise<ParseResult<CaptureRun>> {
		this.submitted.push(rawRequest);
		return { ok: true, value: sampleRun() };
	}
}

function setup(configOverrides: Partial<TelegramCaptureConfig> = {}) {
	const { store } = createTestStore();
	const transport = new FakeTelegramTransport();
	const dispatcher = new FakeDispatcher();
	const bridge = new TelegramBridge({ config: config(configOverrides), store, transport });
	bridge.bindOrchestrator(dispatcher);
	return { store, transport, dispatcher, bridge };
}

function messageUpdate(overrides: Record<string, unknown> = {}, updateId = 1): Record<string, unknown> {
	return {
		update_id: updateId,
		message: {
			message_id: 500,
			chat: { id: -100 },
			from: { id: 7, username: "alice" },
			text: "Also add a regression test.",
			...overrides,
		},
	};
}

describe("TelegramBridge outbound", () => {
	it("posts a root task message with instruction, runner, session, and status", async () => {
		const { transport, bridge } = setup();
		const run = sampleRun({ telegramChatId: "-100" });
		const ref = await bridge.publishTask(run);
		expect(ref?.channelId).toBe("-100");
		const sent = transport.callsOf("sendMessage");
		expect(sent).toHaveLength(1);
		const text = String(sent[0]?.payload.text);
		expect(text).toContain("Investigate this error");
		expect(text).toContain("Runner: msi-windows-main");
		expect(text).toContain("Session: capture-8f31a2");
		expect(text).toContain("Status: Starting");
	});

	it("falls back to the default chat and attaches a screenshot preview", async () => {
		const { transport, bridge } = setup({ defaultChatId: "-100" });
		const run = sampleRun();
		const ref = await bridge.publishTask(run, { bytes: new Uint8Array([1]), mimeType: "image/png" });
		expect(ref?.channelId).toBe("-100");
		expect(transport.callsOf("sendPhoto")).toHaveLength(1);
	});

	it("skips publication when no chat is configured", async () => {
		const { transport, bridge } = setup();
		const ref = await bridge.publishTask(sampleRun());
		expect(ref).toBeUndefined();
		expect(transport.calls).toHaveLength(0);
	});

	it("edits the root message on status changes and posts the result as a reply", async () => {
		const { store, transport, bridge } = setup();
		let run = sampleRun({ telegramChatId: "-100" });
		store.createRun(run.requestId, undefined, run);
		const ref = await bridge.publishTask(run);
		run = { ...run, telegramRootMessageId: ref?.messageId, status: "completed" };

		await bridge.publishEvent(run, { type: "run.status", runId: run.id, status: "completed" });
		const edits = transport.callsOf("editMessageText");
		expect(edits).toHaveLength(1);
		expect(String(edits[0]?.payload.text)).toContain("Completed");

		await bridge.publishResult(run, { status: "completed", text: "Fixed and verified with tests." });
		const replies = transport.callsOf("sendMessage");
		expect(String(replies[replies.length - 1]?.payload.text)).toContain("Fixed and verified");
		expect(replies[replies.length - 1]?.payload.reply_to_message_id).toBe(Number(ref?.messageId));
		// The reply is recorded so replies-to-it resolve back to the run.
		expect(store.findRunIdByCollabMessage("telegram", "-100", String(transport.lastMessageId))).toBe(run.id);
	});
});

describe("TelegramBridge inbound", () => {
	it("rejects updates from chats outside the allowlist", async () => {
		const { bridge, dispatcher } = setup();
		const outcome = await bridge.handleUpdate(messageUpdate({ chat: { id: -999 } }));
		expect(outcome.kind).toBe("unauthorized");
		expect(dispatcher.followUps).toHaveLength(0);
	});

	it("rejects users outside the user allowlist in an allowed chat", async () => {
		const { bridge, dispatcher, transport } = setup({ allowedUserIds: new Set(["42"]) });
		const outcome = await bridge.handleUpdate(messageUpdate());
		expect(outcome.kind).toBe("unauthorized");
		expect(dispatcher.followUps).toHaveLength(0);
		const sent = transport.callsOf("sendMessage");
		expect(String(sent[0]?.payload.text)).toContain("not authorized");
	});

	it("deduplicates updates by update_id", async () => {
		const { store, bridge, dispatcher } = setup();
		const run = sampleRun({ telegramChatId: "-100" });
		store.createRun(run.requestId, undefined, run);
		const first = await bridge.handleUpdate(messageUpdate({}, 900));
		const second = await bridge.handleUpdate(messageUpdate({}, 900));
		expect(first.kind).toBe("follow_up");
		expect(second.kind).toBe("duplicate");
		expect(dispatcher.followUps).toHaveLength(1);
	});

	it("routes a reply to the root message into the mapped run's session", async () => {
		const { store, bridge, dispatcher } = setup();
		const runA = sampleRun({ telegramChatId: "-100" });
		const runB = sampleRun({ telegramChatId: "-100", createdAt: "2026-07-12T00:00:00.000Z" });
		store.createRun(runA.requestId, undefined, runA);
		store.createRun(runB.requestId, undefined, runB);
		store.recordCollabMessage("telegram", "-100", "321", runA.id, "root");

		const outcome = await bridge.handleUpdate(messageUpdate({ reply_to_message: { message_id: 321 } }, 901));
		expect(outcome).toEqual({ kind: "follow_up", runId: runA.id });
		expect(dispatcher.followUps[0]?.runId).toBe(runA.id);
		expect(dispatcher.followUps[0]?.input.idempotencyKey).toBe("telegram:901");
		expect(dispatcher.followUps[0]?.input.participant).toBe("@alice");
	});

	it("does not hijack the latest run for a reply to an unmapped message", async () => {
		const { store, bridge, dispatcher } = setup();
		const run = sampleRun({ telegramChatId: "-100" });
		store.createRun(run.requestId, undefined, run);
		// Reply targets message 999, which was never recorded as a bot message.
		const outcome = await bridge.handleUpdate(messageUpdate({ reply_to_message: { message_id: 999 } }, 905));
		expect(outcome.kind).toBe("ignored");
		expect(dispatcher.followUps).toHaveLength(0);
	});

	it("falls back to the latest run in the chat/topic when not replying", async () => {
		const { store, bridge, dispatcher } = setup();
		const older = sampleRun({ telegramChatId: "-100", createdAt: "2026-07-01T00:00:00.000Z" });
		const newer = sampleRun({ telegramChatId: "-100", createdAt: "2026-07-10T00:00:00.000Z" });
		store.createRun(older.requestId, undefined, older);
		store.createRun(newer.requestId, undefined, newer);
		await bridge.handleUpdate(messageUpdate({}, 902));
		expect(dispatcher.followUps[0]?.runId).toBe(newer.id);
	});

	it("downloads photo attachments and forwards them as images", async () => {
		const { store, bridge, dispatcher, transport } = setup();
		const run = sampleRun({ telegramChatId: "-100" });
		store.createRun(run.requestId, undefined, run);
		transport.files.set("files/photo-1", new Uint8Array([9, 9, 9]));
		await bridge.handleUpdate(
			messageUpdate(
				{ photo: [{ file_id: "photo-0" }, { file_id: "photo-1" }], text: undefined, caption: "see this" },
				903,
			),
		);
		const followUp = dispatcher.followUps[0];
		expect(followUp?.input.images).toHaveLength(1);
		expect(followUp?.input.images?.[0]?.mimeType).toBe("image/jpeg");
	});

	it("handles /status, /session, /stop, and /new commands", async () => {
		const { store, bridge, dispatcher, transport } = setup();
		const run = sampleRun({ telegramChatId: "-100", status: "running" });
		store.createRun(run.requestId, undefined, run);

		await bridge.handleUpdate(messageUpdate({ text: "/status" }, 910));
		expect(String(transport.callsOf("sendMessage")[0]?.payload.text)).toContain("Status: Running");

		await bridge.handleUpdate(messageUpdate({ text: "/session" }, 911));
		expect(String(transport.callsOf("sendMessage")[1]?.payload.text)).toContain("Session: capture-8f31a2");

		await bridge.handleUpdate(messageUpdate({ text: "/stop" }, 912));
		expect(dispatcher.cancels).toEqual([run.id]);

		await bridge.handleUpdate(messageUpdate({ text: "/new Fix the flaky login test" }, 913));
		expect(dispatcher.submitted).toHaveLength(1);
		const submitted = dispatcher.submitted[0] as { instruction: string; collaboration: { telegramChatId: string } };
		expect(submitted.instruction).toBe("Fix the flaky login test");
		expect(submitted.collaboration.telegramChatId).toBe("-100");
	});

	it("handles /resume by sending a continuation follow-up", async () => {
		const { store, bridge, dispatcher } = setup();
		const run = sampleRun({ telegramChatId: "-100", status: "completed" });
		store.createRun(run.requestId, undefined, run);
		await bridge.handleUpdate(messageUpdate({ text: "/resume" }, 914));
		expect(dispatcher.followUps[0]?.runId).toBe(run.id);
		expect(dispatcher.followUps[0]?.input.text).toContain("Continue");
	});

	it("refuses the webhook route entirely when no secret is configured", async () => {
		const { bridge } = setup({ webhookSecret: undefined });
		const request = new Request("http://127.0.0.1/api/capture/telegram/webhook", {
			method: "POST",
			body: JSON.stringify(messageUpdate({}, 940)),
		});
		const response = await bridge.handleWebhookRequest(request);
		expect(response.status).toBe(404);
	});

	it("validates the webhook secret token", async () => {
		const { bridge } = setup();
		const badRequest = new Request("http://127.0.0.1/api/capture/telegram/webhook", {
			method: "POST",
			headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
			body: JSON.stringify(messageUpdate({}, 920)),
		});
		expect((await bridge.handleWebhookRequest(badRequest)).status).toBe(403);

		const goodRequest = new Request("http://127.0.0.1/api/capture/telegram/webhook", {
			method: "POST",
			headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
			body: JSON.stringify(messageUpdate({}, 920)),
		});
		expect((await bridge.handleWebhookRequest(goodRequest)).status).toBe(200);
	});

	it("reports rejection reasons back to the chat when a follow-up cannot resume", async () => {
		const { store, bridge, dispatcher, transport } = setup();
		const run = sampleRun({ telegramChatId: "-100" });
		store.createRun(run.requestId, undefined, run);
		dispatcher.followUpResult = { accepted: false, reason: "This task has no persisted session to resume." };
		const outcome = await bridge.handleUpdate(messageUpdate({}, 930));
		expect(outcome.kind).toBe("error");
		expect(String(transport.callsOf("sendMessage")[0]?.payload.text)).toContain("no persisted session");
	});
});

describe("timingSafeEqualString", () => {
	it("compares strings without early exit", () => {
		expect(timingSafeEqualString("secret", "secret")).toBe(true);
		expect(timingSafeEqualString("secret", "secreT")).toBe(false);
		expect(timingSafeEqualString("", "secret")).toBe(false);
		expect(timingSafeEqualString("secret", "")).toBe(false);
	});
});
