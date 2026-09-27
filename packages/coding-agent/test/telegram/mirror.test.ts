import { afterEach, describe, expect, it } from "bun:test";
import { MIRROR_SCAN_MS, MIRROR_TAIL_MS } from "../../src/telegram/mirror";
import { MIRROR_CLOSED, MIRROR_ENDED, MIRROR_READOPTED } from "../../src/telegram/mirror-text";
import {
	agentSaid,
	allText,
	cleanupSandboxes,
	entryAt,
	humanSaid,
	lastText,
	liveSession,
	makeSandbox,
	OTHER_ID,
	SESSION_ID,
	sentTo,
	sessionHead,
	timerAt,
	mirrorHarness,
} from "./mirror-fixtures";

afterEach(cleanupSandboxes);

describe("mirror scan", () => {
	it("adopts a live interactive session into a read-only topic", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead({ title: "Mirror review", cwd: "/work/one" }));
		h.setLive([liveSession({ file: sandbox.file })]);

		await h.mirror.start();

		expect(h.topics.created).toEqual(["Mirror review"]);
		const stored = entryAt(h.registry, 900);
		expect(stored.status).toBe("mirror");
		expect(stored.mirror).toBe(true);
		expect(stored.sessionFile).toBe(sandbox.file);
		expect(stored.sessionId).toBe(SESSION_ID);
		expect(stored.cwd).toBe("/work/one");
		expect(stored.tailOffset).toBe(sandbox.size());
		const header = sentTo(h.topics, 900)[0];
		expect(header).toMatch(/^## 🖥 Mirror review$/mu);
		expect(header).toContain("- **Directory:** `/work/one`");
		expect(header).toContain("pid `4242`");
		expect(header).toContain("writing here is not allowed");
	});

	it("ignores presence that is not an interactive session and sessions this host runs", async () => {
		const withEntry = makeSandbox(OTHER_ID);
		const attached = makeSandbox(OTHER_ID);
		const h = mirrorHarness({
			heldHere: entry => entry.sessionFile === withEntry.file || entry.sessionFile === attached.file,
		});
		h.registry.put({
			threadId: 7,
			name: "Held elsewhere",
			cwd: "/w",
			sessionFile: withEntry.file,
			sessionId: OTHER_ID,
			status: "idle",
		});
		h.setLive([
			liveSession({ file: withEntry.file, session: OTHER_ID, kind: "telegram" }),
			liveSession({ file: withEntry.file, session: OTHER_ID, kind: "interactive" }),
			liveSession({ file: attached.file, session: OTHER_ID, kind: "interactive" }),
		]);

		await h.mirror.scan();

		expect(h.topics.created).toEqual([]);
		expect(h.topics.sent).toEqual([]);
		expect(entryAt(h.registry, 7).mirror).not.toBe(true);
		expect(h.registry.list()).toHaveLength(1);
	});

	it("skips a presence entry whose session file is missing", async () => {
		const h = mirrorHarness();
		h.setLive([liveSession({ file: "/nonexistent/omp-mirror.jsonl" })]);
		await h.mirror.scan();
		expect(h.topics.created).toEqual([]);
		expect(h.registry.list()).toEqual([]);
	});

	it("does not create a second topic for a session already in the registry, and returns it to the mirror", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.registry.put({
			threadId: 7,
			name: "Fox",
			cwd: "/w",
			sessionFile: sandbox.file,
			sessionId: SESSION_ID,
			status: "idle",
		});
		h.setLive([liveSession({ file: sandbox.file })]);

		await h.mirror.start();

		expect(h.topics.created).toEqual([]);
		expect(h.registry.list()).toHaveLength(1);
		const stored = entryAt(h.registry, 7);
		expect(stored.mirror).toBe(true);
		expect(stored.status).toBe("mirror");
		expect(stored.tailOffset).toBe(sandbox.size());
		expect(lastText(h.topics)).toBe(MIRROR_READOPTED);
	});

	it("gives the new topic a free name when the title is already taken", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead({ title: "Mirror review" }));
		h.registry.put({
			threadId: 5,
			name: "Mirror review",
			cwd: "/w",
			sessionFile: "/tmp/other.jsonl",
			sessionId: OTHER_ID,
			status: "idle",
		});
		h.setLive([liveSession({ file: sandbox.file })]);

		await h.mirror.scan();

		expect(h.topics.created).toEqual(["Mirror review 2"]);
	});

	it("sends the last agent reply after the header, never the whole history", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write([...sessionHead(), humanSaid("old question"), agentSaid("first answer"), agentSaid("last answer")]);
		h.setLive([liveSession({ file: sandbox.file })]);

		await h.mirror.start();

		const shown = sentTo(h.topics, 900);
		expect(shown).toHaveLength(2);
		expect(shown[1]).toBe("last answer");
		expect(shown.some(text => text.includes("old question"))).toBe(false);
	});

	it("records no topic when Telegram refuses to create one", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness({ createThreadId: null });
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.scan();
		expect(h.topics.created).toEqual(["Mirror review"]);
		expect(h.registry.list()).toEqual([]);
		expect(h.topics.sent).toEqual([]);
	});

	it("treats unreadable presence as liveness unknown without failing the scan", async () => {
		const h = mirrorHarness();
		h.setPresenceFailure("presence directory unreadable");
		await h.mirror.scan();
		expect(h.topics.sent).toEqual([]);
		expect(h.registry.list()).toEqual([]);
		h.setPresenceFailure(null);
		h.setLive([]);
		await h.mirror.scan();
		expect(h.registry.list()).toEqual([]);
	});
});

