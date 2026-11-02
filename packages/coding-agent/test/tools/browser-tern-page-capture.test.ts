import { afterEach, describe, expect, it, vi } from "bun:test";
import * as vm from "node:vm";
import { type TernRouteRule, ternCaptureScript } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-capture";

/** 2^31 ms (about 24.9 days): one past the longest delay a single timer holds, so a raw page timer fires it at once. */
const DELAY_MS = 2 ** 31;

interface CapturedPage {
	fetch(url: string): Promise<Response>;
}

afterEach(() => {
	vi.useRealTimers();
});

/**
 * Install the capture script in a page world holding only what it touches. The
 * page's timers and clock are the test's, so fake timers drive its route delays.
 */
function installCapture(routes: TernRouteRule[]): CapturedPage {
	const noop = (): void => {};
	const page: Record<string, unknown> = {
		console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
		addEventListener: noop,
		dispatchEvent: noop,
		Navigator: class {},
		location: { href: "https://page.test/" },
		fetch: async () => {
			throw new Error("an unrouted request reached the network");
		},
		Request,
		Response,
		Headers,
		TextEncoder,
		TextDecoder,
		URL,
		btoa,
		setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
		performance: { now: () => performance.now() },
	};
	page.window = page;
	page.parent = page;
	vm.runInNewContext(ternCaptureScript({ routes, emulation: {} }), page);
	return page as unknown as CapturedPage;
}

/** Let the page's promise chain run; `setImmediate` is not faked by `vi.useFakeTimers()`. */
async function drainPage(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("Tern page capture routes", () => {
	it("holds a routed fetch for a delay past the platform timer ceiling", async () => {
		vi.useFakeTimers();
		const page = installCapture([
			{ source: "/slow$", flags: "", delay: DELAY_MS, fulfill: { status: 200, body: "late" } },
		]);
		let answered = false;
		const response = page.fetch("https://page.test/slow").finally(() => {
			answered = true;
		});

		vi.advanceTimersByTime(DELAY_MS - 1);
		await drainPage();
		expect(answered).toBe(false);

		vi.advanceTimersByTime(1);
		expect(await (await response).text()).toBe("late");
	});
});
