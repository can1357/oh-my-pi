import { describe, expect, test } from "bun:test";
import {
	buildDelegationContextAppend,
	buildLiveSessionPayload,
	buildSessionClose,
	buildSessionContextAppend,
	CONTEXT_CHUNK_BYTES,
	chunkLiveContext,
	LIVE_MODEL,
	parseLiveServerEvent,
} from "../../src/live/protocol";

describe("Frameless Bidi server events", () => {
	test("parses a client delegation and keeps only input text content", () => {
		const event = parseLiveServerEvent(
			JSON.stringify({
				type: "delegation.created",
				item: {
					type: "delegation",
					target: "client",
					id: "delegation-7",
					content: [
						{ type: "input_text", text: "Inspect the failing build. " },
						{ type: "output_text", text: "ignored" },
						{ type: "input_text", text: "Repair the root cause." },
					],
				},
			}),
		);

		expect(event).toEqual({
			type: "delegation.created",
			item: {
				type: "delegation",
				target: "client",
				id: "delegation-7",
				content: [
					{ type: "input_text", text: "Inspect the failing build. " },
					{ type: "input_text", text: "Repair the root cause." },
				],
			},
		});
	});

	test("parses input and output transcript deltas", () => {
		expect(parseLiveServerEvent({ type: "input_transcript.added", item: { text: "What changed?" } })).toEqual({
			type: "input_transcript.added",
			item: { text: "What changed?" },
		});
		expect(parseLiveServerEvent({ type: "output_transcript.added", item: { text: "I will inspect it." } })).toEqual({
			type: "output_transcript.added",
			item: { text: "I will inspect it." },
		});
	});

	test("parses completed user and assistant turns", () => {
		expect(
			parseLiveServerEvent({ type: "turn.done", turn: { role: "user", transcript: "Run the checks." } }),
		).toEqual({ type: "turn.done", turn: { role: "user", transcript: "Run the checks." } });
		expect(
			parseLiveServerEvent({
				type: "turn.done",
				turn: { role: "assistant", transcript: "The checks pass." },
			}),
		).toEqual({ type: "turn.done", turn: { role: "assistant", transcript: "The checks pass." } });
	});

	test("parses an output audio delta", () => {
		expect(parseLiveServerEvent('{"type":"output_audio.delta","audio":"AAECAw=="}')).toEqual({
			type: "output_audio.delta",
			audio: "AAECAw==",
		});
	});

	test("extracts top-level and nested error messages", () => {
		expect(parseLiveServerEvent({ type: "error", message: "call expired" })).toEqual({
			type: "error",
			message: "call expired",
		});
		expect(parseLiveServerEvent({ type: "error", error: { message: "media rejected", code: "bad_media" } })).toEqual({
			type: "error",
			message: "media rejected",
		});
	});

	test("classifies unsupported events and rejects malformed known events", () => {
		expect(parseLiveServerEvent({ type: "rate_limits.updated", remaining: 3 })).toEqual({
			type: "unknown",
			wireType: "rate_limits.updated",
		});
		expect(parseLiveServerEvent({ type: "output_audio.delta", audio: 12 })).toBeNull();
		expect(parseLiveServerEvent({ type: "turn.done", turn: { role: "tool", transcript: "no" } })).toBeNull();
		expect(parseLiveServerEvent("not json")).toBeNull();
	});
});

describe("Frameless Bidi client payloads", () => {
	test("builds the exact live call session JSON", () => {
		const payload = buildLiveSessionPayload("Be concise.", "marin");

		expect(LIVE_MODEL).toBe("gpt-live-1-codex");
		expect(JSON.stringify(payload)).toBe(
			'{"model":"gpt-live-1-codex","instructions":"Be concise.","audio":{"output":{"voice":"marin"}},"delegation":{"type":"client"}}',
		);
	});

	test("builds the exact delegation context JSON", () => {
		const message = buildDelegationContextAppend("delegation-7", "The tests now pass.", "commentary");

		expect(JSON.stringify(message)).toBe(
			'{"type":"delegation.context.append","delegation_item_id":"delegation-7","channel":"commentary","content":[{"type":"input_text","text":"The tests now pass."}]}',
		);
	});

	test("omits optional channels and builds session close", () => {
		expect(buildDelegationContextAppend("delegation-8", "Done.")).toEqual({
			type: "delegation.context.append",
			delegation_item_id: "delegation-8",
			content: [{ type: "input_text", text: "Done." }],
		});
		expect(buildSessionContextAppend("Still investigating.", "speakable")).toEqual({
			type: "session.context.append",
			channel: "speakable",
			content: [{ type: "input_text", text: "Still investigating." }],
		});
		expect(buildSessionClose()).toEqual({ type: "session.close" });
	});
});

test("context chunks are UTF-8 safe, bounded, and perfectly reassemble", () => {
	const text = `${"a".repeat(497)}🙂${"é漢🙂".repeat(180)}`;
	const chunks = chunkLiveContext(text);
	const encoder = new TextEncoder();

	expect(chunks.length).toBeGreaterThan(1);
	expect(chunks.join("")).toBe(text);
	for (const chunk of chunks) {
		expect(encoder.encode(chunk).byteLength).toBeLessThanOrEqual(CONTEXT_CHUNK_BYTES);
	}
});
