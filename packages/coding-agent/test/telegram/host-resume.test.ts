/**
 * `/resume`: resolving a session across directories, taking the working
 * directory from the session file itself, refusing held or vanished sessions,
 * and re-raising a closed one in its own topic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
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

describe("/resume", () => {
	it("raises by path in the directory recorded in the session file", async () => {
		const h = harness();
		const file = path.join(h.dir, "abc123.jsonl");
		fs.writeFileSync(file, "");
		h.sessionCwd = target => (target === file ? "/work/tree" : null);
		h.queue(fakeSession({ file, id: "abc123" }));
		expect(await h.host.handleUpdate(update({ message: message({ text: `/resume ${file}` }) }))).toBe("created");
		expect(h.requests.at(-1)?.cwd).toBe("/work/tree");
		expect(h.requests.at(-1)?.sessionFile).toBe(file);
		expect(h.api.of("createForumTopic").at(-1)?.fields.name).toBe("abc123");
		const stored = h.readRegistry()[0];
		expect(stored).toMatchObject({ sessionFile: file, sessionId: "abc123", cwd: "/work/tree" });
	});

	it("refuses a session file without a directory and one whose directory is gone", async () => {
		const h = harness();
		const file = path.join(h.dir, "abc123.jsonl");
		fs.writeFileSync(file, "");
		expect(await h.host.handleUpdate(update({ message: message({ text: `/resume ${file}` }) }))).toBe("no_cwd");
		h.sessionCwd = () => "/work/vanished";
		h.existsDir = dir => dir !== "/work/vanished";
		expect(await h.host.handleUpdate(update({ message: message({ text: `/resume ${file}` }) }))).toBe("no_cwd_dir");
		expect(h.api.of("createForumTopic")).toHaveLength(0);
	});

	it("refuses a resolution that matches several sessions or nothing at all", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ text: "/resume abc" }) }))).toBe("no_session");
		expect(h.api.sentTexts().at(-1)).toContain("No session matches");
		h.found = ["/sessions/a.jsonl", "/sessions/b.jsonl"];
		expect(await h.host.handleUpdate(update({ message: message({ text: "/resume abc" }) }))).toBe("no_session");
		expect(h.api.sentTexts().at(-1)).toContain("2 sessions match");
		expect(await h.host.handleUpdate(update({ message: message({ text: "/resume" }) }))).toBe("usage");
		expect(h.api.sentTexts().at(-1)).toContain("Form: `/resume");
	});

	it("refuses while another process holds the same session", async () => {
		const h = harness();
		h.found = ["/sessions/abc123.jsonl"];
		h.sessionCwd = () => "/work";
		h.presence = [
			{
				pid: 4242,
				kind: "interactive",
				sessionId: "abc123",
				sessionFile: "/sessions/abc123.jsonl",
				cwd: "/work",
				sessionName: null,
				startedAt: 0,
				updatedAt: 0,
			},
		];
		expect(await h.host.handleUpdate(update({ message: message({ text: "/resume abc" }) }))).toBe("busy_session");
		expect(h.api.of("createForumTopic")).toHaveLength(0);
		expect(h.requests).toHaveLength(0);
	});

	it("points at the topic of an already open session", async () => {
		const h = harness();
		const file = path.join(h.dir, "abc123.jsonl");
		fs.writeFileSync(file, "");
		h.sessionCwd = () => "/work";
		h.queue(fakeSession({ file, id: "abc123" }));
		await h.host.handleUpdate(update({ message: message({ text: `/resume ${file} Fox` }) }));
		expect(await h.host.handleUpdate(update({ message: message({ text: `/resume ${file}` }) }))).toBe("already_open");
		expect(h.api.sentTexts().at(-1)).toContain('already runs in topic "Fox"');
	});

	it("re-raises a closed session in its own topic and points the caller there", async () => {
		const h = harness();
		const file = path.join(h.dir, "abc123.jsonl");
		fs.writeFileSync(file, "");
		h.sessionCwd = () => "/work/tree";
		h.queue(fakeSession({ file, id: "abc123" }));
		await h.host.handleUpdate(update({ message: message({ text: `/resume ${file} Fox` }) }));
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }));
		const topicsBefore = h.api.of("createForumTopic").length;
		h.sessionCwd = () => "/work/elsewhere";
		h.queue(fakeSession({ file, id: "abc123" }));
		expect(await h.host.handleUpdate(update({ message: message({ text: `/resume ${file}` }) }))).toBe("reopened");
		expect(h.api.of("createForumTopic")).toHaveLength(topicsBefore);
		expect(h.requests.at(-1)?.cwd).toBe("/work/elsewhere");
		expect(h.api.threadTexts(900).at(-1)).toContain("raised again");
	});

	it("reports a failed raise instead of claiming the session is back", async () => {
		const h = harness();
		const file = path.join(h.dir, "abc123.jsonl");
		fs.writeFileSync(file, "");
		h.sessionCwd = () => "/work/tree";
		h.queue(fakeSession({ file, id: "abc123" }));
		await h.host.handleUpdate(update({ message: message({ text: `/resume ${file} Fox` }) }));
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }));
		const broken = fakeSession({ file, id: "abc123" });
		Object.defineProperty(broken, "session", {
			get: () => {
				throw new Error("the session could not be raised");
			},
		});
		h.queue(broken);
		expect(await h.host.handleUpdate(update({ message: message({ text: `/resume ${file}` }) }))).toBe("spawn_failed");
		expect(h.api.threadTexts(900).at(-1)).toContain("did not start");
		expect(h.api.threadTexts(900).some(text => text.includes("raised again"))).toBe(false);
		expect(h.readRegistry()[0].status).toBe("closed");
	});
});
