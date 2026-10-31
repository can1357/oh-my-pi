/**
 * Driving real async work under `vi.useFakeTimers()`.
 *
 * Fake timers freeze every clock a test could read to measure a wait (`Date`, `performance`, `Bun.nanoseconds`,
 * `process.hrtime`), while promises, sockets, files and `setImmediate` keep running. So a wait cannot be bounded by
 * time, and it must not be bounded by event-loop turns either: how many turns a file write or SQLite commit spans
 * depends on machine load, not on the code under test. The waits below therefore run until their work settles, and
 * a test that waits on something it never provides fails on the runner's per-test timeout. A wait the test has
 * outlived (it timed out, or its teardown restored real timers) stops spinning and is abandoned.
 *
 * The clock moves only through {@link elapse} (an explicit deadline) and {@link drive}'s 1 ms nudge. The nudge exists
 * because the agent awaits a zero-delay timer (`Bun.sleep(0)`) before every model call, which a frozen clock would
 * never release; {@link driveTurn} stops it at the terminal `agent_end`, so the idle stretch a turn opens starts there
 * and no deadline is contaminated by how long the turn took to run. Work that must eventually happen after an idle
 * delay (a recap) is awaited with {@link until}: a fixed burst of `elapse` calls may end before the session's
 * asynchronous quiet check has armed its timer.
 */
import { afterEach, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Bumped after every test, so a wait started by a test that has ended stops instead of spinning into the next one. */
let testGeneration = 0;
afterEach(() => {
	testGeneration++;
});

/** Whether a wait started in `generation` still belongs to a running fake-timer test. */
function waitIsLive(generation: number): boolean {
	return generation === testGeneration && vi.isFakeTimers();
}

/** A wait whose test is over: never settles, so the abandoned caller neither resumes nor reports a stray rejection. */
function abandoned<T>(): Promise<T> {
	return Promise.withResolvers<T>().promise;
}

/**
 * Drive `work` to completion under frozen time. The clock is nudged 1 ms per event-loop turn unless `holdClock()`.
 * Without a terminal `agent_end` to stop at, see {@link driveTurn}.
 */
export async function drive<T>(work: Promise<T>, holdClock: () => boolean = () => false): Promise<T> {
	const generation = testGeneration;
	let settled = false;
	const tracked = work.finally(() => {
		settled = true;
	});
	tracked.catch(() => {});
	while (!settled) {
		if (!waitIsLive(generation)) return abandoned();
		await scheduler.yield();
		if (!settled && !holdClock() && waitIsLive(generation)) vi.advanceTimersByTime(1);
	}
	return tracked;
}

/** Wait for something the code under test settles by itself (focus, a rebuild, an idle barrier); the clock stays where it is. */
export const wait = <T>(work: Promise<T>): Promise<T> => drive(work, () => true);

/**
 * A turn of `session` through to its result: the clock is nudged until the terminal `agent_end` is out and stands
 * still from there. `work` is whatever submits and awaits the turn.
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

/** Let already-runnable async work reach its next real wait: `turns` event-loop turns, which sockets and files also get. */
export async function flush(turns = 60): Promise<void> {
	for (let i = 0; i < turns; i++) await scheduler.yield();
}

/** Wait for `condition`, which the code under test brings about by itself. */
export async function until(condition: () => boolean | Promise<boolean>, _what: string): Promise<void> {
	const generation = testGeneration;
	while (!(await condition())) {
		if (generation !== testGeneration) return abandoned();
		await scheduler.yield();
	}
}

export async function elapse(ms: number, turns?: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await flush(turns);
}
