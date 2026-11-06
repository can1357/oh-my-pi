import { expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { authService } from "../src/thread/services/auth";
import { type ServiceWorker, startServiceWorker } from "./helpers/service-worker";
import type { Probe } from "./fixtures/usage-governor-worker-revocation/worker";
import {
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	expectNoStrayFetch,
	PROVIDER,
	seedAccounts,
	seedReports,
	windowAt,
} from "../../ai/test/fixtures/usage-governor/harness";

for (const mutation of ["remove", "endpoint", "none"] as const) {
	test(`worker bound send at the provider slot: ${mutation}`, async () => {
		const h = await createHarness(ENABLED);
		let worker: ServiceWorker<Probe> | undefined;
		const settle = spyOn(h.storage.governor, "settle");
		try {
			const original = h.usage.provider.bind(h.usage);
			h.usage.provider = id => {
				const provider = original(id);
				return {
					...provider,
					governorAllowance: () => ["primary"],
					fetchUsage: async (params, ctx) => {
						const report = await provider.fetchUsage(params, ctx);
						if (report) for (const limit of report.limits) limit.observedAt = Date.now();
						return report;
					},
				};
			};
			await seedAccounts(h, PROVIDER, [
				{ accountId: "a", email: "a@example.test", window: windowAt(30_000, 60_000, 0.1) },
			]);
			await seedReports(h, PROVIDER);
			const registry = new ModelRegistry(h.storage, path.join(h.dir, "models.yml"));
			const config = (baseUrl: string) => ({
				api: "openai-completions" as const,
				baseUrl,
				oauth: {
					name: "synthetic",
					login: async () => {
						throw new Error("unexpected OAuth login");
					},
				},
				models: [
					{
						id: "revocation-model",
						name: "revocation-model",
						reasoning: false,
						input: ["text" as const],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100_000,
						maxTokens: 8192,
					},
				],
			});
			registry.registerProvider(PROVIDER, config("https://original.example.invalid"));
			worker = await startServiceWorker<Probe>(
				new URL("./fixtures/usage-governor-worker-revocation/worker.ts", import.meta.url),
				[authService],
			);
			const initial = await worker.probe.start(
				registry,
				PROVIDER,
				"revocation-model",
				credentialIdOf(h, PROVIDER, "a"),
				path.join(h.dir, "slots"),
			);
			await worker.probe.held();
			if (mutation !== "none") {
				if (mutation === "remove") registry.unregisterProvider(PROVIDER);
				else registry.registerProvider(PROVIDER, config("https://replacement.example.invalid"));
				const applied = await worker.probe.applied();
				expect(applied.revision).toBeGreaterThan(initial.revision);
				if (mutation === "remove") expect(applied.targetPresent).toBe(false);
				else expect(applied.baseUrl).toBe("https://replacement.example.invalid");
			}
			const outcome = await worker.probe.release();
			if (mutation === "none") {
				expect(outcome.sent).toBe(1);
				expect(outcome.error).toBeUndefined();
				expect(settle.mock.calls.some(([, result]) => result === "sent")).toBe(true);
			} else {
				expect(outcome.sent).toBe(0);
				expect(outcome.error).toContain("Usage route authorization is no longer valid");
				expect(settle.mock.calls.some(([, result]) => result === "not-sent")).toBe(true);
			}
			expectNoStrayFetch(h);
			expect(h.redemptionPosts()).toHaveLength(0);
		} finally {
			settle.mockRestore();
			await worker?.stop();
			await disposeHarness();
		}
	}, 15_000);
}
