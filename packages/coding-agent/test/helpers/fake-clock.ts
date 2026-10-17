/**
 * Driving real async work under `vi.useFakeTimers()`.
 *
 * Fake timers freeze every clock a test could read to measure a wait (`Date`, `performance`, `Bun.nanoseconds`,
 * `process.hrtime`), while promises, sockets, files and `setImmediate` keep running. So a wait cannot be bounded by
 * time: these helpers count event-loop turns (`scheduler.yield`) instead. The count is a watchdog against a test that
 * waits on something it never provides. It is not a consumer latency assertion, and it must never be raised to hide
 * a hang: the idle delays under test stay at the values the product clamps them to.
 *
 * The clock moves only through {@link elapse} (an explicit deadline) and {@link drive}'s 1 ms nudge. The nudge exists
 * because the agent awaits a zero-delay timer (`Bun.sleep(0)`) before every model call, which a frozen clock would
 * never release; {@link driveTurn} stops it at the terminal `agent_end`, so the idle stretch a turn opens starts there
 * and no deadline is contaminated by how long the turn took to run. Work that must eventually happen after an idle
 * delay (a recap) is awaited the same way: {@link nextIdleRecap}, then {@link drive}. A fixed burst of `elapse` calls
 * cannot do that: it may end before the host's asynchronous quiet check has armed its timer.
 */
import { vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Event-loop turns a wait may take before the test gives up. */
export const WAIT_TURNS = 20_000;

/**
 * Drive `work` to completion under frozen time. The clock is nudged 1 ms per event-loop turn unless `holdClock()`.
 * Without a terminal `agent_end` to stop at, see {@link driveTurn}.
 */
export async function drive<T>(work: Promise<T>, holdClock: () => boolean = () => false): Promise<T> {
	let settled = false;
	const tracked = work.finally(() => {
		settled = true;
	});
	tracked.catch(() => {});
	for (let turn = 0; turn < WAIT_TURNS && !settled; turn++) {
		await scheduler.yield();
		if (!settled && !holdClock()) vi.advanceTimersByTime(1);
	}
	if (!settled) {
		// Whatever is parked on the frozen clock would also hang this test's teardown, once the clock is real again.
		vi.runOnlyPendingTimers();
		await flush();
		throw new Error("Work did not settle: it waits on something the test never provides");
	}
	return tracked;
}

/** Wait for something the code under test settles by itself (focus, a rebuild, a socket round trip); the clock stays where it is. */
export const wait = <T>(work: Promise<T>): Promise<T> => drive(work, () => true);

/**
 * A turn of `session` through to its result: the clock is nudged until the terminal `agent_end` is out and stands
 * still from there. `work` is whatever submits and awaits the turn, locally or through a host's client.
 */
export async function driveTurn<T>(session: Pick<AgentSession, "subscribe">, work: Promise<T>): Promise<T> {
	let ended = false;
	const stop = session.subscribe(event => {
		if (event.type === "agent_end" && event.isTerminal !== false) ended = true;
	});
	try {
		return await drive(work, () => ended);
	} finally {
		stop();
	}
}

/**
 * The next `idle_recap` `session` announces, resolved with the full reply. Subscribe BEFORE the stimulus that makes a
 * recap due, then {@link drive} the promise: the 1 ms nudge keeps the clock moving until the recap really is announced,
 * however late the host's asynchronous quiet check arms its timer. The recap is journaled before it is announced,
 * so assertions on the journal belong after the promise settles.
 */
export function nextIdleRecap(session: Pick<AgentSession, "subscribe">): Promise<string> {
	const recap = Promise.withResolvers<string>();
	const stop = session.subscribe(event => {
		if (event.type !== "idle_recap") return;
		stop();
		recap.resolve(event.recap);
	});
	return recap.promise;
}

/** Let already-runnable async work reach its next real wait: `turns` event-loop turns, which sockets and files also get. */
export async function flush(turns = 60): Promise<void> {
	for (let i = 0; i < turns; i++) await scheduler.yield();
}

/** Wait for `condition`, which the code under test brings about by itself. */
export async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	for (let turn = 0; turn < WAIT_TURNS; turn++) {
		if (await condition()) return;
		await scheduler.yield();
	}
	throw new Error(`Timed out waiting for ${what}`);
}

export async function elapse(ms: number, turns?: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await flush(turns);
}
