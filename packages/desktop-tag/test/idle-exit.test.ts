import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { createIdleExitSupervisor, type IdleExitSupervisor, parseIdleExitTimeoutMs } from "../src/capture/idle-exit";

/**
 * Deterministic clock harness: tests move `nowMs` forward by hand and drive
 * the supervisor via its public tick(), so no real timers are involved.
 */
interface SupervisorHarness {
	supervisor: IdleExitSupervisor;
	fireCount(): number;
	advance(ms: number): void;
	setActiveWork(active: boolean): void;
}

function makeHarness(timeoutMs: number): SupervisorHarness {
	let nowMs = 1_000_000;
	let active = false;
	let fires = 0;
	const supervisor = createIdleExitSupervisor({
		timeoutMs,
		hasActiveWork: () => active,
		onIdle: () => {
			fires += 1;
		},
		now: () => nowMs,
	});
	return {
		supervisor,
		fireCount: () => fires,
		advance(ms) {
			nowMs += ms;
		},
		setActiveWork(value) {
			active = value;
		},
	};
}

describe("parseIdleExitTimeoutMs", () => {
	it("returns 0 for undefined, empty, invalid, and non-positive values", () => {
		const cases: Array<[string | undefined, number]> = [
			[undefined, 0],
			["", 0],
			["   ", 0],
			["abc", 0],
			["0", 0],
			["-5", 0],
		];
		for (const [raw, expected] of cases) {
			expect(parseIdleExitTimeoutMs(raw)).toBe(expected);
		}
	});

	it("floors positive fractional values and passes integers through", () => {
		expect(parseIdleExitTimeoutMs("1500.7")).toBe(1500);
		expect(parseIdleExitTimeoutMs("30000")).toBe(30000);
	});
});

describe("createIdleExitSupervisor", () => {
	it("is enabled exactly when timeoutMs > 0", () => {
		expect(makeHarness(0).supervisor.enabled).toBe(false);
		expect(makeHarness(-10).supervisor.enabled).toBe(false);
		expect(makeHarness(1000).supervisor.enabled).toBe(true);
	});

	it("does not fire before the idle window elapses, across many ticks", () => {
		const h = makeHarness(1000);
		for (let i = 0; i < 50; i++) {
			h.advance(10); // 500ms total after all ticks: still inside the window
			h.supervisor.tick();
			expect(h.fireCount()).toBe(0);
		}
	});

	it("fires exactly once when the idle window elapses and stays fired", () => {
		const h = makeHarness(1000);
		h.advance(999);
		h.supervisor.tick();
		expect(h.fireCount()).toBe(0);

		h.advance(1); // elapsed is now exactly the timeout
		h.supervisor.tick();
		expect(h.fireCount()).toBe(1);

		h.advance(10_000);
		for (let i = 0; i < 5; i++) h.supervisor.tick();
		expect(h.fireCount()).toBe(1);
	});

	it("noteActivity() resets the idle window", () => {
		const h = makeHarness(1000);
		h.advance(900);
		h.supervisor.tick();
		expect(h.fireCount()).toBe(0);

		h.supervisor.noteActivity();
		h.advance(900); // 1800ms since start, but only 900ms since the activity
		h.supervisor.tick();
		expect(h.fireCount()).toBe(0);

		h.advance(100); // a full window has now passed since noteActivity()
		h.supervisor.tick();
		expect(h.fireCount()).toBe(1);
	});

	it("hasActiveWork resets the clock on every tick and defers firing", () => {
		const h = makeHarness(1000);
		h.setActiveWork(true);
		for (let i = 0; i < 5; i++) {
			h.advance(2000); // each step jumps past the window...
			h.supervisor.tick(); // ...but active work resets the clock instead
		}
		expect(h.fireCount()).toBe(0);

		// Work stops; the window must restart from the last active tick.
		h.setActiveWork(false);
		h.advance(999);
		h.supervisor.tick();
		expect(h.fireCount()).toBe(0);
		h.advance(1);
		h.supervisor.tick();
		expect(h.fireCount()).toBe(1);
	});

	it("resets idle activity for work that starts and completes between poll ticks", () => {
		let nowMs = 1_000_000;
		let active = false;
		let fires = 0;
		const supervisor = createIdleExitSupervisor({
			timeoutMs: 1_000,
			hasActiveWork: () => active,
			onIdle: () => {
				fires += 1;
			},
			now: () => nowMs,
		});

		// Tick at t=0
		supervisor.tick();
		expect(fires).toBe(0);

		// Work starts at t=400, completes at t=800 between ticks
		nowMs += 400;
		active = true;
		supervisor.noteActivity(); // work started
		nowMs += 400;
		active = false;
		supervisor.noteActivity(); // work completed, resetting idle clock to t=800

		// At t=1400 (600ms since completion at t=800), idle window (1000ms) has not elapsed
		nowMs += 600;
		supervisor.tick();
		expect(fires).toBe(0);

		// At t=1800 (1000ms since completion at t=800), idle window elapses
		nowMs += 400;
		supervisor.tick();
		expect(fires).toBe(1);
	});

	it("uncapped nonterminal query protects active runs beyond 500 finished runs", () => {
		const fs = require("node:fs");
		const os = require("node:os");
		const path = require("node:path");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ompk-idle-db-"));
		const dbPath = path.join(tmpDir, "capture.db");
		try {
			const db = new Database(dbPath);
			db.exec(`
				CREATE TABLE capture_runs (
					id TEXT PRIMARY KEY,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
			`);
			// Insert 505 completed runs
			for (let i = 0; i < 505; i++) {
				db.run("INSERT INTO capture_runs VALUES (?, 'completed', ?)", [
					`run_${i}`,
					new Date(Date.now() + i).toISOString(),
				]);
			}
			// Insert 1 older non-terminal run
			db.run("INSERT INTO capture_runs VALUES ('active_run', 'running', ?)", [
				new Date(Date.now() - 10000).toISOString(),
			]);
			db.close();

			// Perform direct uncapped query
			const roDb = new Database(dbPath, { readonly: true });
			const row = roDb
				.query<{ count: number }, []>(
					"SELECT COUNT(*) as count FROM capture_runs WHERE status NOT IN ('completed', 'failed', 'cancelled')",
				)
				.get();
			roDb.close();

			expect(row?.count).toBe(1);
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
		}
	});
	it("never fires when disabled (timeoutMs 0), even after huge time advances", () => {
		const h = makeHarness(0);
		expect(h.supervisor.enabled).toBe(false);
		h.supervisor.start(); // no-op while disabled
		h.advance(1_000_000_000_000);
		for (let i = 0; i < 10; i++) h.supervisor.tick();
		expect(h.fireCount()).toBe(0);
		h.supervisor.stop();
	});

	// Real timers on purpose: this is the one test that exercises start()'s
	// actual setInterval scheduling, which the injected now() cannot drive.
	// Deadline-polling instead of a fixed sleep keeps it load-tolerant.
	it("start() schedules real ticks that fire onIdle; stop() is idempotent", async () => {
		let fires = 0;
		const supervisor = createIdleExitSupervisor({
			timeoutMs: 120,
			hasActiveWork: () => false,
			onIdle: () => {
				fires += 1;
			},
			checkIntervalMs: 20,
		});
		supervisor.start();
		supervisor.start(); // idempotent: must not arm a second interval
		try {
			const deadline = Date.now() + 2000;
			while (fires === 0 && Date.now() < deadline) {
				await Bun.sleep(25);
			}
			expect(fires).toBe(1);
		} finally {
			supervisor.stop();
		}
		supervisor.stop(); // safe to call again
	});
});
