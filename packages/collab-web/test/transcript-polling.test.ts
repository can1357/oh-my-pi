/**
 * Regression: the host replies to fetch-transcript with a terminal `error`
 * frame (unchanged cursor) for oversized JSONL rows and missing files. The
 * client must surface that error distinctly from a transient failure (null),
 * and the drawer's polling decision must stop on it instead of hot-retrying
 * from the same cursor forever.
 */
import { describe, expect, it, vi } from "bun:test";
import type { HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";
import { decideTranscriptPoll } from "../src/lib/transcript-poll";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

function transcriptFrame(reqId: number, text: string, newSize: number, error?: string): HostFrame {
	return { t: "transcript", reqId, text, newSize, error };
}

function messageEntry(id: string, content: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:01Z",
		message: { role: "user", content, timestamp },
	};
}

describe("GuestClient.fetchTranscript", () => {
	it("surfaces a frame-level error as a typed terminal result, not null", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscript("agent-1", 128);
		client.applyFrameForTest(transcriptFrame(1, "", 128, "transcript entry exceeds transcript fetch cap"));
		const result = await promise;
		expect(result).toEqual({ kind: "error", message: "transcript entry exceeds transcript fetch cap" });
	});

	it("resolves rows for a successful reply", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscript("agent-1", 0);
		client.applyFrameForTest(transcriptFrame(1, '{"type":"message"}\n', 19));
		const result = await promise;
		expect(result).toEqual({ kind: "rows", text: '{"type":"message"}\n', newSize: 19 });
	});

	it("resolves null (transient) on timeout — distinct from a terminal error", async () => {
		vi.useFakeTimers();
		try {
			const client = new GuestClient(LINK, "tester");
			const promise = client.fetchTranscript("agent-1", 0);
			vi.advanceTimersByTime(10_000);
			expect(await promise).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves null (transient) when the session ends mid-fetch", async () => {
		const client = new GuestClient(LINK, "tester");
		const promise = client.fetchTranscript("agent-1", 0);
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		expect(await promise).toBeNull();
	});

	it("keeps late replies from resolving a timed-out request with stale data", async () => {
		vi.useFakeTimers();
		try {
			const client = new GuestClient(LINK, "tester");
			const first = client.fetchTranscript("agent-1", 0);
			vi.advanceTimersByTime(10_000);
			expect(await first).toBeNull();
			// Late frame for the expired reqId must not throw or leak.
			client.applyFrameForTest(transcriptFrame(1, "late", 4));
			const second = client.fetchTranscript("agent-1", 0);
			client.applyFrameForTest(transcriptFrame(2, "", 0, "no transcript available"));
			expect(await second).toEqual({ kind: "error", message: "no transcript available" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("decideTranscriptPoll", () => {
	it("retries on transient failure (null) without touching the cursor", () => {
		expect(decideTranscriptPoll(null, "")).toEqual({ action: "retry" });
	});

	it("stops on a terminal frame error and carries the message to render", () => {
		const decision = decideTranscriptPoll(
			{ kind: "error", message: "transcript entry exceeds transcript fetch cap (4194304 bytes)" },
			"partial-line",
		);
		expect(decision).toEqual({
			action: "stop",
			message: "transcript entry exceeds transcript fetch cap (4194304 bytes)",
		});
	});

	it("advances the cursor and parses complete rows, filtering the session header", () => {
		const entry = messageEntry("m1", "hi", 1);
		const rows = `{"type":"session","id":"s1"}\n${JSON.stringify(entry)}\n`;
		const text = `${rows}{"type":"mes`;
		const decision = decideTranscriptPoll({ kind: "rows", text, newSize: text.length }, "");
		expect(decision).toEqual({
			action: "advance",
			newSize: text.length,
			carry: '{"type":"mes',
			fresh: [entry],
		});
	});

	it("completes a carried partial line on the next advance", () => {
		const entry = messageEntry("m2", "again", 2);
		const line = `${JSON.stringify(entry)}\n`;
		const splitAt = 12;
		const decision = decideTranscriptPoll(
			{ kind: "rows", text: line.slice(splitAt), newSize: 100 },
			line.slice(0, splitAt),
		);
		expect(decision).toEqual({
			action: "advance",
			newSize: 100,
			carry: "",
			fresh: [entry],
		});
	});

	it("surfaces the error after rows were already read (rows then error sequence)", () => {
		// First poll returns rows; second returns the host's terminal error with
		// an unchanged cursor. The error decision must be stop — never retry —
		// while the prior advance already delivered its entries.
		const first = decideTranscriptPoll({ kind: "rows", text: '{"type":"message","id":"m1"}\n', newSize: 29 }, "");
		expect(first.action).toBe("advance");
		const second = decideTranscriptPoll(
			{ kind: "error", message: "transcript entry exceeds transcript fetch cap (4194304 bytes)" },
			first.action === "advance" ? first.carry : "",
		);
		expect(second).toEqual({
			action: "stop",
			message: "transcript entry exceeds transcript fetch cap (4194304 bytes)",
		});
	});
});
