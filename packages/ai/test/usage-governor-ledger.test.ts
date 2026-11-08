/**
 * Shared SQLite ledger (spec 3.5, 7.1). Several real processes contend on one ledger file through
 * `Bun.spawn`, the same way separate `omp` processes share it. Every bound asserted below has a
 * control that removes the calibration or the snapshot and must flip the outcome.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configureUsageAdmission } from "@oh-my-pi/pi-ai/usage-governor/admission";
import { type LedgerAdmitResult, type LedgerWindow, UsageLedger } from "@oh-my-pi/pi-ai/usage-governor/ledger";
import { governorGeneration, GOVERNOR_STALE_MS } from "@oh-my-pi/pi-ai/usage-governor/policy";
import {
	credentialIdOf,
	createHarness,
	disposeHarness,
	ENABLED,
	expectNoStrayFetch,
	installFetchTripwire,
	PROVIDER,
	seedAccounts,
	seedReports,
	windowAt,
} from "./fixtures/usage-governor/harness";

const CHILD = path.join(import.meta.dir, "fixtures", "usage-governor", "ledger-child.ts");
const QUOTA = "unit-ledger | acct:shared | limit:primary";
const RESERVE = 0.1;
const LEAD = 0.25;
/** The reserve leaves this much headroom under the line. */
const HEADROOM = 1 - RESERVE;

interface CountRow {
	n: number;
}

interface ChildEvent {
	kind: "admitted" | "wait" | "done";
	grantId?: string;
	admissibleAtMs?: number;
	admitted?: number;
}

interface ChildConfig {
	dbPath: string;
	mode: "admit-until-wait" | "hold";
	maxAttempts: number;
	quotaKey: string;
	generation: number;
	label: string;
	resetsAt: number;
	durationMs?: number;
	usedFraction: number;
	reserve: number;
	fetchedAt: number;
	lead: number;
	/** Epoch ms the child waits for before admitting. */
	startAtMs?: number;
	/** Milliseconds a child yields between admissions. */
	pauseMs?: number;
}

let tempDir = "";
let ledgerPath = "";
let resetsAt = 0;
let generation = 0;
/** First snapshot time, the calibration reservations fall between it and `t2`, and the second snapshot. */
let t1 = 0;
let t2 = 0;

beforeEach(async () => {
	tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-ai-governor-ledger-"));
	ledgerPath = path.join(tempDir, "usage-governor.db");
	// The reset falls an hour out, so no reservation bucket is pruned during the test.
	resetsAt = Date.now() + 60 * 60_000;
	generation = governorGeneration(resetsAt);
	t1 = Date.now() - 10_000;
	t2 = t1 + 4;
});

afterEach(async () => {
	await fsp.rm(tempDir, { recursive: true, force: true });
});

function window(overrides: Partial<LedgerWindow> = {}): LedgerWindow {
	return {
		quotaKey: QUOTA,
		generation,
		label: "primary",
		resetsAt,
		durationMs: undefined,
		usedFraction: 0.3,
		exhausted: false,
		fetchedAt: t2,
		reserve: RESERVE,
		...overrides,
	};
}

function admitAt(
	ledger: UsageLedger,
	nowMs: number,
	overrides: Partial<LedgerWindow> = {},
	grantId = crypto.randomUUID(),
): LedgerAdmitResult {
	return ledger.admit({
		grantId,
		nowMs,
		lead: LEAD,
		windows: [window(overrides)],
		provider: PROVIDER,
		credentialId: 1,
		source: "turn",
		interactive: false,
		pid: process.pid,
	});
}

/**
 * Calibrate the quota to 0.1 per request: a snapshot at `t1` reading 0, three reservations between `t1`
 * and `t2`, then (by the caller) a snapshot at `t2` reading 0.3. Cost is `(0.3 - 0) / 3`.
 */
function calibrate(ledger: UsageLedger): void {
	for (const offset of [1, 2, 3]) {
		const grantId = crypto.randomUUID();
		admitAt(ledger, t1 + offset, { fetchedAt: t1, usedFraction: 0 }, grantId);
		ledger.settle(grantId, "sent", t1 + offset);
	}
}

/** The number of reservations that fit above a 0.3 reading at cost 0.1 under the 0.9 headroom: six. */
function allowanceFromT2(): number {
	return Math.floor((HEADROOM - 0.3) / 0.1 + 1e-9);
}

