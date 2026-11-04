import { afterEach, expect, it, vi } from "bun:test";
import { afterRequestHolds, type RequestHolds, runWithRequestHolds } from "../src/request-holds";
import { armRequestTimeout } from "../src/utils/idle-iterator";

afterEach(() => vi.useRealTimers());

for (const ending of ["reject", "abort"] as const) {
	it(`resumes the remaining network timeout after a held send ends by ${ending}`, async () => {
		vi.useFakeTimers({ now: 0 });
		let expired = 0;
		const watchdog = armRequestTimeout(() => expired++, 100);
		const pause = Promise.withResolvers<void>();
		const checked = Promise.withResolvers<void>();
		const controller = new AbortController();
		const holds: RequestHolds = {
			open: () => ({
				check: () => {
					checked.resolve();
					return pause.promise;
				},
				release() {},
			}),
		};
		try {
			await watchdog.run(() => afterRequestHolds(undefined, () => undefined));
			vi.advanceTimersByTime(30);
			const waiting = runWithRequestHolds(holds, () =>
				watchdog.run(() => afterRequestHolds(controller.signal, () => undefined)),
			).catch((error: unknown) => error);
			await checked.promise;
			vi.advanceTimersByTime(200);
			expect(expired).toBe(0);
			if (ending === "reject") pause.reject(new Error("admission refused"));
			else controller.abort();
			expect(await waiting).toBeInstanceOf(Error);
			vi.advanceTimersByTime(69);
			expect(expired).toBe(0);
			vi.advanceTimersByTime(1);
			expect(expired).toBe(1);
		} finally {
			watchdog.clear();
			pause.resolve();
			controller.abort();
		}
	});
}

it("keeps a watchdog paused until every overlapping admission wait ends", async () => {
	vi.useFakeTimers({ now: 0 });
	let expired = 0;
	const watchdog = armRequestTimeout(() => expired++, 100);
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const firstChecked = Promise.withResolvers<void>();
	const secondChecked = Promise.withResolvers<void>();
	const one = new AbortController();
	const two = new AbortController();
	const startWait = (pending: Promise<void>, checked: () => void, signal: AbortSignal) =>
		runWithRequestHolds(
			{
				open: () => ({
					check: () => {
						checked();
						return pending;
					},
					release() {},
				}),
			},
			() => watchdog.run(() => afterRequestHolds(signal, () => undefined)),
		).catch((error: unknown) => error);
	try {
		await watchdog.run(() => afterRequestHolds(undefined, () => undefined));
		const waitingOne = startWait(first.promise, firstChecked.resolve, one.signal);
		const waitingTwo = startWait(second.promise, secondChecked.resolve, two.signal);
		await Promise.all([firstChecked.promise, secondChecked.promise]);
		one.abort();
		await waitingOne;
		vi.advanceTimersByTime(200);
		expect(expired).toBe(0);
		two.abort();
		await waitingTwo;
		vi.advanceTimersByTime(100);
		expect(expired).toBe(1);
	} finally {
		watchdog.clear();
		first.resolve();
		second.resolve();
		one.abort();
		two.abort();
	}
});
