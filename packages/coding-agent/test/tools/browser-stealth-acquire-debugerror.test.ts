/**
 * Regression test for issue #5296: the stealth `puppeteer-core` patch
 * (`patches/puppeteer-core@25.3.0.patch`) re-implements world acquisition
 * without `Runtime.enable`. Its new catch handlers in `FrameManager` called the
 * bare `debugError` logger, which puppeteer leaves `undefined` when the
 * `puppeteer:error` debug channel is disabled (the default). A transient CDP
 * failure during world re-acquire then threw `TypeError: debugError is not a
 * function` from `#doAcquireWorlds`, escaped as an `unhandledRejection`, and the
 * postmortem handler killed the whole OMP process (parent session + every
 * subagent).
 *
 * The test drives the real patched `FrameManager` with a `send()` that always
 * rejects (a mid-flight CDP failure) and asserts the acquire path emits no
 * unhandled `TypeError`.
 *
 * Real timers are deliberate here (see repo rule ts-no-test-timers): the fatal
 * path is the coalescing acquirer's fire-and-forget `void this.#acquireWorlds()`
 * retrigger, whose rejection escapes only to the global `unhandledRejection`
 * handler — there is no promise or event the test can await, and fake timers
 * serialise the two concurrent acquires so the retrigger (and thus the bug)
 * never fires. Short real delays let the event loop interleave the acquires the
 * way it does in production.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FrameEvent } from "puppeteer-core/lib/puppeteer/api/Frame.js";
import { CdpFrame } from "puppeteer-core/lib/puppeteer/cdp/Frame.js";
import { FrameManager } from "puppeteer-core/lib/puppeteer/cdp/FrameManager.js";
import { MAIN_WORLD, PUPPETEER_WORLD } from "puppeteer-core/lib/puppeteer/cdp/IsolatedWorlds.js";
import { EventEmitter } from "puppeteer-core/lib/puppeteer/common/EventEmitter.js";
import { TimeoutSettings } from "puppeteer-core/lib/puppeteer/common/TimeoutSettings.js";

const ACQUIRE_TIMEOUT_MS = 40;

// A CDP session double whose every `send` rejects, modelling a navigation that
// tears the target's execution contexts down mid-acquire.
class RejectingSession extends EventEmitter<Record<string, unknown>> {
	constructor(readonly sessionId: string) {
		super();
	}
	id(): string {
		return this.sessionId;
	}
	send(): Promise<never> {
		return Promise.reject(new Error("mid-flight CDP failure"));
	}
	target(): unknown {
		return { _targetId: "T", type: () => "page" };
	}
}

function makeFrameManager(session: EventEmitter<Record<string, unknown>>): FrameManager {
	const browser = { isNetworkEnabled: () => false, isIssuesEnabled: () => false, connected: true };
	const page = { browser: () => browser, isClosed: () => false, emit() {}, once() {}, off() {} };
	const timeoutSettings = new TimeoutSettings();
	timeoutSettings.setDefaultTimeout(ACQUIRE_TIMEOUT_MS);
	// The patched FrameManager only touches the members exercised here; the
	// puppeteer-internal `CdpCDPSession` / `CdpPage` types are far wider than the
	// acquire path needs, so the doubles cross the boundary with a cast.
	return new FrameManager(session as never, page as never, timeoutSettings);
}

describe("stealth FrameManager world acquire — issue #5296", () => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);

	beforeEach(() => {
		rejections.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it("does not emit an unhandled TypeError when acquire fails mid-flight", async () => {
		const session = new RejectingSession("S1");
		const frameManager = makeFrameManager(session);
		const frame = new CdpFrame(frameManager, "F1", undefined, session as never);
		frameManager._frameTree.addFrame(frame);

		// Navigation installs the lazy context providers and invalidates the old
		// contexts; the async handler must settle before we pull a context.
		session.emit("Page.frameNavigated", {
			frame: { id: "F1", parentId: undefined, url: "about:blank" },
			type: "Navigation",
		});
		await Bun.sleep(20);

		// Concurrent pulls on both worlds force the coalescing acquirer to
		// re-run (`void this.#acquireWorlds` in its `finally`), which is the exact
		// path where `#doAcquireWorlds`'s catch previously threw a bare
		// `debugError(error)`.
		const main = frame.worlds[MAIN_WORLD];
		const util = frame.worlds[PUPPETEER_WORLD];
		const results = await Promise.allSettled([main.evaluate(() => 1), util.evaluate(() => 1)]);

		// Let the re-triggered acquire settle and any stray rejection surface.
		await Bun.sleep(ACQUIRE_TIMEOUT_MS + 40);

		const typeErrors = rejections.filter(
			(reason): reason is TypeError => reason instanceof Error && reason.name === "TypeError",
		);
		expect(typeErrors).toHaveLength(0);
		expect(rejections).toHaveLength(0);

		// The failure is still observable as an ordinary, recoverable evaluate
		// error rather than a silent process death.
		expect(results.every(r => r.status === "rejected")).toBe(true);
	});
});

// A CDP session double for one tab: `Page.createIsolatedWorld` hands out the
// current document's utility context, the context-less `globalThis` probe that
// resolves the main world waits for the test to answer it, and an evaluation
// answers with the id of the context it ran in.
class ScriptedSession extends EventEmitter<Record<string, unknown>> {
	utilityContextId = 0;
	probe = Promise.withResolvers<(mainContextId: number) => void>();
	id(): string {
		return "S1";
	}
	target(): unknown {
		return { _targetId: "T", type: () => "page" };
	}
	send(method: string, params: { contextId?: number } = {}): Promise<unknown> {
		if (method === "Page.createIsolatedWorld") return Promise.resolve({ executionContextId: this.utilityContextId });
		if (method === "Runtime.evaluate" && params.contextId === undefined) {
			const answer = Promise.withResolvers<unknown>();
			this.probe.resolve(mainContextId => answer.resolve({ result: { objectId: `1.${mainContextId}.1` } }));
			return answer.promise;
		}
		if (method === "Runtime.evaluate")
			return Promise.resolve({ result: { type: "number", value: params.contextId } });
		return Promise.resolve({});
	}
}

describe("stealth FrameManager world acquire across a superseding navigation", () => {
	it("acquires the document that committed while the previous one was being probed", async () => {
		const session = new ScriptedSession();
		const frameManager = makeFrameManager(session);
		const frame = new CdpFrame(frameManager, "F1", undefined, session as never);
		frameManager._frameTree.addFrame(frame);
		const navigate = (url: string): Promise<unknown> => {
			const navigated = Promise.withResolvers<unknown>();
			frame.once(FrameEvent.FrameNavigated, navigated.resolve);
			session.emit("Page.frameNavigated", { frame: { id: "F1", parentId: undefined, url }, type: "Navigation" });
			return navigated.promise;
		};

		await navigate("http://127.0.0.1/b");
		session.utilityContextId = 11;
		const evaluation = frame.worlds[MAIN_WORLD].evaluate("location.pathname");

		// /b redirects to /c: the probe answer for /b and the commit of /c arrive
		// back to back, before Puppeteer has handled either.
		const answerB = await session.probe.promise;
		session.probe = Promise.withResolvers();
		session.utilityContextId = 21;
		answerB(12);
		const committedC = navigate("http://127.0.0.1/c");

		const answerC = await session.probe.promise;
		await committedC;
		answerC(22);
		expect(await evaluation).toBe(22);
	});
});
