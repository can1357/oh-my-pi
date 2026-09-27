/**
 * Second-writer gate: a session file held by another process (or whose
 * liveness cannot be read) is refused, a file this process holds is not.
 */
import { describe, expect, it } from "bun:test";
import {
	LOCAL_HOLDER_TEXT,
	raiseAllowed,
	sessionHolder,
	UNKNOWN_LIVENESS_TEXT,
	type LivenessDeps,
} from "@oh-my-pi/pi-coding-agent/telegram/liveness";
import type { SessionPresence } from "@oh-my-pi/pi-coding-agent/session/session-presence";
import type { TopicEntry } from "@oh-my-pi/pi-coding-agent/telegram/types";

const presence = (overrides: Partial<SessionPresence> = {}): SessionPresence => ({
	pid: 37122,
	kind: "interactive",
	sessionId: "abc123",
	sessionFile: "/sessions/live.jsonl",
	cwd: "/work",
	sessionName: null,
	startedAt: 0,
	updatedAt: 0,
	...overrides,
});

function deps(overrides: Partial<LivenessDeps> = {}): { deps: LivenessDeps; sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		deps: {
			livePresence: async () => [presence()],
			findHolder: async file => (file === "/sessions/live.jsonl" ? presence() : null),
			isHeldLocally: async () => false,
			notify: async (_threadId, markdown) => {
				sent.push(markdown);
				return true;
			},
			...overrides,
		},
	};
}

const entry = (overrides: Partial<TopicEntry> = {}): TopicEntry => ({
	threadId: 7,
	name: "Fox",
	cwd: "/work",
	sessionFile: "/sessions/live.jsonl",
	sessionId: "abc123",
	status: "idle",
	createdAt: 1,
	updatedAt: 1,
	...overrides,
});

describe("sessionHolder", () => {
	it("reports a foreign process by pid and treats a local holder as local", async () => {
		expect(await sessionHolder(deps().deps, { file: "/sessions/live.jsonl" })).toEqual({
			lookup: "held",
			pid: 37122,
			local: false,
		});
		const local = deps({ isHeldLocally: async () => true });
		expect(await sessionHolder(local.deps, { file: "/sessions/live.jsonl" })).toEqual({
			lookup: "held",
			pid: process.pid,
			local: true,
		});
	});

	it("reports free when nobody holds the file", async () => {
		const none = deps({ findHolder: async () => null, livePresence: async () => [] });
		expect(await sessionHolder(none.deps, { file: "/sessions/other.jsonl" })).toEqual({ lookup: "free" });
		expect(await sessionHolder(none.deps, { file: null, id: "zzz" })).toEqual({ lookup: "free" });
	});

	it("reports unknown when presence cannot be read", async () => {
		const broken = deps({
			findHolder: async () => {
				throw new Error("presence directory unreadable");
			},
		});
		expect(await sessionHolder(broken.deps, { file: "/sessions/live.jsonl" })).toEqual({
			lookup: "unknown",
			reason: "presence directory unreadable",
		});
	});

	it("matches a session id prefix when no file is known", async () => {
		expect(await sessionHolder(deps().deps, { id: "abc" })).toEqual({ lookup: "held", pid: 37122, local: false });
	});
});

describe("raiseAllowed", () => {
	it("allows an entry with no session file and one nobody holds", async () => {
		const { deps: liveness, sent } = deps({ findHolder: async () => null });
		expect(await raiseAllowed(liveness, entry({ sessionFile: null }))).toEqual({ ok: true });
		expect(await raiseAllowed(liveness, entry({ sessionFile: "/sessions/free.jsonl" }))).toEqual({ ok: true });
		expect(sent).toEqual([]);
	});

	it("refuses a foreign holder, naming the pid and the corruption risk", async () => {
		const { deps: liveness, sent } = deps();
		expect(await raiseAllowed(liveness, entry())).toEqual({ ok: false, reason: "busy_session" });
		expect(sent).toEqual([
			"⚠️ This session is currently running in another omp process (pid 37122) — writing here is refused because a second writer would corrupt its file. Close it there and the next message will continue it here.",
		]);
	});

	it("refuses a locally held session and an unreadable presence", async () => {
		const local = deps({ isHeldLocally: async () => true });
		expect(await raiseAllowed(local.deps, entry())).toEqual({ ok: false, reason: "busy_session" });
		expect(local.sent).toEqual([LOCAL_HOLDER_TEXT]);
		const broken = deps({
			findHolder: async () => {
				throw new Error("unreadable");
			},
		});
		expect(await raiseAllowed(broken.deps, entry())).toEqual({ ok: false, reason: "unknown_liveness" });
		expect(broken.sent).toEqual([UNKNOWN_LIVENESS_TEXT]);
	});
});
