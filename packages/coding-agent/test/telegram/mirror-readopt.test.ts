import { afterEach, describe, expect, it } from "bun:test";
import { MIRROR_READOPTED } from "../../src/telegram/mirror-text";
import {
	agentSaid,
	cleanupSandboxes,
	entryAt,
	humanSaid,
	liveSession,
	makeSandbox,
	SESSION_ID,
	sentTo,
	sessionHead,
	mirrorHarness,
} from "./mirror-fixtures";

afterEach(cleanupSandboxes);

const THREAD = 7;

describe("mirror re-adoption", () => {
	it("never returns a topic the human closed to the mirror", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write(sessionHead());
		h.registry.put({
			threadId: THREAD,
			name: "Fox",
			cwd: "/w",
			sessionFile: sandbox.file,
			sessionId: SESSION_ID,
			status: "closed",
		});
		h.setLive([liveSession({ file: sandbox.file })]);

		await h.mirror.scan();

		const stored = entryAt(h.registry, THREAD);
		expect(stored.status).toBe("closed");
		expect(stored.mirror).not.toBe(true);
		expect(sentTo(h.topics, THREAD)).toEqual([]);
	});

	it("never returns a session this host runs to the mirror", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness({ heldHere: entry => entry.sessionFile === sandbox.file });
		sandbox.write(sessionHead());
		h.registry.put({
			threadId: THREAD,
			name: "Fox",
			cwd: "/w",
			sessionFile: sandbox.file,
			sessionId: SESSION_ID,
			status: "idle",
		});
		h.setLive([liveSession({ file: sandbox.file })]);

		await h.mirror.scan();

		const stored = entryAt(h.registry, THREAD);
		expect(stored.status).not.toBe("mirror");
		expect(stored.mirror).not.toBe(true);
		expect(sentTo(h.topics, THREAD)).not.toContain(MIRROR_READOPTED);
	});

	it("tails a re-adopted entry from the current size so old history is not replayed", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write([...sessionHead(), humanSaid("old question"), agentSaid("old answer")]);
		h.registry.put({
			threadId: THREAD,
			name: "Fox",
			cwd: "/w",
			sessionFile: sandbox.file,
			sessionId: SESSION_ID,
			status: "idle",
		});
		h.setLive([liveSession({ file: sandbox.file })]);

		await h.mirror.scan();
		sandbox.append([humanSaid("fresh question")]);
		await h.mirror.tail();

		expect(sentTo(h.topics, THREAD)).toEqual([MIRROR_READOPTED, "> 👤 **Human:** fresh question"]);
	});

	it("re-adopts a released mirror and relays only what is written after it comes back", async () => {
		const sandbox = makeSandbox();
		const h = mirrorHarness();
		sandbox.write([...sessionHead(), agentSaid("first")]);
		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.start();

		h.setLive([]);
		await h.mirror.scan();
		expect(entryAt(h.registry, 900).status).toBe("idle");

		h.setLive([liveSession({ file: sandbox.file })]);
		await h.mirror.scan();
		const stored = entryAt(h.registry, 900);
		expect(stored.status).toBe("mirror");
		expect(stored.mirror).toBe(true);
		expect(sentTo(h.topics, 900).at(-1)).toBe(MIRROR_READOPTED);

		sandbox.append([agentSaid("second")]);
		await h.mirror.tail();
		expect(sentTo(h.topics, 900).slice(-2)).toEqual([MIRROR_READOPTED, "second"]);
	});
});
