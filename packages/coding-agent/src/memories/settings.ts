/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Memories
// Legacy local-memory enable flag kept only for back-compat migration.
// Hidden from UI — users should use `memory.backend` instead.
export const cfgMemoriesEnabled = register({
	id: "memories.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
});

export const cfgMemoriesMaxRolloutsPerStartup = register({
	id: "memories.maxRolloutsPerStartup",
	type: "number",
	default: 64,
});

export const cfgMemoriesMaxRolloutAgeDays = register({ id: "memories.maxRolloutAgeDays", type: "number", default: 30 });

export const cfgMemoriesMinRolloutIdleHours = register({
	id: "memories.minRolloutIdleHours",
	type: "number",
	default: 12,
});

export const cfgMemoriesThreadScanLimit = register({ id: "memories.threadScanLimit", type: "number", default: 300 });

export const cfgMemoriesMaxRawMemoriesForGlobal = register({
	id: "memories.maxRawMemoriesForGlobal",
	type: "number",
	default: 200,
});

export const cfgMemoriesStage1Concurrency = register({ id: "memories.stage1Concurrency", type: "number", default: 8 });

export const cfgMemoriesStage1LeaseSeconds = register({
	id: "memories.stage1LeaseSeconds",
	type: "number",
	default: 120,
});

export const cfgMemoriesStage1RetryDelaySeconds = register({
	id: "memories.stage1RetryDelaySeconds",
	type: "number",
	default: 120,
});

export const cfgMemoriesPhase2LeaseSeconds = register({
	id: "memories.phase2LeaseSeconds",
	type: "number",
	default: 180,
});

export const cfgMemoriesPhase2RetryDelaySeconds = register({
	id: "memories.phase2RetryDelaySeconds",
	type: "number",
	default: 180,
});

export const cfgMemoriesPhase2HeartbeatSeconds = register({
	id: "memories.phase2HeartbeatSeconds",
	type: "number",
	default: 30,
});

export const cfgMemoriesRolloutPayloadPercent = register({
	id: "memories.rolloutPayloadPercent",
	type: "number",
	default: 0.7,
});

export const cfgMemoriesPhase1InputTokenLimit = register({
	id: "memories.phase1InputTokenLimit",
	type: "number",
	default: 4000,
});

export const cfgMemoriesFallbackTokenLimit = register({
	id: "memories.fallbackTokenLimit",
	type: "number",
	default: 16000,
});

export const cfgMemoriesSummaryInjectionTokenLimit = register({
	id: "memories.summaryInjectionTokenLimit",
	type: "number",
	default: 5000,
});
