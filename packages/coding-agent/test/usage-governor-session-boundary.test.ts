import { describe, expect, test } from "bun:test";
import {
	configureUsageAdmission,
	currentUsageAdmission,
	withUsageAdmission,
	type Model,
	type UsageAdmission,
} from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "@oh-my-pi/pi-coding-agent/session/session-stats";
import type { UsageHeaderIngestOptions } from "@oh-my-pi/pi-ai/auth/types";

function governor(): UsageAdmission {
	return { active: true, admit: async () => undefined, settle: () => {} };
}

describe("session admission ownership", () => {
	test("concurrent scopes retain their owner and undefined masks the thread fallback", async () => {
		const a = governor();
		const b = governor();
		configureUsageAdmission(a);
		try {
			const values = await Promise.all([
				withUsageAdmission(a, async () => {
					await Promise.resolve();
					return currentUsageAdmission();
				}),
				withUsageAdmission(b, async () => {
					await Promise.resolve();
					return currentUsageAdmission();
				}),
				withUsageAdmission(undefined, async () => {
					await Promise.resolve();
					return currentUsageAdmission();
				}),
			]);
			expect(values).toEqual([a, b, undefined]);
			expect(currentUsageAdmission()).toBe(a);
		} finally {
			configureUsageAdmission(undefined);
		}
	});

	test("custom resolver never evaluates or resolves governed candidates", async () => {
		let resolved = 0;
		let evaluated = 0;
		const settings = Settings.isolated({ "usageGovernor.enabled": true, "retry.modelFallback": true });
		const host = {
			settings,
			usesRegistryAuth: () => false,
			modelRegistry: {
				getApiKeyWithCredentialForProvider: () => {
					resolved++;
					throw new Error("unsafe resolution");
				},
			},
			usageRouting: {
				candidates: () => {
					evaluated++;
					throw new Error("unsafe routing");
				},
			},
			configWarnings: [],
		} as unknown as TurnRecoveryHost;
		const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
		const model = { provider: "synthetic", id: "primary", baseUrl: "https://example.test" } as Model;
		const prepared = await recovery.prepareGovernedModelCall(
			model,
			async () => {
				throw new Error("custom callback must be left to the ordinary path");
			},
			{ kind: "role", role: "task" },
		);
		expect(prepared).toBeUndefined();
		expect(resolved).toBe(0);
		expect(evaluated).toBe(0);
	});
	test("header observations preserve serving credential identity and exact endpoint", () => {
		const observations: UsageHeaderIngestOptions[] = [];
		const host = {
			agent: { sessionId: "session" },
			modelRegistry: {
				authStorage: {
					usage: {
						ingestHeaders: (
							_provider: string,
							_headers: Record<string, string>,
							options: UsageHeaderIngestOptions,
						) => {
							observations.push(options);
							return true;
						},
					},
				},
			},
		} as unknown as SessionStatsTrackerHost;
		const tracker = new SessionStatsTracker(host);
		const model = { provider: "synthetic", id: "model", baseUrl: "https://exact.example.test" } as Model;
		tracker.ingestProviderUsageHeaders({ status: 200, headers: {}, credentialId: 7 }, model);
		tracker.ingestProviderUsageHeaders({ status: 200, headers: {}, credentialId: null }, model);
		tracker.ingestProviderUsageHeaders({ status: 200, headers: {} }, model);
		expect(observations).toEqual([
			{ sessionId: "session", baseUrl: model.baseUrl, responseStatus: 200, credentialId: 7 },
			{ sessionId: "session", baseUrl: model.baseUrl, responseStatus: 200, credentialId: null },
			{ sessionId: "session", baseUrl: model.baseUrl, responseStatus: 200 },
		]);
	});
});
