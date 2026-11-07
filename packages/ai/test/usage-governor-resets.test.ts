/**
 * Banked resets are shown, never counted, and never redeemed by the governor (spec 3.8, 7.1). The account is
 * a Codex account with usable banked resets and a window over its line. The request must wait for the
 * window without any reset being spent, and without any provider block being written. The controls in the
 * same harness prove the detectors fire: an explicit redeem records one POST, and `markReached` writes a block.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { configureUsageAdmission } from "@oh-my-pi/pi-ai/usage-governor/admission";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { UsageResetCredits } from "@oh-my-pi/pi-ai/usage";
import {
	CODEX,
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	type Harness,
	expectNoStrayFetch,
	installFetchTripwire,
	seedAccounts,
	seedReports,
	windowAt,
} from "./fixtures/usage-governor/harness";

installFetchTripwire();

const ACCOUNT = "codex-a";
const SESSION = "session-codex";

beforeAll(() => {
	registerMockApi();
});

afterAll(() => {
	clearCustomApis();
});

function bankedResets(availableCount: number): UsageResetCredits {
	return {
		availableCount,
		redeemableCount: availableCount > 0 ? 1 : 0,
		eligible: true,
		credits: Array.from({ length: availableCount }, (_, index) => ({
			id: `credit-${index + 1}`,
			status: "available",
			usable: true,
			expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
		})),
	};
}

/** One Codex account, paced: 0.8 used at a window one quarter elapsed, with banked resets on offer. */
async function seedCodex(h: Harness, availableCount: number): Promise<void> {
	await seedAccounts(h, CODEX, [
		{
			accountId: ACCOUNT,
			email: "codex@example.com",
			window: windowAt(1_500, 2_000, 0.8),
			resetCredits: bankedResets(availableCount),
		},
	]);
	await seedReports(h, CODEX);
}

describe("banked resets are not counted and not spent", () => {
	test("the request waits for the window, the resets stay banked, and no reset is redeemed or blocked", async () => {
		const h = await createHarness(ENABLED);
		try {
			await seedCodex(h, 2);
			configureUsageAdmission(h.storage.governor);
			const sent: number[] = [];
			const model = createMockModel({
				provider: CODEX,
				handler: () => {
					sent.push(Date.now());
					return { content: ["ok"] };
				},
			});

			await streamSimple(
				model,
				{ systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					apiKey: h.storage.keys.resolver(CODEX, { sessionId: SESSION }),
					usageContext: { role: "default", source: "turn", interactive: true, sessionId: SESSION },
				},
			).result();

			// The request waited: the window over its line held it, and the banked resets did not open it.
			expect(sent).toHaveLength(1);
			const served = model.calls[0]?.options?.credentialId;
			const wait = h.storage.governor.status().waits.find(record => record.credentialId === served);
			expect(wait?.untilMs).toBeDefined();
			expect(sent[0] ?? 0).toBeGreaterThanOrEqual(wait?.untilMs ?? Number.POSITIVE_INFINITY);

			// Status lists the banked resets, shown and never counted.
			const windows = h.storage.governor.status({ provider: CODEX }).windows;
			expect(windows.find(window => window.bankedResets !== undefined)?.bankedResets).toMatchObject({
				available: 2,
				redeemable: 1,
			});

			// The fetch log holds only reads: no redemption POST, no write of any kind.
			expect(h.redemptionPosts()).toHaveLength(0);
			expect(h.usage.fetchLog.filter(entry => entry.method !== "GET")).toEqual([]);
			expect(h.blockRowCount()).toBe(0);
			expectNoStrayFetch(h);
		} finally {
			configureUsageAdmission(undefined);
			await disposeHarness();
		}
	}, 15_000);

	test("control: an explicit redeem in the same harness records exactly one reset POST", async () => {
		const h = await createHarness(ENABLED);
		try {
			await seedCodex(h, 2);
			const rowId = credentialIdOf(h, CODEX, ACCOUNT);
			await h.storage.resets.redeem({ target: { provider: CODEX, credentialId: rowId, creditId: "credit-1" } });
			expect(h.redemptionPosts()).toHaveLength(1);
		} finally {
			await disposeHarness();
		}
	});

	test("control: a provider limit mark in the same harness writes one block row", async () => {
		const h = await createHarness(ENABLED);
		try {
			await seedCodex(h, 2);
			expect(h.blockRowCount()).toBe(0);
			// The session must hold the account first, so the mark lands on it.
			await h.storage.keys.getWithCredential(CODEX, SESSION);
			await h.storage.limits.markReached(CODEX, SESSION, { retryAfterMs: 60_000 });
			expect(h.blockRowCount()).toBe(1);
		} finally {
			await disposeHarness();
		}
	});
});
