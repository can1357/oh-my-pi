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
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { sandboxCommand } from "./fixtures/usage-governor/confinement";
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
			const probe = Bun.spawn(sandboxCommand(proof, [process.execPath, CHILD_PROBE, "env"]), {
				env: {},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
			expect(exitCode).toBe(0);
			const { names, sockets } = JSON.parse(stdout) as { names: string[]; sockets: number[] };
			expect(sockets).toEqual([]);
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
			const probe = Bun.spawn(
				sandboxCommand(proof, [process.execPath, CHILD_PROBE, "egress", "https://example.invalid/"]),
				{
					env: {},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
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

	test("routing moves an automatic pin within one session when A crosses its pacing line", async () => {
		const proof = await GovernorProof.create(
			[
				account("govplan", "a", { usedFraction: 0, resetInMs: 25_000, perRequest: 0.2 }),
				account("govplan", "b", { usedFraction: 0, resetInMs: 60_000, perRequest: 0.2 }),
			],
			{ enabled: true },
		);
		try {
			const result = await proof.runOmp(["-p", "ROUTE_PIN"], 90_000);
			expect(result.exitCode).toBe(0);
			const chats = proof.chats();
			expect(chats.length).toBe(6);
			const pins =
				chats.at(-1)?.toolResults?.map(text => JSON.parse(text) as { sessionId: string; email: string }) ?? [];
			expect(pins.length).toBe(5);
			expect(new Set(pins.map(pin => pin.sessionId)).size).toBe(1);
			expect(pins[0].sessionId.length).toBeGreaterThan(0);
			for (let index = 0; index < pins.length; index += 1) {
				expect(pins[index].email).toBe(`govplan-${chats[index].label}@example.invalid`);
			}
			const firstB = pins.findIndex(pin => pin.email === "govplan-b@example.invalid");
			expect(firstB).toBeGreaterThan(0);
			expect(pins.slice(0, firstB).every(pin => pin.email === "govplan-a@example.invalid")).toBe(true);
			expect(pins.slice(firstB).every(pin => pin.email === "govplan-b@example.invalid")).toBe(true);
			// The next fixed-cost request would cross A's line (and its 90% reserve).
			expect((chats[firstB - 1].usedFraction ?? 0) + 0.2).toBeGreaterThan(
				allowedAt(chats[firstB - 1].resetsAt!, chats[firstB].atMs),
			);
			assertConfined(proof);
		} finally {
			proof.close();
		}
	}, 120_000);

	test("routing prefers included allowance to a credit-serving account", async () => {
		const proof = await GovernorProof.create(
			[
				account("govplan", "credit", { usedFraction: 1, resetInMs: 25_000, perRequest: 0, creditBalance: 100 }),
				account("govplan", "included", { usedFraction: 0, resetInMs: 60_000, perRequest: 0.05 }),
			],
			{ enabled: true },
		);
		try {
			const result = await proof.runOmp(["-p", "credit routing"]);
			expect(result.exitCode).toBe(0);
			const usage = proof.fake.records.filter(record => record.kind === "usage");
			expect(usage.some(record => record.label === "credit" && record.usedFraction === 1)).toBe(true);
			expect(usage.some(record => record.label === "included" && record.usedFraction === 0)).toBe(true);
			expect(proof.chats().map(record => record.label)).toEqual(["included"]);
			assertConfined(proof);
		} finally {
			proof.close();
		}
		// With no included sibling and the governor disabled, the same spent account
		// still serves a request using its paid balance.
		const control = await GovernorProof.create(
			[account("govplan", "credit", { usedFraction: 1, resetInMs: 25_000, perRequest: 0, creditBalance: 100 })],
			{ enabled: false },
		);
		try {
			expect((await control.runOmp(["-p", "credit control"])).exitCode).toBe(0);
			expect(control.chats().map(record => record.label)).toEqual(["credit"]);
			assertConfined(control);
		} finally {
			control.close();
		}
	}, 120_000);

	test("proactive fallback uses the configured default chain when the primary is paced", async () => {
		const proof = await GovernorProof.create(
			[
				account("govplan", "a", { usedFraction: 0.8, resetInMs: 58_000 }),
				account("govplan-g", "b", { usedFraction: 0, resetInMs: 58_000 }),
			],
			{
				enabled: true,
				modelRoles: { default: "govplan/m", task: "govplan/m" },
				fallbackChains: { default: ["govplan-g/m"], task: [] },
			},
		);
		let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
		try {
			const status = governorOf(await proof.usageJson());
			expect(windowsFor(status, "govplan-g-b@example.invalid").some(window => window.state === "open")).toBe(true);
			expect(proof.fake.records.some(record => record.kind === "usage" && record.label === "b")).toBe(true);
			child = proof.spawnOmp(["-p", "WARM_FALLBACK proactive fallback"]);
			const stderr = new Response(child.stderr).text();
			const routed = await awaitCondition(() => proof.chats().length > 0, 20_000);
			if (!routed) {
				child.kill("SIGINT");
				await child.exited;
				throw new Error(
					`no fallback send: ${JSON.stringify({ records: proof.fake.records, ledger: proof.readLedger(), stderr: await stderr })}`,
				);
			}
			expect(proof.chats().map(record => record.provider)).toEqual(["govplan-g"]);
			expect(proof.fake.records.some(record => record.kind === "usage" && record.label === "a")).toBe(true);
			expect(proof.fake.records.some(record => record.kind === "usage" && record.label === "b")).toBe(true);
			expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
			assertConfined(proof);
		} finally {
			child?.kill("SIGINT");
			if (child) await child.exited;
			proof.close();
		}
	}, 60_000);

	test("fallback tie-break uses only fresh, eligible, covering banked reset expiry", async () => {
		const covering = ["requests-60s", "requests-7d"];
		const valid = { count: 1, usable: true, clears: covering };
		const cases: Array<{
			name: string;
			first: FakeAccountSpec["bankedResets"];
			second: FakeAccountSpec["bankedResets"];
			expected: string;
		}> = [
			{
				name: "earlier second",
				first: { ...valid, expiresInMs: 7_200_000 },
				second: { ...valid, expiresInMs: 3_600_000 },
				expected: "second",
			},
			{
				name: "earlier first",
				first: { ...valid, expiresInMs: 3_600_000 },
				second: { ...valid, expiresInMs: 7_200_000 },
				expected: "first",
			},
			{
				name: "stale",
				first: { ...valid, expiresInMs: 7_200_000 },
				second: { ...valid, expiresInMs: 3_600_000, observedAgoMs: 86_400_000 },
				expected: "first",
			},
			{
				name: "ineligible",
				first: { ...valid, expiresInMs: 7_200_000 },
				second: { ...valid, expiresInMs: 3_600_000, eligible: false },
				expected: "first",
			},
			{
				name: "unusable",
				first: { ...valid, expiresInMs: 7_200_000 },
				second: { ...valid, usable: false, eligible: true, expiresInMs: 3_600_000 },
				expected: "first",
			},
			{
				name: "expired",
				first: { ...valid, expiresInMs: 7_200_000 },
				second: { ...valid, expiresInMs: -3_600_000 },
				expected: "first",
			},
			{
				name: "empty",
				first: { ...valid, expiresInMs: 7_200_000 },
				second: { ...valid, count: 0, expiresInMs: 3_600_000 },
				expected: "first",
			},
			{
				name: "uncovered",
				first: { ...valid, expiresInMs: 7_200_000 },
				second: { ...valid, expiresInMs: 3_600_000, clears: ["requests-60s"] },
				expected: "first",
			},
			{ name: "absent", first: undefined, second: undefined, expected: "first" },
		];
		for (const scenario of cases) {
			const proof = await GovernorProof.create(
				[
					account("govplan", "primary", { usedFraction: 0.8, resetInMs: 58_000 }),
					account("govplan-g", "first", { perRequest: 0, resetInMs: 58_000, bankedResets: scenario.first }),
					account("govplan-h", "second", { perRequest: 0, resetInMs: 58_000, bankedResets: scenario.second }),
				],
				{
					enabled: true,
					roleProtection: "off",
					modelRoles: { default: "govplan/m", task: "govplan/m" },
					fallbackChains: { default: ["govplan-g/m", "govplan-h/m"], task: [] },
				},
			);
			try {
				const result = await proof.runOmp(["-p", `WARM_FALLBACK reset ${scenario.name}`], 30_000);
				expect(result.exitCode).toBe(0);
				expect(proof.chats().map(record => record.label)).toEqual([scenario.expected]);
				for (const label of ["first", "second"]) {
					expect(proof.fake.records.some(record => record.kind === "usage" && record.label === label)).toBe(true);
				}
				expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
				const db = new Database(path.join(proof.agentDir, "agent.db"));
				try {
					expect(db.query("SELECT * FROM auth_credential_blocks").all()).toEqual([]);
					db.run("BEGIN");
					try {
						db.run(
							"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) SELECT id, 'fixture', 'fixture', ?, ? FROM auth_credentials LIMIT 1",
							[Date.now() + 60_000, Date.now()],
						);
						expect(db.query("SELECT * FROM auth_credential_blocks").all()).toHaveLength(1);
					} finally {
						db.run("ROLLBACK");
					}
				} finally {
					db.close();
				}
				assertConfined(proof);
			} finally {
				proof.close();
			}
		}
	}, 240_000);

	test("a flexible role protects a constrained role's shared account", async () => {
		for (const roleProtection of ["prefer-alternatives", "off"] as const) {
			const proof = await GovernorProof.create(
				[
					account("govplan", "a", { usedFraction: 0, resetInMs: 58_000 }),
					account("govplan-g", "b", { usedFraction: 0, resetInMs: 58_000 }),
				],
				{
					enabled: true,
					roleProtection,
					modelRoles: { default: "govplan/m", task: "govplan/m" },
					fallbackChains: { default: ["govplan-g/m"], task: [] },
				},
			);
			try {
				const result = await proof.runOmp(["-p", "WARM_FALLBACK protection"]);
				expect(result.exitCode).toBe(0);
				expect(proof.chats().map(record => record.provider)).toEqual([
					roleProtection === "off" ? "govplan" : "govplan-g",
				]);
				expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
				assertConfined(proof);
			} finally {
				proof.close();
			}
		}
	}, 120_000);
	test("an unprobed fallback remains unknown and cannot escape to paid capacity", async () => {
		const proof = await GovernorProof.create(
			[
				account("govplan", "a", { usedFraction: 0.8, resetInMs: 58_000 }),
				account("govplan-g", "b", { usedFraction: 1, resetInMs: 58_000, creditBalance: 100 }),
			],
			{
				enabled: true,
				modelRoles: { default: "govplan/m", task: "govplan/m" },
				fallbackChains: { default: ["govplan-g/m"], task: [] },
			},
		);
		const child = proof.spawnOmp(["-p", "unknown fallback"]);
		try {
			expect(await awaitCondition(() => proof.readLedger().waits.length > 0, 20_000)).toBe(true);
			expect(proof.fake.records.some(record => record.kind === "usage" && record.label === "b")).toBe(false);
			expect(proof.chats()).toEqual([]);
			expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
			assertConfined(proof);
		} finally {
			child.kill("SIGINT");
			await child.exited;
			proof.close();
		}
	}, 60_000);

	test("a selected primary falls back within the same session after crossing its line", async () => {
		const proof = await GovernorProof.create(
			[
				account("govplan", "a", { usedFraction: 0, resetInMs: 58_000, perRequest: 0.4 }),
				account("govplan-g", "b", { usedFraction: 0, resetInMs: 58_000, perRequest: 0.01 }),
			],
			{
				enabled: true,
				roleProtection: "off",
				modelRoles: { default: "govplan/m", task: "govplan/m" },
				fallbackChains: { default: ["govplan-g/m"], task: [] },
			},
		);
		let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
		try {
			const status = governorOf(await proof.usageJson());
			expect(windowsFor(status, "govplan-g-b@example.invalid").some(window => window.state === "open")).toBe(true);
			child = proof.spawnOmp(["-p", "WARM_FALLBACK ROUTE_PIN"]);
			if (!(await awaitCondition(() => proof.chats().length >= 2, 20_000))) {
				child.kill("SIGINT");
				await child.exited;
				throw new Error(
					`missing second chat: ${JSON.stringify({ records: proof.fake.records, ledger: proof.readLedger(), stderr: await new Response(child.stderr).text() })}`,
				);
			}
			expect(
				proof
					.chats()
					.slice(0, 2)
					.map(record => record.provider),
			).toEqual(["govplan", "govplan-g"]);
			expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
			assertConfined(proof);
		} finally {
			child?.kill("SIGINT");
			if (child) await child.exited;
			proof.close();
		}
	}, 60_000);

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
		// Keep one account so the post-failure request must use the account whose usage failed.
		// At 85% used and a reset 58 seconds away, its pacing line remains crossed for about 53 seconds.
		const specs = [account("govplan", "a", { usedFraction: 0.85, resetInMs: 58_000 })];
		const proof = await GovernorProof.create(specs, { enabled: true });
		try {
			const warm = windowsFor(governorOf(await proof.usageJson()), specs[0].email);
			expect(warm.some(window => window.state === "paced")).toBe(true);
			const credentialId = warm.find(window => window.credentialId !== undefined)?.credentialId;
			expect(credentialId).toBeDefined();

			// The same account must really wait while usage is healthy, not just display a paced state.
			const healthy = proof.spawnOmp(["-p", "healthy usage"]);
			try {
				expect(
					await awaitCondition(
						() => proof.readLedger().waits.some(wait => wait.credentialId === credentialId),
						30_000,
					),
				).toBe(true);
				expect(proof.chats()).toEqual([]);
			} finally {
				healthy.kill("SIGINT");
				await healthy.exited;
			}

			proof.fake.patch("a", { failUsage: true });
			expect((await proof.invalidateUsage()).exitCode).toBe(0);
			const recordMark = proof.fake.records.length;
			const mark = proof.readLedger().waits.length;
			expect((await proof.runOmp(["-p", "after failure"])).exitCode).toBe(0);
			const records = proof.fake.records.slice(recordMark);
			const failedUsage = records.findIndex(record => record.kind === "usage" && record.label === "a");
			const sent = records.findIndex(record => record.kind === "chat" && record.label === "a");
			expect(failedUsage).toBeGreaterThanOrEqual(0);
			expect(sent).toBeGreaterThan(failedUsage);
			const chat = records[sent];
			expect(chat.resetsAt).toBeDefined();
			expect(specs[0].usedFraction).toBeGreaterThan(allowedAt(chat.resetsAt!, chat.atMs));

			const after = windowsFor(governorOf(await proof.usageJson()), specs[0].email);
			// A failed usage fetch may omit the account; any reported windows must not claim it is paced.
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
		const stderr = new Response(probe.stderr).text();
		const lifecycle: unknown[] = [{ event: "spawn", pid: probe.pid, exitCode: probe.exitCode, killed: probe.killed }];
		let failed = false;
		try {
			const waiting = await awaitCondition(
				() => proof.readLedger().waits.some(wait => wait.endedAtMs === null),
				30_000,
			);
			expect(waiting).toBe(true);
			lifecycle.push({ event: "wait observed", pid: probe.pid, exitCode: probe.exitCode, killed: probe.killed });
			probe.kill("SIGINT");
			lifecycle.push({ event: "SIGINT sent", pid: probe.pid, exitCode: probe.exitCode, killed: probe.killed });
			expect(await probe.exited).not.toBe(0);
			lifecycle.push({ event: "exited", pid: probe.pid, exitCode: probe.exitCode, killed: probe.killed });

			expect(proof.chats().length).toBe(0);
			const ledger = proof.readLedger();
			expect(ledger.reservations).toEqual([]);
			expect(ledger.waits.some(wait => wait.outcome === "aborted")).toBe(true);
			expect(ledger.waits.filter(wait => wait.endedAtMs === null)).toEqual([]);
			assertConfined(proof);
		} catch (error) {
			failed = true;
			lifecycle.push({
				event: "failure",
				pid: probe.pid,
				exitCode: probe.exitCode,
				killed: probe.killed,
				files: proof.ledgerDiagnostics(),
			});
			throw error;
		} finally {
			probe.kill();
			await probe.exited;
			if (failed) console.error("abort probe diagnostics:", JSON.stringify({ lifecycle, stderr: await stderr }));
			proof.close();
		}
	}, 120_000);
});

describe("usage governor CLI proof: stored API key", () => {
	for (const enabled of [true, false]) {
		test(`stored API key ${enabled ? "waits on its row before chat" : "sends immediately with governor disabled"}`, async () => {
			const spec = account("govplan", "key", {
				authType: "api_key",
				usedFraction: 0.6,
				resetInMs: 35_000,
				perRequest: 0,
			});
			const proof = await GovernorProof.create([spec], { enabled, fallbackChains: { default: [] } });
			try {
				const db = new Database(path.join(proof.agentDir, "agent.db"), { readonly: true });
				let row: { id: number; credential_type: string } | null;
				try {
					row = db
						.query<{ id: number; credential_type: string }, [string]>(
							"SELECT id, credential_type FROM auth_credentials WHERE provider = ?",
						)
						.get("govplan");
				} finally {
					db.close();
				}
				expect(row?.credential_type).toBe("api_key");
				const result = await proof.runOmp(["-p", "WARM_API_KEY key pacing"], 40_000);
				expect(result.exitCode).toBe(0);
				const chats = proof.chats();
				expect(chats).toHaveLength(1);
				expect(chats[0].bearer).toBe(spec.bearer);
				const usage = proof.fake.records.find(record => record.kind === "usage" && record.bearer === spec.bearer);
				expect(usage).toBeDefined();
				const admissible =
					usage!.resetsAt! - WINDOW_MS + ((spec.usedFraction / (1 - RESERVE) - LEAD) / (1 - LEAD)) * WINDOW_MS;
				if (enabled) {
					const waits = proof.readLedger().waits;
					expect(waits).toHaveLength(1);
					expect(waits[0].credentialId).toBe(row!.id);
					expect(waits[0].provider).toBe("govplan");
					expect(waits[0].outcome).toBe("admitted");
					expect(waits[0].untilMs).not.toBeNull();
					expect(waits[0].endedAtMs!).toBeGreaterThanOrEqual(waits[0].untilMs! - ADMISSION_SLACK_MS);
					expect(chats[0].atMs).toBeGreaterThanOrEqual(waits[0].endedAtMs!);
					expect(chats[0].atMs).toBeGreaterThanOrEqual(admissible - ADMISSION_SLACK_MS);
					expect(waits[0].endedAtMs! - waits[0].startedAtMs).toBeGreaterThan(1_000);
				} else {
					expect(chats[0].atMs).toBeLessThan(admissible);
					expect(proof.ledgerExists()).toBe(false);
				}
				expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
				assertConfined(proof);
			} finally {
				proof.close();
			}
		}, 60_000);
	}

	test("stored API key routes to a verified included API key fallback", async () => {
		const primary = account("govplan", "primary-key", { authType: "api_key", usedFraction: 0.8, resetInMs: 58_000 });
		const fallback = account("govplan-g", "fallback-key", {
			authType: "api_key",
			usedFraction: 0,
			resetInMs: 58_000,
		});
		const proof = await GovernorProof.create([primary, fallback], {
			enabled: true,
			roleProtection: "off",
			modelRoles: { default: "govplan/m", task: "govplan/m" },
			fallbackChains: { default: ["govplan-g/m"], task: [] },
		});
		try {
			const db = new Database(path.join(proof.agentDir, "agent.db"), { readonly: true });
			let row: { id: number; credential_type: string } | null;
			try {
				row = db
					.query<{ id: number; credential_type: string }, [string]>(
						"SELECT id, credential_type FROM auth_credentials WHERE provider = ?",
					)
					.get("govplan-g");
			} finally {
				db.close();
			}
			expect(row?.credential_type).toBe("api_key");
			const result = await proof.runOmp(["-p", "WARM_API_KEY WARM_FALLBACK included fallback"], 30_000);
			expect(result.exitCode).toBe(0);
			expect(proof.fake.records.some(record => record.kind === "usage" && record.bearer === fallback.bearer)).toBe(
				true,
			);
			expect(proof.chats().map(record => record.bearer)).toEqual([fallback.bearer]);
			const reservations = proof.readLedger().reservations.filter(item => item.provider === "govplan-g");
			expect(reservations.length).toBeGreaterThan(0);
			expect(reservations.every(item => item.credentialId === row!.id)).toBe(true);
			expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
			assertConfined(proof);
		} finally {
			proof.close();
		}
	}, 60_000);

	for (const allowance of ["unknown", "metered"] as const) {
		test(`stored API key ${allowance} fallback cannot proactively spend`, async () => {
			const primary = account("govplan", "key", {
				authType: "api_key",
				usedFraction: 0.6,
				resetInMs: 35_000,
				perRequest: 0,
			});
			const paid = account("govplan-g", allowance, {
				authType: "api_key",
				usedFraction: 0,
				perRequest: 0,
				creditBalance: 100,
			});
			const proof = await GovernorProof.create([primary, paid], {
				enabled: true,
				modelRoles: { default: "govplan/m", task: "govplan/m" },
				fallbackChains: { default: ["govplan-g/m"], task: [] },
			});
			try {
				const result = await proof.runOmp(["-p", "WARM_API_KEY WARM_FALLBACK fallback safety"], 40_000);
				expect(result.exitCode).toBe(0);
				expect(proof.fake.records.some(record => record.kind === "usage" && record.bearer === paid.bearer)).toBe(
					true,
				);
				expect(proof.chats().map(record => record.bearer)).toEqual([primary.bearer]);
				expect(
					proof.readLedger().waits.some(wait => wait.provider === "govplan" && wait.outcome === "admitted"),
				).toBe(true);
				expect(proof.fake.records.filter(record => record.kind === "unexpected")).toEqual([]);
				assertConfined(proof);
			} finally {
				proof.close();
			}
		}, 60_000);
	}
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
