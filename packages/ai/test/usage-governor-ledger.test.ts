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
import { governorGeneration } from "@oh-my-pi/pi-ai/usage-governor/policy";
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
	for (const offset of [1, 2, 3]) admitAt(ledger, t1 + offset, { fetchedAt: t1, usedFraction: 0 });
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
			let filled = 0;
			while (admitAt(ledger, Date.now()).kind === "admitted") filled += 1;
			expect(filled).toBe(allowanceFromT2() - 2);

			// Control: against the same snapshot the ledger still refuses, so the dead reservation is counted.
			expect(admitAt(ledger, Date.now()).kind).toBe("wait");

			// A newer snapshot is later than every reservation, so none of them count any more.
			const newer = Date.now() + 500;
			expect(ledger.inspect([window({ fetchedAt: newer })], Date.now(), LEAD)[0]?.pending).toBe(0);
			expect(admitAt(ledger, Date.now(), { fetchedAt: newer }).kind).toBe("admitted");
		} finally {
			ledger.close();
		}
	}, 20_000);
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