function reservationsCreatedAtOrAfter(file: string, at: number): number {
	const db = new Database(file, { readonly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE created_at_ms >= ?").get(at) as CountRow;
		return row.n;
	} finally {
		db.close();
	}
}

async function runChild(config: ChildConfig): Promise<ChildEvent[]> {
	const proc = Bun.spawn([process.execPath, CHILD, JSON.stringify(config)], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
	return out
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

function childConfig(overrides: Partial<ChildConfig> = {}): ChildConfig {
	return {
		dbPath: ledgerPath,
		mode: "admit-until-wait",
		maxAttempts: 20,
		quotaKey: QUOTA,
		generation,
		label: "primary",
		resetsAt,
		durationMs: undefined,
		usedFraction: 0.3,
		reserve: RESERVE,
		fetchedAt: t2,
		lead: LEAD,
		// Siblings wait for one shared instant, so their admissions overlap on the file.
		startAtMs: Date.now() + 1_200,
		pauseMs: 5,
		...overrides,
	};
}

function admittedBy(runs: ChildEvent[][]): number {
	return runs.reduce((total, events) => total + (events.find(event => event.kind === "done")?.admitted ?? 0), 0);
}

describe("duplicate quota constraints", () => {
	test("both constraints bind correctly and reserve once per quota and generation in either order", () => {
		const nowMs = t2 + 1;
		const reset = nowMs + 100_000;
		const common = { resetsAt: reset, generation: governorGeneration(reset), usedFraction: 0.7 };
		const paced = window({ ...common, label: "paced", durationMs: 100_000 });
		const reserveOnly = window({ ...common, label: "reserve-only", durationMs: undefined });
		for (const [index, windows] of [
			[paced, reserveOnly],
			[reserveOnly, paced],
		].entries()) {
			const file = path.join(tempDir, `duplicate-${index}.db`);
			const ledger = UsageLedger.open(file);
			const request = {
				grantId: crypto.randomUUID(),
				nowMs,
				lead: LEAD,
				windows,
				provider: PROVIDER,
				credentialId: 1,
				source: "turn" as const,
				interactive: false,
				pid: process.pid,
			};
			try {
				const result = ledger.admit(request);
				expect(result.kind).toBe("wait");
				if (result.kind !== "wait") throw new Error("Expected the paced constraint to bind");
				expect(result.bindingLabel).toBe("paced");
				expect(result.reason).toBe("over-allowance");
				expect(result.admissibleAtMs).toBeCloseTo(nowMs + 100_000 * ((0.7 / HEADROOM - LEAD) / (1 - LEAD)), 2);
				expect(reservationsCreatedAtOrAfter(file, t2)).toBe(0);
				expect(ledger.admit({ ...request, nowMs: result.admissibleAtMs })).toEqual({
					kind: "admitted",
					reserved: 1,
				});
				expect(reservationsCreatedAtOrAfter(file, t2)).toBe(1);
			} finally {
				ledger.close();
			}
		}
	});
});

describe("concurrent admission against one ledger file", () => {
	installFetchTripwire();
	test("three processes admit no more reservations than the calibrated allowance permits", async () => {
		const ledger = UsageLedger.open(ledgerPath);
		try {
			calibrate(ledger);
			// The snapshot at t2 reads 0.3; this observer is the first reservation counted after it.
			expect(admitAt(ledger, t2 + 1).kind).toBe("admitted");
			expect(allowanceFromT2()).toBe(6);

			const runs = await Promise.all([runChild(childConfig()), runChild(childConfig()), runChild(childConfig())]);
			// Five of the six fit the children; each child stopped because the ledger refused.
			expect(admittedBy(runs)).toBe(allowanceFromT2() - 1);
			for (const events of runs) expect(events.some(event => event.kind === "wait")).toBe(true);
		} finally {
			ledger.close();
		}
		// Only reservations created after the snapshot count: exactly the allowance, never more.
		expect(reservationsCreatedAtOrAfter(ledgerPath, t2)).toBe(allowanceFromT2());
	}, 20_000);

	test("control: without calibration the same processes admit every attempt, so the bound is the pacing", async () => {
		// Only the snapshot at t2 exists: no cost is measured, so no reservation is ever over the line.
		const ledger = UsageLedger.open(ledgerPath);
		try {
			expect(admitAt(ledger, t2 + 1).kind).toBe("admitted");
			const runs = await Promise.all([runChild(childConfig()), runChild(childConfig()), runChild(childConfig())]);
			expect(admittedBy(runs)).toBe(3 * 20);
			expect(admittedBy(runs)).toBeGreaterThan(allowanceFromT2());
		} finally {
			ledger.close();
		}
	}, 20_000);
});

describe("a killed process keeps its reservation counted until a newer snapshot", () => {
	installFetchTripwire();
	test("pending counts the dead holder, in-flight does not, and only a newer snapshot releases it", async () => {
		const ledger = UsageLedger.open(ledgerPath);
		try {
			calibrate(ledger);
			const observerGrant = crypto.randomUUID();
			expect(admitAt(ledger, t2 + 1, {}, observerGrant).kind).toBe("admitted");
			// Settled as sent: it no longer counts in flight, but it still counts pending.
			ledger.settle(observerGrant, "sent", t2 + 2);

			// A child admits once and holds the reservation open until it is killed mid-run.
			const holder = Bun.spawn([process.execPath, CHILD, JSON.stringify(childConfig({ mode: "hold" }))], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const reader = holder.stdout.getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			while (!buffered.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("holder exited before admitting");
				buffered += decoder.decode(chunk.value, { stream: true });
			}
			const holderEvent: ChildEvent = JSON.parse(buffered.split("\n")[0] ?? "{}");
			expect(holderEvent.kind).toBe("admitted");
			holder.kill("SIGKILL");
			await holder.exited;
			reader.releaseLock();

			// The dead holder still counts pending and no longer counts in flight.
			const afterKill = ledger.inspect([window()], Date.now(), LEAD)[0];
			expect(afterKill?.pending).toBe(2);
			expect(afterKill?.inFlight).toBe(0);

			// Fill the rest of the allowance. The dead reservation holds one slot, so four more fit.
			const filledGrants: string[] = [];
			while (true) {
				const grantId = crypto.randomUUID();
				const result = admitAt(ledger, Date.now(), {}, grantId);
				if (result.kind !== "admitted") break;
				filledGrants.push(grantId);
			}
			expect(filledGrants.length).toBe(allowanceFromT2() - 2);

			// Control: against the same snapshot the ledger still refuses, so the dead reservation is counted.
			expect(admitAt(ledger, Date.now()).kind).toBe("wait");

			// Against a newer snapshot, the dead holder and the settled observer no longer count,
			// but live unsettled reservations from this process remain counted in pending and in-flight.
			const newer = Date.now() + 500;
			const inspected = ledger.inspect([window({ fetchedAt: newer })], Date.now(), LEAD)[0];
			expect(inspected?.pending).toBe(filledGrants.length);
			expect(inspected?.inFlight).toBe(filledGrants.length);

			// Settling the live reservations before the newer snapshot releases them too.
			for (const grantId of filledGrants) ledger.settle(grantId, "sent", newer - 100);
			const afterSettle = ledger.inspect([window({ fetchedAt: newer })], Date.now(), LEAD)[0];
			expect(afterSettle?.pending).toBe(0);
			expect(afterSettle?.inFlight).toBe(0);
			expect(admitAt(ledger, Date.now(), { fetchedAt: newer }).kind).toBe("admitted");
		} finally {
			ledger.close();
		}
	}, 20_000);
});

describe("reservations unreflected by a snapshot", () => {
	installFetchTripwire();

	test("a live unsettled row created before a newer snapshot changes a decision from admit to wait", () => {
		const ledger = UsageLedger.open(ledgerPath);
		try {
			calibrate(ledger);
			const t3 = t2 + 100;
			// At t3 with usedFraction 0.8, cost 0.1, headroom 0.9, allowance is (0.9 - 0.8) / 0.1 = 1 slot.
			// Without any unreflected reservations, an admission at t3 would succeed:
			const baseline = ledger.inspect([window({ fetchedAt: t3, usedFraction: 0.8 })], t3 + 1, LEAD)[0];
			expect(baseline?.pending).toBe(0);
			expect(baseline?.inFlight).toBe(0);

			// Admit a reservation before t3 that remains unsettled with a live process:
			const liveGrant = crypto.randomUUID();
			expect(admitAt(ledger, t3 - 10, { fetchedAt: t2 }, liveGrant).kind).toBe("admitted");

			// Against the newer snapshot at t3, the live unsettled reservation is counted in pending and in-flight:
			const inspected = ledger.inspect([window({ fetchedAt: t3, usedFraction: 0.8 })], t3 + 1, LEAD)[0];
			expect(inspected?.pending).toBe(1);
			expect(inspected?.inFlight).toBe(1);

			// Because the live unsettled row occupies the 1 available slot, admission changes from admit to wait:
			const result = admitAt(ledger, t3 + 1, { fetchedAt: t3, usedFraction: 0.8 });
			expect(result.kind).toBe("wait");
			if (result.kind === "wait") {
				expect(result.reason).toBe("reserve-held");
			}
		} finally {
			ledger.close();
		}
	});

	test("rows settled before the snapshot are not counted", () => {
		const ledger = UsageLedger.open(ledgerPath);
		try {
			calibrate(ledger);
			const t3 = t2 + 100;
			const grantId = crypto.randomUUID();
			expect(admitAt(ledger, t3 - 20, { fetchedAt: t2 }, grantId).kind).toBe("admitted");
			// Settled before the snapshot at t3 was observed:
			ledger.settle(grantId, "sent", t3 - 5);

			const inspected = ledger.inspect([window({ fetchedAt: t3, usedFraction: 0.8 })], t3 + 1, LEAD)[0];
			expect(inspected?.pending).toBe(0);
			expect(inspected?.inFlight).toBe(0);

			// The single slot is available because the earlier request already settled before t3:
			expect(admitAt(ledger, t3 + 1, { fetchedAt: t3, usedFraction: 0.8 }).kind).toBe("admitted");
		} finally {
			ledger.close();
		}
	});

	test("rows settled after the snapshot are counted", () => {
		const ledger = UsageLedger.open(ledgerPath);
		try {
			calibrate(ledger);
			const t3 = t2 + 100;
			const grantId = crypto.randomUUID();
			expect(admitAt(ledger, t3 - 20, { fetchedAt: t2 }, grantId).kind).toBe("admitted");
			// Settled after the snapshot at t3 was observed:
			ledger.settle(grantId, "sent", t3 + 10);

			const inspected = ledger.inspect([window({ fetchedAt: t3, usedFraction: 0.8 })], t3 + 1, LEAD)[0];
			// Settled after snapshot -> counted in pending (snapshot could not reflect it), not in flight:
			expect(inspected?.pending).toBe(1);
			expect(inspected?.inFlight).toBe(0);

			// The single slot is occupied, so admission waits:
			expect(admitAt(ledger, t3 + 1, { fetchedAt: t3, usedFraction: 0.8 }).kind).toBe("wait");
		} finally {
			ledger.close();
		}
	});

	test("a killed child process row created before the snapshot is not counted", async () => {
		const ledger = UsageLedger.open(ledgerPath);
		try {
			calibrate(ledger);
			// Child admits once and holds until killed:
			const holder = Bun.spawn([process.execPath, CHILD, JSON.stringify(childConfig({ mode: "hold" }))], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const reader = holder.stdout.getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			while (!buffered.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("holder exited before admitting");
				buffered += decoder.decode(chunk.value, { stream: true });
			}
			const holderEvent: ChildEvent = JSON.parse(buffered.split("\n")[0] ?? "{}");
			expect(holderEvent.kind).toBe("admitted");
			holder.kill("SIGKILL");
			await holder.exited;
			reader.releaseLock();

			// Snapshot observed after the child process was killed:
			const t3 = Date.now() + 50;
			const inspected = ledger.inspect([window({ fetchedAt: t3, usedFraction: 0.8 })], t3 + 1, LEAD)[0];
			expect(inspected?.pending).toBe(0);
			expect(inspected?.inFlight).toBe(0);

			// Since the killed process's reservation is not counted, admission succeeds:
			expect(admitAt(ledger, t3 + 1, { fetchedAt: t3, usedFraction: 0.8 }).kind).toBe("admitted");
		} finally {
			ledger.close();
		}
	}, 20_000);

	test("a row older than F - 15 min is not counted, while a row within 15 min is counted", () => {
		const ledger = UsageLedger.open(ledgerPath);
		try {
			calibrate(ledger);
			const t3 = Date.now();
			const oldGrant = crypto.randomUUID();

			// Insert a reservation created older than F - GOVERNOR_STALE_MS:
			const db = new Database(ledgerPath);
			try {
				db.query(
					`INSERT INTO reservations (grant_id, quota_key, generation, created_at_ms, settled_at_ms, pid, provider,
						credential_id, model_id, role, source, session_id, interactive)
					 VALUES (?, ?, ?, ?, NULL, ?, ?, 1, NULL, NULL, 'turn', NULL, 0)`,
				).run(oldGrant, QUOTA, generation, t3 - GOVERNOR_STALE_MS - 100, process.pid, PROVIDER);
			} finally {
				db.close();
			}

			// Older than F - 15 min: bounded out, not counted:
			const inspectedOld = ledger.inspect([window({ fetchedAt: t3, usedFraction: 0.8 })], t3 + 1, LEAD)[0];
			expect(inspectedOld?.pending).toBe(0);
			expect(inspectedOld?.inFlight).toBe(0);
			const firstAdmit = crypto.randomUUID();
			const admittedOld = admitAt(ledger, t3 + 1, { fetchedAt: t3, usedFraction: 0.8 }, firstAdmit);
			expect(admittedOld.kind).toBe("admitted");
			// Settle this admission before the next check:
			ledger.settle(firstAdmit, "sent", t3);

			// Insert a reservation within F - 15 min:
			const recentGrant = crypto.randomUUID();
			const db2 = new Database(ledgerPath);
			try {
				db2.query(
					`INSERT INTO reservations (grant_id, quota_key, generation, created_at_ms, settled_at_ms, pid, provider,
						credential_id, model_id, role, source, session_id, interactive)
					 VALUES (?, ?, ?, ?, NULL, ?, ?, 1, NULL, NULL, 'turn', NULL, 0)`,
				).run(recentGrant, QUOTA, generation, t3 - GOVERNOR_STALE_MS + 10_000, process.pid, PROVIDER);
			} finally {
				db2.close();
			}

			// Within F - 15 min and live/unsettled -> counted:
			const inspectedRecent = ledger.inspect([window({ fetchedAt: t3, usedFraction: 0.8 })], t3 + 1, LEAD)[0];
			expect(inspectedRecent?.pending).toBe(1);
			expect(inspectedRecent?.inFlight).toBe(1);
			expect(admitAt(ledger, t3 + 1, { fetchedAt: t3, usedFraction: 0.8 }).kind).toBe("wait");
		} finally {
			ledger.close();
		}
	});
});

describe("ledger failure fails open with a visible degraded state", () => {
	test("an unwritable ledger path admits without pacing and reports the ledger degraded", async () => {
		// The ledger path runs through a regular file, so its directory can never be created.
		const harness = await createHarness(ENABLED, "blocker/usage-governor.db");
		try {
			fs.writeFileSync(path.join(harness.dir, "blocker"), "not a directory");
			await seedAccounts(harness, PROVIDER, [
				{ accountId: "acc-open", email: "open@example.com", window: windowAt(60_000, 120_000, 0.1) },
			]);
			await seedReports(harness, PROVIDER);
			const credentialId = credentialIdOf(harness, PROVIDER, "acc-open");

			expect(await harness.storage.governor.admit({ credentialId, provider: PROVIDER })).toBeUndefined();
			const status = harness.storage.governor.status();
			expect(status.ledger).toBe("degraded");
			expect(status.degradedReason).toBeDefined();
			expect(harness.ledgerExists()).toBe(false);
			expectNoStrayFetch(harness);
		} finally {
			configureUsageAdmission(undefined);
			await disposeHarness();
		}
	});

	test("control: the same account with a writable ledger admits a reservation and reports ok", async () => {
		const harness = await createHarness(ENABLED);
		try {
			await seedAccounts(harness, PROVIDER, [
				{ accountId: "acc-open", email: "open@example.com", window: windowAt(60_000, 120_000, 0.1) },
			]);
			await seedReports(harness, PROVIDER);
			const credentialId = credentialIdOf(harness, PROVIDER, "acc-open");

			expect(await harness.storage.governor.admit({ credentialId, provider: PROVIDER })).toBeDefined();
			expect(harness.storage.governor.status().ledger).toBe("ok");
			expect(harness.reservations()).toHaveLength(1);
			expectNoStrayFetch(harness);
		} finally {
			await disposeHarness();
		}
	});
});
