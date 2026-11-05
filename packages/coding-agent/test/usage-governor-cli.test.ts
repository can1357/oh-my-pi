/**
 * Real-CLI, multi-process proof of the built-in usage governor (spec 7.2). Every scenario runs
 * `omp` as a child process against a loopback fake provider and an egress tripwire, inside a temp
 * HOME with an allowlisted environment. Assertions read the fake's records, the ledger (opened
 * read-only) and `omp usage --json`; none of them trusts the child's own report.
 *
 * Real clock by design: the child paces against its own `Date.now()`, so these tests cannot run
 * under fake timers. Waits stay in seconds by placing resets inside the 60 s window. The only
 * polling is `awaitCondition` on an observable ledger row, with an explicit deadline.
 *
 * `OMP_PROOF_BINARY` runs the same scenarios against a compiled binary (spec 7.3).
 */
import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { FakeAccountSpec, FakeRecord } from "./fixtures/usage-governor/fake-provider";
import { WINDOW_MS } from "./fixtures/usage-governor/fake-provider";
import {
	awaitCondition,
	CHILD_PROBE,
	forbiddenNames,
	GovernorProof,
	type StatSnapshot,
	realHomeFixtureMarkerHits,
	statRealHome,
} from "./fixtures/usage-governor/harness";

/** Spec 3.4 parameters the proof's config pins: reserve 10 %, lead 25 %, 60 s windows. */
const RESERVE = 0.1;
const LEAD = 0.25;
/** Float slack on a line comparison; the policy's own epsilon is 1e-9. */
const LINE_TOLERANCE = 1e-6;
/** Clock slack on an admission compared with its admissible time: one timer tick. */
const ADMISSION_SLACK_MS = 5;

/** The governor block of `omp usage --json`, validated at the process boundary. */
const GovernorJson = type({
	config: { enabled: "boolean", lead: "number", interactiveReserve: "'hold' | 'spend'" },
	windows: type({
		provider: "string",
		label: "string",
		state: "string",
		"credentialId?": "number",
		"accountLabel?": "string",
		"bankedResets?": { available: "number", "eligible?": "boolean", countedAs: "string" },
	}).array(),
}).or("null");

type GovernorStatus = typeof GovernorJson.infer;
type GovernorWindow = NonNullable<GovernorStatus>["windows"][number];

/** The spec 3.4 allowance line, written independently of the governor: the share of a window usable at `atMs`. */
function allowedAt(resetsAtMs: number, atMs: number): number {
	const elapsed = Math.min(Math.max((atMs - (resetsAtMs - WINDOW_MS)) / WINDOW_MS, 0), 1);
	return (1 - RESERVE) * (LEAD + (1 - LEAD) * elapsed);
}

/** A send that left the wire with its window above the line at the moment it was sent. */
function overLine(record: FakeRecord): boolean {
	if (record.usedFraction === undefined || record.resetsAt === undefined) return false;
	return record.usedFraction > allowedAt(record.resetsAt, record.atMs) + LINE_TOLERANCE;
}

/** Account spec for a `govplan` or `govplan-g` OAuth row. */
function account(
	provider: FakeAccountSpec["provider"],
	label: string,
	overrides: Partial<FakeAccountSpec> = {},
): FakeAccountSpec {
	return {
		provider,
		label,
		bearer: `tok-${provider}-${label}`,
		accountId: `acct-${provider}-${label}`,
		email: `${provider}-${label}@example.invalid`,
		usedFraction: 0,
		resetInMs: 50_000,
		perRequest: 0.1,
		...overrides,
	};
}

/** Parse the governor block, failing the test on any shape the CLI does not promise. */
function governorOf(json: Record<string, unknown>): GovernorStatus {
	return GovernorJson.assert(json.governor);
}

/** Windows of one account, found by the email its identity label carries. */
function windowsFor(status: GovernorStatus, email: string): GovernorWindow[] {
	return (status?.windows ?? []).filter(window => window.accountLabel?.includes(email));
}

/** No proxied network connections are permitted during a scenario. */
function assertConfined(proof: GovernorProof): void {
	expect(proof.tripwire.records).toEqual([]);
}

/** Real-HOME baseline, taken when this file loads: before any scenario runs. */
const INITIAL_REAL_HOME: StatSnapshot[] = statRealHome();

