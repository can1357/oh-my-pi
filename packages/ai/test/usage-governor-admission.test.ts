/**
 * Dispatch admission through `streamSimple` (spec 5 Slice B, 7.1). A recording mock transport stands in
 * for the provider: the time it is dispatched to is the send time, and its `credentialId` is the account
 * that served the request. The admission seam is registered only for the duration of each test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { configureUsageAdmission } from "@oh-my-pi/pi-ai/usage-governor/admission";
import type { Context } from "@oh-my-pi/pi-ai/types";
import {
	createHarness,
	disposeHarness,
	DISABLED,
	ENABLED,
	expectNoStrayFetch,
	type Harness,
	installFetchTripwire,
	PROVIDER,
	seedAccounts,
	seedReports,
} from "./fixtures/usage-governor/harness";

installFetchTripwire();

/** Short windows keep the real paced waits near a second. */
const RESET_IN = 1_500;
const DURATION = 2_000;
const RESERVE = 0.1;
const LEAD = 0.25;
/** Used fraction of each account. Both sit past their line, so whichever serves the request must wait. */
const USED = { "acc-a": 0.8, "acc-b": 0.85 } as const;

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
}

/**
 * Two accounts past their line. Returns the fixture's reset time, so the admissible time can be derived
 * from the window itself rather than read back from the governor.
 */
async function pacedPair(h: Harness): Promise<number> {
	const resetsAt = Date.now() + RESET_IN;
	await seedAccounts(h, PROVIDER, [
		{ accountId: "acc-a", email: "a@example.com", window: { used: USED["acc-a"], resetsAt, durationMs: DURATION } },
		{ accountId: "acc-b", email: "b@example.com", window: { used: USED["acc-b"], resetsAt, durationMs: DURATION } },
	]);
	await seedReports(h, PROVIDER);
	return resetsAt;
}

/**
 * The instant the line reaches `used` plus the reserve, from the window alone: the request is admitted at
 * `resetsAt - D + D * x` with `x = (used / (1 - reserve) - lead) / (1 - lead)`.
 */
function admissibleFromWindow(resetsAt: number, used: number): number {
	const x = (used / (1 - RESERVE) - LEAD) / (1 - LEAD);
	return resetsAt - DURATION + DURATION * x;
}

function accountIdOf(h: Harness, credentialId: number): string | undefined {
	return h.storage.oauth.accounts(PROVIDER).find(account => account.credentialId === credentialId)?.accountId;
}

beforeAll(() => {
	registerMockApi();
});

afterAll(() => {
	clearCustomApis();
});

