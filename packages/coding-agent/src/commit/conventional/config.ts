import type { CommitSettings } from "../../config/settings-schema";

/** Runtime thresholds copied from llm-git's standard commit workflow. */
export interface ConventionalGenerationConfig {
	readonly summaryGuideline: number;
	readonly summarySoftLimit: number;
	readonly summaryHardLimit: number;
	readonly maxRetries: number;
	readonly initialBackoffMs: number;
	readonly autoFastThresholdLines: number;
	readonly maxDiffLength: number;
	readonly maxDiffTokens: number;
	readonly wideChangeThreshold: number;
	readonly excludedFiles: readonly string[];
	readonly lowPriorityExtensions: readonly string[];
	readonly maxDetailTokens: number;
	readonly wideChangeAbstract: boolean;
	readonly mapReduceEnabled: boolean;
	readonly mapReduceThreshold: number;
	readonly mapBatchTokenBudget: number;
	readonly cacheEnabled: boolean;
	readonly cacheTtlDays: number;
}

const EXCLUDED_FILES: readonly string[] = [
	"Cargo.lock",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"shrinkwrap.yaml",
	"bun.lock",
	"bun.lockb",
	"deno.lock",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
	"Pipfile.lock",
	"pdm.lock",
	"uv.lock",
	"go.sum",
	"flake.lock",
	"pubspec.lock",
	"Podfile.lock",
	"Packages.resolved",
	"mix.lock",
	"packages.lock.json",
	"gradle.lockfile",
];

const LOW_PRIORITY_EXTENSIONS: readonly string[] = [
	".lock",
	".snap",
	".sum",
	".toml",
	".yaml",
	".yml",
	".json",
	".md",
	".txt",
	".log",
	".tmp",
	".bak",
];

/** Default llm-git thresholds before omp's explicit commit settings are applied. */
export const DEFAULT_CONVENTIONAL_GENERATION_CONFIG: ConventionalGenerationConfig = {
	summaryGuideline: 72,
	summarySoftLimit: 96,
	summaryHardLimit: 128,
	maxRetries: 3,
	initialBackoffMs: 1000,
	autoFastThresholdLines: 200,
	maxDiffLength: 100_000,
	maxDiffTokens: 25_000,
	wideChangeThreshold: 0.5,
	excludedFiles: EXCLUDED_FILES,
	lowPriorityExtensions: LOW_PRIORITY_EXTENSIONS,
	maxDetailTokens: 200,
	wideChangeAbstract: true,
	mapReduceEnabled: true,
	mapReduceThreshold: 5_000,
	mapBatchTokenBudget: 16_000,
	cacheEnabled: true,
	cacheTtlDays: 14,
};
/** Build generation configuration from exact defaults plus omp settings. */
export function conventionalGenerationConfig(settings: CommitSettings): ConventionalGenerationConfig {
	return {
		...DEFAULT_CONVENTIONAL_GENERATION_CONFIG,
		mapReduceEnabled: settings.mapReduceEnabled,
		mapReduceThreshold: settings.mapReduceThreshold,
		mapBatchTokenBudget: settings.mapBatchTokenBudget,
		cacheEnabled: settings.cacheEnabled,
		cacheTtlDays: settings.cacheTtlDays,
	};
}