describe("usage governor CLI proof: confinement", () => {
	test("the child environment is an allowlist with no inherited credentials or profile state", async () => {
		const canaries: Record<string, string> = {
			CANARY_API_KEY: "canary-api-key-value",
			CANARY_TOKEN: "canary-token-value",
			PI_CODING_AGENT_DIR: "/canary/agent-dir",
			OMP_PROFILE: "canary-profile",
			XDG_DATA_HOME: "/canary/xdg-data",
		};
		const saved: Record<string, string | undefined> = {};
		for (const [name, value] of Object.entries(canaries)) {
			saved[name] = process.env[name];
			process.env[name] = value;
		}
		const proof = await GovernorProof.create([account("govplan", "a")], { enabled: true });
		try {
			const probe = Bun.spawn([process.execPath, CHILD_PROBE, "env"], {
				env: { ...proof.env },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
			expect(exitCode).toBe(0);
			const { names } = JSON.parse(stdout) as { names: string[] };
			expect(forbiddenNames(names)).toEqual([]);
			for (const name of Object.keys(canaries)) expect(names).not.toContain(name);
			const values = Object.values(proof.env);
			for (const value of Object.values(canaries)) expect(values).not.toContain(value);
			expect(proof.env.HOME).toBe(proof.home);
			expect(proof.env.NO_PROXY).toBe("127.0.0.1,localhost");
		} finally {
			proof.close();
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}, 60_000);

	test("the tripwire records a non-loopback HTTPS egress attempt from the same environment", async () => {
		const proof = await GovernorProof.create([account("govplan", "a")], { enabled: true });
		try {
			const before = proof.tripwire.records.length;
			const probe = Bun.spawn([process.execPath, CHILD_PROBE, "egress", "https://example.invalid/"], {
				env: { ...proof.env },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
			expect(exitCode).toBe(0);
			// The tripwire refuses the tunnel, so the probe reports a proxy refusal and never a status.
			expect(stdout).toContain("502");
			const recorded = proof.tripwire.records.slice(before).map(record => record.requestLine);
			expect(recorded).toEqual(["CONNECT example.invalid:443 HTTP/1.1"]);
		} finally {
			proof.close();
		}
	}, 60_000);
});

describe("usage governor CLI proof: scenarios", () => {
	test("calibration and coordination: concurrent processes are serialised to the line; the control sends over it", async () => {
		// One account, 30 % used, reset 40 s away, 10 points per send. Phase one sends three requests and
		// invalidates; phase two runs two processes at once against the same ledger.
		const specs = [account("govplan", "a", { usedFraction: 0.3, resetInMs: 40_000, perRequest: 0.1 })];
		const proof = await GovernorProof.create(specs, { enabled: true });
		try {
			for (let index = 0; index < 3; index += 1) {
				expect((await proof.runOmp(["-p", `phase one ${index}`])).exitCode).toBe(0);
			}
			expect((await proof.invalidateUsage()).exitCode).toBe(0);
			const phaseTwoMs = Date.now();
			const phaseTwoStart = proof.chats().length;
			const [first, second] = await Promise.all([
				proof.runOmp(["-p", "phase two first"], 90_000),
				proof.runOmp(["-p", "phase two second"], 90_000),
			]);
			expect(first.exitCode).toBe(0);
			expect(second.exitCode).toBe(0);

			const phaseTwo = proof.chats().slice(phaseTwoStart);
			expect(phaseTwo.length).toBe(2);
			// Every phase-two send was on or under its line at the moment it went out (spec 3.4).
			expect(phaseTwo.filter(overLine)).toEqual([]);
			// The combined count stays inside the allowance: the window never exceeds 1 - reserve.
			for (const record of phaseTwo) expect(record.usedFraction).toBeLessThanOrEqual(1 - RESERVE + LINE_TOLERANCE);

			// Both processes waited on the line, and each was admitted no earlier than its admissible time.
			const waits = proof.readLedger().waits.filter(wait => wait.startedAtMs >= phaseTwoMs);
			expect(waits.length).toBe(2);
			for (const wait of waits) {
				expect(wait.outcome).toBe("admitted");
				expect(wait.untilMs).not.toBeNull();
				expect(wait.endedAtMs ?? 0).toBeGreaterThanOrEqual(
					(wait.untilMs ?? Number.POSITIVE_INFINITY) - ADMISSION_SLACK_MS,
				);
			}
			assertConfined(proof);
		} finally {
			proof.close();
		}
	}, 150_000);

	test("calibration control: with usageGovernor disabled the same run sends over the line and writes no ledger", async () => {
		const specs = [account("govplan", "a", { usedFraction: 0.3, resetInMs: 40_000, perRequest: 0.1 })];
		const proof = await GovernorProof.create(specs, { enabled: false });
		try {
			for (let index = 0; index < 3; index += 1) {
				expect((await proof.runOmp(["-p", `phase one ${index}`])).exitCode).toBe(0);
			}
			expect((await proof.invalidateUsage()).exitCode).toBe(0);
			const phaseTwoStart = proof.chats().length;
			const [first, second] = await Promise.all([
				proof.runOmp(["-p", "phase two first"]),
				proof.runOmp(["-p", "phase two second"]),
			]);
			expect(first.exitCode).toBe(0);
			expect(second.exitCode).toBe(0);
			const phaseTwo = proof.chats().slice(phaseTwoStart);
			expect(phaseTwo.length).toBe(2);
			// Nothing is paced without the governor: at least one send lands over the line.
			expect(phaseTwo.some(overLine)).toBe(true);
			expect(proof.ledgerExists()).toBe(false);
			expect(governorOf(await proof.usageJson())).toBeNull();
			assertConfined(proof);
		} finally {
			proof.close();
		}
	}, 120_000);

	test("routing: sends go to the account with headroom until it crosses its line, then to the fresh account", async () => {
		// A resets in 25 s with headroom; B is fresh with a full window ahead. Each send adds 0.2.
		const specs = [
			account("govplan", "a", { usedFraction: 0, resetInMs: 25_000, perRequest: 0.2 }),
			account("govplan", "b", { usedFraction: 0, resetInMs: 60_000, perRequest: 0.2 }),
		];
		const proof = await GovernorProof.create(specs, { enabled: true });
		try {
			for (let index = 0; index < 5; index += 1) {
				expect((await proof.runOmp(["-p", `route ${index}`])).exitCode).toBe(0);
			}
			const chats = proof.chats();
			const order = chats.map(record => record.label);
			const firstB = order.indexOf("b");
			expect(firstB).toBeGreaterThan(0);
			expect(order.slice(0, firstB).every(label => label === "a")).toBe(true);
			expect(order.slice(firstB).every(label => label === "b")).toBe(true);
			// Every send to A was on or under A's line at the moment it was sent.
			expect(chats.filter(record => record.label === "a").filter(overLine)).toEqual([]);
			// The move was forced by the line: A had already used more than half of its window.
			const lastA = chats.filter(record => record.label === "a").at(-1);
			expect(lastA?.usedFraction ?? 0).toBeGreaterThan(0.5);
			assertConfined(proof);
		} finally {
			proof.close();
		}
	}, 120_000);

	test("role restriction: default-role sends wait and never reach govplan-g; subagent sends are reserved as subagent", async () => {
		// Both govplan accounts sit at 50 % with the line already crossed. Both govplan-g accounts are fresh.
		const specs = [
			account("govplan", "a", { usedFraction: 0.5, resetInMs: 40_000 }),
			account("govplan", "b", { usedFraction: 0.5, resetInMs: 40_000 }),
			account("govplan-g", "a", { usedFraction: 0, resetInMs: 55_000 }),
			account("govplan-g", "b", { usedFraction: 0, resetInMs: 55_000 }),
		];
		const proof = await GovernorProof.create(specs, { enabled: true });
		try {
			const result = await proof.runOmp(["-p", "DELEGATE role restriction"], 90_000);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("done");

			const ledger = proof.readLedger();
			const chats = proof.chats();
			const subagentSends = chats.filter(record => record.provider === "govplan-g");
			const mainSends = chats.filter(record => record.provider === "govplan");
			expect(subagentSends.length).toBeGreaterThan(0);
			expect(mainSends.length).toBeGreaterThan(0);

			// Default-role requests were held on the paced govplan accounts before they were sent.
			expect(
				ledger.waits.filter(wait => wait.provider === "govplan" && wait.source === "turn").length,
			).toBeGreaterThan(0);

			// Each subagent send on govplan-g has a prior reservation carrying source "subagent". A send
			// reserves one row per applicable window, so the count is per grant, not per row.
			const subagentGrants = new Set(
				ledger.reservations
					.filter(reservation => reservation.provider === "govplan-g" && reservation.source === "subagent")
					.map(reservation => reservation.grantId),
			);
			expect(subagentGrants.size).toBe(subagentSends.length);
			for (const reservation of ledger.reservations.filter(row => row.provider === "govplan-g")) {
				expect(reservation.source).toBe("subagent");
				expect(reservation.role).toBe("task");
			}
			// The main model never reached govplan-g.
			expect(mainSends.every(record => record.provider === "govplan")).toBe(true);
			assertConfined(proof);
		} finally {
			proof.close();
		}
	}, 150_000);

	test("banked resets: a closed account stays closed, lists its resets as not counted, and gets no redeem call", async () => {
		// Both accounts sit at 95 % with usable banked resets. Sends must wait, and nothing may redeem.
		const specs = [
			account("govplan", "a", { usedFraction: 0.95, resetInMs: 50_000, bankedResets: { count: 2, usable: true } }),
			account("govplan", "b", { usedFraction: 0.95, resetInMs: 50_000, bankedResets: { count: 1, usable: true } }),
		];
		const proof = await GovernorProof.create(specs, { enabled: true });
		const probe = proof.spawnOmp(["-p", "banked reset probe"]);
		try {
			const engaged = await awaitCondition(() => proof.readLedger().waits.length > 0, 30_000);
			expect(engaged).toBe(true);

			const status = governorOf(await proof.usageJson());
			// The default: foreground requests keep the reserve too.
			expect(status?.config.interactiveReserve).toBe("hold");
			const sixtySecond = (status?.windows ?? []).filter(window => window.label === "60 Second");
			expect(sixtySecond.map(window => window.state)).toEqual(["closed", "closed"]);
			const banked = (status?.windows ?? []).filter(window => window.bankedResets !== undefined);
			expect(banked.map(window => window.bankedResets?.countedAs)).toEqual(["not counted", "not counted"]);
			expect(banked.map(window => window.bankedResets?.available).sort()).toEqual([1, 2]);

			// The window stays closed: nothing was sent, and no record is anything but usage or chat.
			expect(proof.chats().length).toBe(0);
			expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
			expect(proof.fake.account("a").usedFraction).toBe(0.95);
			expect(proof.fake.account("b").usedFraction).toBe(0.95);
		} finally {
			probe.kill("SIGINT");
			await probe.exited;
			try {
				assertConfined(proof);
			} finally {
				proof.close();
			}
		}
	}, 90_000);

	test("stale data: after invalidate a failing usage endpoint leaves its account unpaced and undelayed", async () => {
		// Account a is paced while its usage is known. After invalidation its usage endpoint fails.
		const specs = [
			account("govplan", "a", { usedFraction: 0.5, resetInMs: 40_000 }),
			account("govplan", "b", { usedFraction: 0, resetInMs: 58_000 }),
		];
		const proof = await GovernorProof.create(specs, { enabled: true });
		try {
			expect((await proof.runOmp(["-p", "warm"])).exitCode).toBe(0);
			const warm = windowsFor(governorOf(await proof.usageJson()), specs[0].email);
			expect(warm.some(window => window.state === "paced")).toBe(true);
			const credentialId = warm.find(window => window.credentialId !== undefined)?.credentialId;
			expect(credentialId).toBeDefined();

			proof.fake.patch("a", { failUsage: true });
			expect((await proof.invalidateUsage()).exitCode).toBe(0);
			const mark = proof.readLedger().waits.length;
			expect((await proof.runOmp(["-p", "after failure"])).exitCode).toBe(0);

			const after = windowsFor(governorOf(await proof.usageJson()), specs[0].email);
			// The failing account is not shown as paced: its windows are stale or unknown.
			expect(after.some(window => window.state === "paced")).toBe(false);
			expect(after.every(window => window.state === "stale" || window.state === "unknown")).toBe(true);
			// Nothing waited on account a after the failure.
			expect(
				proof
					.readLedger()
					.waits.slice(mark)
					.filter(wait => wait.credentialId === credentialId),
			).toEqual([]);
			assertConfined(proof);
		} finally {
			proof.close();
		}
	}, 120_000);

	test("abort: SIGINT during a wait sends nothing and leaves no reservation", async () => {
		// The only account is closed with its reset 30 s away, so the request waits until then.
		const specs = [account("govplan", "a", { usedFraction: 0.95, resetInMs: 30_000 })];
		const proof = await GovernorProof.create(specs, { enabled: true });
		const probe = proof.spawnOmp(["-p", "abort during wait"]);
		try {
			const waiting = await awaitCondition(
				() => proof.readLedger().waits.some(wait => wait.endedAtMs === null),
				30_000,
			);
			expect(waiting).toBe(true);
			probe.kill("SIGINT");
			expect(await probe.exited).not.toBe(0);

			expect(proof.chats().length).toBe(0);
			const ledger = proof.readLedger();
			expect(ledger.reservations).toEqual([]);
			expect(ledger.waits.some(wait => wait.outcome === "aborted")).toBe(true);
			expect(ledger.waits.filter(wait => wait.endedAtMs === null)).toEqual([]);
			assertConfined(proof);
		} finally {
			probe.kill();
			await probe.exited;
			proof.close();
		}
	}, 120_000);
});

describe("usage governor CLI proof: real home untouched", () => {
	test("no proof run created the real usage-governor.db or wrote a fixture into the real agent.db", () => {
		const now = statRealHome();
		// Existence is strict: the real usage-governor.db must not appear, and the real agent.db must not vanish.
		expect(now.map(file => file.exists)).toEqual(INITIAL_REAL_HOME.map(file => file.exists));
		expect(now[0]).toEqual(INITIAL_REAL_HOME[0]);
		// mtime is informational only: live OMP sessions on this machine write the real agent.db continuously.
		// What the proof can guarantee is that none of its fixtures reached the real database or its WAL.
		expect(realHomeFixtureMarkerHits()).toBe(0);
	});
});