describe("mirror tail", () => {
	it("reads from the persisted offset so a restart does not resend", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write([...sessionHead(), agentSaid("first answer")]);
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();

		sandbox.append([humanSaid("question")]);
		await h.mirror.tail();
		expect(lastText(h.topics)).toBe("> 👤 **Human:** question");

		const restarted = mirrorHarness({ entries: h.registry.list() });
		restarted.setLive([liveSession({ file: sandbox.file })]);
		await restarted.mirror.tail();
		expect(restarted.topics.sent).toEqual([]);
		await restarted.mirror.start();
		expect(restarted.topics.created).toEqual([]);
		expect(restarted.registry.list()).toHaveLength(1);
	});

	it("relays agent markdown as-is and human prompts as quotes", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		const before = h.topics.sent.length;

		sandbox.append([agentSaid("# Summary\n\n- one\n- two"), humanSaid("hi")]);
		await h.mirror.tail();

		const shown = h.topics.sent.slice(before).map(one => one.markdown);
		expect(shown).toEqual(["# Summary\n\n- one\n- two", "> 👤 **Human:** hi"]);
	});

	it("relays complete lines only and advances the offset to the last newline", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write([...sessionHead(), agentSaid("earlier")]);
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		const before = h.topics.sent.length;
		const complete = sandbox.size();
		const partial = JSON.stringify(humanSaid("half"));

		sandbox.appendRaw(`\n${partial.slice(0, 40)}`);
		await h.mirror.tail();
		expect(h.topics.sent).toHaveLength(before);
		expect(entryAt(h.registry, 900).tailOffset).toBe(complete + 1);

		sandbox.appendRaw(`${partial.slice(40)}\n`);
		await h.mirror.tail();
		expect(lastText(h.topics)).toBe("> 👤 **Human:** half");
	});

	it("relays each line once when the next tick lands during a slow pass", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		sandbox.append([humanSaid("first"), humanSaid("second")]);

		// Park the pass inside its first relay, then fire the next 3 s tick while
		// it is still in flight: a second pass that starts there reads the offset
		// this one has not persisted yet and posts both lines again.
		const reached = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const notify = h.topics.notify;
		h.topics.notify = async (threadId, markdown) => {
			const sent = await notify(threadId, markdown);
			reached.resolve();
			await held.promise;
			return sent;
		};

		const timer = timerAt(h.timers, MIRROR_TAIL_MS);
		const first = timer.tick();
		await reached.promise;
		const second = timer.tick();
		held.resolve();
		await Promise.all([first, second]);

		const relayed = sentTo(h.topics, 900).filter(text => text.startsWith("> 👤 **Human:**"));
		expect(relayed).toEqual(["> 👤 **Human:** first", "> 👤 **Human:** second"]);
	});

	it("does not relay a line again when a scan's release races a tail pass", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		sandbox.append([humanSaid("late")]);

		const reached = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const notify = h.topics.notify;
		h.topics.notify = async (threadId, markdown) => {
			const sent = await notify(threadId, markdown);
			reached.resolve();
			await held.promise;
			return sent;
		};

		// The session left the terminal while a line is pending: the scan releases
		// the mirror and relays it. A tick that lands before that relay has
		// persisted the offset reads the same chunk and posts the line again.
		h.setLive([]);
		const releasePass = h.mirror.scan();
		await reached.promise;
		const tailPass = timerAt(h.timers, MIRROR_TAIL_MS).tick();
		held.resolve();
		await Promise.all([releasePass, tailPass]);

		expect(sentTo(h.topics, 900).filter(text => text === "> 👤 **Human:** late")).toHaveLength(1);
	});

	it("resumes at the next line when a relay fails midway through a pass", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		sandbox.append([humanSaid("one"), humanSaid("two"), humanSaid("three")]);

		const notify = h.topics.notify;
		let fail = true;
		h.topics.notify = async (threadId, markdown) => {
			if (fail && markdown.includes("two")) throw new Error("relay refused");
			return notify(threadId, markdown);
		};

		await h.mirror.tail();
		fail = false;
		await h.mirror.tail();

		const relayed = sentTo(h.topics, 900).filter(text => text.startsWith("> 👤 **Human:**"));
		expect(relayed).toEqual(["> 👤 **Human:** one", "> 👤 **Human:** two", "> 👤 **Human:** three"]);
	});

	it("relays ask notices and answers from the tail", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write([...sessionHead(), agentSaid("earlier")]);
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		const before = h.topics.sent.length;

		sandbox.append([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_ask",
							name: "ask",
							arguments: {
								questions: [
									{
										id: "auth",
										question: "Which sign-in?",
										options: [{ label: "JWT", description: "stateless tokens" }, { label: "OAuth2" }],
										recommended: 0,
									},
								],
							},
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_ask",
					toolName: "ask",
					content: [{ type: "text", text: "handled" }],
					details: { question: "Which sign-in?", options: ["JWT"], selectedOptions: ["JWT"] },
					isError: false,
				},
			},
		]);
		await h.mirror.tail();

		const [notice, answer] = h.topics.sent.slice(before).map(one => one.markdown);
		expect(notice).toContain("The agent is waiting for an answer in the terminal:");
		expect(notice).toContain("1. **JWT** — stateless tokens ⭐");
		expect(answer).toBe("**Answer:** JWT");
	});

	it("stops relaying once the session left presence", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();

		h.setLive([]);
		await h.mirror.scan();
		const stored = entryAt(h.registry, 900);
		expect(stored.status).toBe("idle");
		expect(stored.mirror).toBe(false);
		expect(stored.cwd).toBe("/work/one");
		expect(lastText(h.topics)).toBe(MIRROR_ENDED);

		sandbox.append([humanSaid("after it ended")]);
		const before = h.topics.sent.length;
		await h.mirror.tail();
		expect(h.topics.sent).toHaveLength(before);
	});
});

