#!/usr/bin/env bun
/**
 * Test fixture: cold-module-cache child for the cross-process Now-stamp resume
 * test (`test/date-cwd-reminder.test.ts`). Spawned twice as two separate bun
 * processes — `orig` (the original session's last request: [firstTurn,
 * assistant]) and `resumed` (a resumed session's first request: [firstTurn',
 * assistant, newTurn], with fresh object identities as buildSessionContext
 * produces from the session store) — and prints the transformed context's
 * wire bytes as JSON. The parent compares the two processes' outputs to prove
 * the resume re-stamp is a byte no-op with an empty module cache. A third
 * mode, `format`, prints just the rendered stamp for the parent to assert
 * the semantic structure of the local part under a pinned host TZ.
 *
 * Deterministic fixture: the stamp's parenthesized local part renders per
 * host (timezone/locale/ICU), so the parent pins TZ for both children and
 * the test compares bytes *between* the processes, not against a golden.
 */
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { applyNowStamp, renderNowStamp } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";

const T1 = Date.parse("2026-08-30T02:51:16Z");
const T2 = Date.parse("2026-08-30T03:12:45Z");

const assistant: Message = {
	role: "assistant",
	content: [{ type: "text", text: "hi" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: T1 + 1,
};

// Fresh objects on every launch: new identity, identical persisted content
// and timestamp — exactly what a resumed session rehydrates.
const firstTurn: Message = { role: "user", content: "first turn", timestamp: T1 };
const newTurn: Message = {
	role: "user",
	content: [
		{ type: "text", text: "new turn after resume" },
		{ type: "image", data: "imgB", mimeType: "image/png" },
	],
	timestamp: T2,
};

const mode = process.argv[2];
if (mode === "format") {
	// Prints the stamp rendered in THIS process's timezone (the parent pins
	// TZ per spawn) so the parent can assert the semantic structure of the
	// parenthesized local part for a host zone whose short Intl label is
	// numeric (e.g. `GMT+5:30` under TZ=Asia/Kolkata).
	console.log(JSON.stringify(renderNowStamp(new Date(T1))));
} else {
	const messages: Message[] = mode === "orig" ? [firstTurn, assistant] : [firstTurn, assistant, newTurn];
	const context: Context = { systemPrompt: ["SYSTEM"], messages };
	const stamped = applyNowStamp(context);
	console.log(
		JSON.stringify([
			JSON.stringify(stamped.systemPrompt),
			...stamped.messages.map(message => JSON.stringify(message.content)),
		]),
	);
}
