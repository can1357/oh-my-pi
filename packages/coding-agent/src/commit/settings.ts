/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";

export const cfgCommitMapReduceEnabled = register({ id: "commit.mapReduceEnabled", type: "boolean", default: true });

export const cfgCommitMapReduceThreshold = register({ id: "commit.mapReduceThreshold", type: "number", default: 5000 });

export const cfgCommitMapBatchTokenBudget = register({
	id: "commit.mapBatchTokenBudget",
	type: "number",
	default: 16000,
});

export const cfgCommitCacheEnabled = register({ id: "commit.cacheEnabled", type: "boolean", default: true });

export const cfgCommitCacheTtlDays = register({ id: "commit.cacheTtlDays", type: "number", default: 14 });

export const cfgCommitChangelogMaxDiffChars = register({
	id: "commit.changelogMaxDiffChars",
	type: "number",
	default: 120000,
});

/** Conventional commit generation and changelog limits (`commit.*`). */
export const cfgCommit = combine({
	mapReduceEnabled: cfgCommitMapReduceEnabled,
	mapReduceThreshold: cfgCommitMapReduceThreshold,
	mapBatchTokenBudget: cfgCommitMapBatchTokenBudget,
	cacheEnabled: cfgCommitCacheEnabled,
	cacheTtlDays: cfgCommitCacheTtlDays,
	changelogMaxDiffChars: cfgCommitChangelogMaxDiffChars,
});

/** Conventional commit generation and changelog limits ({@link cfgCommit}). */
export type CommitSettings = SettingValueOf<typeof cfgCommit>;