describe("mirror topic text", () => {
	it("refuses plain text naming the pid, renames on /rename and closes on /close", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead({ title: "Mirror review" }));
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		const entry = entryAt(h.registry, 900);

		expect(await h.mirror.handle(entry, "hello")).toBe("mirror_readonly");
		expect(lastText(h.topics)).toContain("(pid 4242)");
		expect(lastText(h.topics)).toContain("writing here is not allowed");

		expect(await h.mirror.handle(entry, "/rename Wolf")).toBe("rename");
		expect(entryAt(h.registry, 900).name).toBe("Wolf");
		expect(h.topics.renamed).toEqual([{ threadId: 900, name: "Wolf" }]);
		expect(lastText(h.topics)).toContain("Topic is now “Wolf”.");

		expect(await h.mirror.handle(entry, "/stop")).toBe("mirror_readonly");
		expect(lastText(h.topics)).toContain("Only /close and /rename work in a mirror topic.");

		expect(await h.mirror.handle(entry, "/close")).toBe("close");
		expect(entryAt(h.registry, 900).status).toBe("closed");
		expect(h.topics.closed).toEqual([{ threadId: 900, name: "Wolf" }]);
		expect(lastText(h.topics)).toBe(MIRROR_CLOSED);

		sandbox.append([humanSaid("after close")]);
		const before = h.topics.sent.length;
		await h.mirror.tail();
		expect(h.topics.sent).toHaveLength(before);
		expect(await h.mirror.handle(entry, "again")).toBe("mirror_readonly");
	});

	it("rejects an empty or over-long /rename", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();
		const entry = entryAt(h.registry, 900);

		expect(await h.mirror.handle(entry, "/rename")).toBe("rename");
		expect(entryAt(h.registry, 900).name).toBe("Mirror review");
		expect(h.topics.renamed).toEqual([]);
		expect(lastText(h.topics)).toContain("at most 128 characters");
	});
});

describe("mirror schedule", () => {
	it("scans every 60 s, tails every 3 s, and stops cancelling both", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();

		expect(h.timers.of(MIRROR_SCAN_MS)).toHaveLength(1);
		expect(h.timers.of(MIRROR_TAIL_MS)).toHaveLength(1);
		sandbox.append([humanSaid("on schedule")]);
		await timerAt(h.timers, MIRROR_TAIL_MS).tick();
		expect(lastText(h.topics)).toBe("> 👤 **Human:** on schedule");

		h.mirror.stop();
		expect(h.timers.timers.every(timer => timer.cancelled)).toBe(true);
		sandbox.append([humanSaid("after stop")]);
		const before = h.topics.sent.length;
		await timerAt(h.timers, MIRROR_TAIL_MS).tick();
		await timerAt(h.timers, MIRROR_SCAN_MS).tick();
		expect(h.topics.sent).toHaveLength(before);
	});

	it("registers the timers only once when start is called twice", async () => {
		const h = mirrorHarness();
		await h.mirror.start();
		await h.mirror.start();
		expect(h.timers.timers).toHaveLength(2);
		expect(allText(h.topics)).toEqual([]);
	});
});
