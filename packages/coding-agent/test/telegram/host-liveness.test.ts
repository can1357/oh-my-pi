/**
 * Second-writer protection at the routing level: a topic whose session file is
 * held elsewhere refuses to raise, an unreadable presence refuses too, and the
 * hosting process's own live session keeps its file.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { bridgeHarness, fakeSession, message, update, type BridgeHarness } from "./host-fixtures";

const live: BridgeHarness[] = [];

function harness(): BridgeHarness {
	const made = bridgeHarness();
	live.push(made);
	return made;
}

afterEach(async () => {
	for (const made of live.splice(0)) {
		await made.host.stop();
		made.cleanup();
	}
});

const FILE = "/sessions/live.jsonl";

const presence = (overrides: Record<string, unknown> = {}) => ({
	pid: 37122,
	kind: "interactive" as const,
	sessionId: "abc123",
	sessionFile: FILE,
	cwd: "/work",
	sessionName: null,
	startedAt: 0,
	updatedAt: 0,
	...overrides,
});

/** Seeds a topic bound to FILE and closes it, so no runtime holds it locally. */
async function closedTopic(h: BridgeHarness): Promise<void> {
	h.queue(fakeSession({ file: FILE }));
	await h.host.handleUpdate(update({ message: message({ text: "/new Fox" }) }));
	await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }));
}

describe("second writer", () => {
	it("refuses a file a foreign process holds, naming the pid", async () => {
		const h = harness();
		await closedTopic(h);
		h.presence = [presence()];
		const before = h.requests.length;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "continue" }) }))).toBe(
			"busy_session",
		);
		expect(h.requests).toHaveLength(before);
		const refusal = h.api.threadTexts(900).at(-1) ?? "";
		expect(refusal).toContain("(pid 37122)");
		expect(refusal).toContain("second writer");
	});

	it("refuses to raise blindly when presence cannot be read", async () => {
		const h = harness();
		await closedTopic(h);
		h.breakPresence = true;
		const before = h.requests.length;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "continue" }) }))).toBe(
			"unknown_liveness",
		);
		expect(h.requests).toHaveLength(before);
		expect(h.api.threadTexts(900).at(-1) ?? "").toContain("Could not determine whether this session is live");
	});

	it("keeps a session live in this process from being raised a second time", async () => {
		const h = harness();
		await closedTopic(h);
		h.presence = [presence({ pid: process.pid, kind: "interactive" })];
		const before = h.requests.length;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "continue" }) }))).toBe(
			"busy_session",
		);
		expect(h.requests).toHaveLength(before);
		expect(h.api.threadTexts(900).at(-1) ?? "").toContain("already open in this omp process");
	});

	it("does not mistake a stale telegram-kind record for a live holder", async () => {
		const h = harness();
		await closedTopic(h);
		h.presence = [presence({ pid: process.pid, kind: "telegram" })];
		h.queue(fakeSession({ file: FILE }));
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "continue" }) }))).toBe(
			"prompt",
		);
	});
});