describe("governed dispatch", () => {
	test("the transport is reached only at or after the admissible time of the account that served it", async () => {
		const h = await createHarness(ENABLED);
		try {
			const resetsAt = await pacedPair(h);
			configureUsageAdmission(h.storage.governor);
			const sentAt: number[] = [];
			const model = createMockModel({
				provider: PROVIDER,
				handler: () => {
					sentAt.push(Date.now());
					return { content: ["ok"] };
				},
			});

			const sessionId = "session-admission";
			await streamSimple(model, context(), {
				apiKey: h.storage.keys.resolver(PROVIDER, { sessionId }),
				usageContext: { role: "default", source: "turn", interactive: true, sessionId },
			}).result();

			expect(sentAt).toHaveLength(1);
			const served = model.calls[0]?.options?.credentialId;
			if (served === undefined) throw new Error("the governed request carried no credential id");
			const servedAccount = accountIdOf(h, served);
			if (servedAccount !== "acc-a" && servedAccount !== "acc-b") throw new Error("unknown served account");

			// The governor's wait agrees with the admissible time derived from the window itself.
			const expected = admissibleFromWindow(resetsAt, USED[servedAccount]);
			const wait = h.storage.governor.status().waits.find(record => record.credentialId === served);
			expect(wait?.untilMs).toBeDefined();
			expect(wait?.untilMs ?? Number.NaN).toBeCloseTo(expected, -1);
			// The send happened no earlier than that instant.
			expect(sentAt[0] ?? 0).toBeGreaterThanOrEqual(expected);
			// The governed request reserved one allowance slot when it was admitted.
			expect(h.reservations()).toHaveLength(1);
			expect(h.ledgerExists()).toBe(true);
			expectNoStrayFetch(h);
		} finally {
			await disposeHarness();
		}
	}, 15_000);

	test("abort mid-wait sends nothing, leaves no reservation, and records the wait as aborted", async () => {
		const h = await createHarness(ENABLED);
		try {
			await pacedPair(h);
			configureUsageAdmission(h.storage.governor);
			const sent: number[] = [];
			const model = createMockModel({
				provider: PROVIDER,
				handler: () => {
					sent.push(Date.now());
					return { content: ["ok"] };
				},
			});

			const controller = new AbortController();
			const reason = new Error("caller cancelled mid-wait");
			// Abort exactly when the governor starts waiting, so the abort lands mid-wait without a real timer.
			const unsubscribe = h.storage.governor.onEvent(event => {
				if (event.kind === "wait-start") controller.abort(reason);
			});
			const sessionId = "session-abort";
			const outcome = await streamSimple(model, context(), {
				apiKey: h.storage.keys.resolver(PROVIDER, { sessionId }),
				signal: controller.signal,
				usageContext: { role: "default", source: "turn", interactive: true, sessionId },
			})
				.result()
				.then(
					() => "completed",
					(error: unknown) => error,
				);
			unsubscribe();

			expect(outcome).toBe(reason);
			expect(sent).toHaveLength(0);
			expect(h.reservations()).toHaveLength(0);
			expect(h.storage.governor.status().waits.some(record => record.outcome === "aborted")).toBe(true);
			expectNoStrayFetch(h);
		} finally {
			await disposeHarness();
		}
	}, 15_000);

	test("control: the same wait without an abort is dispatched and reserves one slot", async () => {
		const h = await createHarness(ENABLED);
		try {
			await pacedPair(h);
			configureUsageAdmission(h.storage.governor);
			const sent: number[] = [];
			const model = createMockModel({
				provider: PROVIDER,
				handler: () => {
					sent.push(Date.now());
					return { content: ["ok"] };
				},
			});
			const sessionId = "session-abort-control";
			await streamSimple(model, context(), {
				apiKey: h.storage.keys.resolver(PROVIDER, { sessionId }),
				usageContext: { role: "default", source: "turn", interactive: true, sessionId },
			}).result();
			expect(sent).toHaveLength(1);
			expect(h.reservations()).toHaveLength(1);
		} finally {
			await disposeHarness();
		}
	}, 15_000);

	test("with the governor disabled the same accounts are dispatched at once and no ledger file is created", async () => {
		const h = await createHarness(DISABLED);
		try {
			await pacedPair(h);
			configureUsageAdmission(h.storage.governor);
			const sent: number[] = [];
			const model = createMockModel({
				provider: PROVIDER,
				handler: () => {
					sent.push(Date.now());
					return { content: ["ok"] };
				},
			});
			const start = Date.now();
			await streamSimple(model, context(), {
				apiKey: h.storage.keys.resolver(PROVIDER, { sessionId: "session-disabled" }),
				usageContext: { role: "default", source: "turn", interactive: true, sessionId: "session-disabled" },
			}).result();

			expect(sent).toHaveLength(1);
			// Well inside the window that the enabled governor waits out (about a second here).
			expect((sent[0] ?? Number.POSITIVE_INFINITY) - start).toBeLessThan(500);
			expect(h.ledgerExists()).toBe(false);
			expect(h.storage.governor.status().waits).toHaveLength(0);
			expectNoStrayFetch(h);
		} finally {
			await disposeHarness();
		}
	}, 15_000);
});
