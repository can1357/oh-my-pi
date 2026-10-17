import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import { computeMnemopiBankScope, type MnemopiScoping } from "../mnemopi/config";
import * as cfg from "./settings";

export type MnemosyneOssOwnership = "shared" | "omp";

export interface MnemosyneOssBackendConfig {
	executable?: string;
	dataDir: string;
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
	sharedBanks: readonly string[];
	scoping: MnemopiScoping;
	ownership: MnemosyneOssOwnership;
	autoRecall: boolean;
	autoRetain: boolean;
	localEmbeddings: boolean;
	embeddingModel?: string;
	localConsolidation: boolean;
	localLlmRepo?: string;
	localLlmFile?: string;
	consolidationMode: "local" | "heuristic";
	autoMigrate: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	requestTimeoutMs: number;
	sleepTimeoutMs: number;
	shutdownTimeoutMs: number;
	debug: boolean;
	diagnostic?: string;
}

const BANK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Resolve the Mnemosyne OSS settings without touching the shared store.
 *
 * Invalid paths and explicit bank names are retained as a diagnostic config so
 * the adapter can remain inert without silently selecting another backend.
 */
export function loadMnemosyneOssConfig(settings: Settings, _agentDir: string): MnemosyneOssBackendConfig {
	const scoping = cfg.cfgMnemosyneOssScoping.get(settings);
	const configuredBank = cfg.cfgMnemosyneOssBank.get(settings)?.trim() || undefined;
	const dataDir = resolveDataDir(cfg.cfgMnemosyneOssDataDir.get(settings), settings.getCwd());
	const localConsolidation = cfg.cfgMnemosyneOssLocalConsolidation.get(settings);
	const scope = computeMnemopiBankScope(configuredBank, settings.getCwd(), scoping);
	const diagnostic =
		configuredBank && !BANK_NAME_RE.test(configuredBank)
			? `Mnemosyne OSS bank "${configuredBank}" is invalid. Bank names must start with an alphanumeric character and contain only letters, numbers, underscores, or hyphens.`
			: dataDir.includes("\0")
				? "Mnemosyne OSS data directory contains a null byte."
				: undefined;
	const localLlmRepo = localConsolidation
		? cfg.cfgMnemosyneOssLocalLlmRepo.get(settings)?.trim() || undefined
		: undefined;
	const localLlmFile = localConsolidation
		? cfg.cfgMnemosyneOssLocalLlmFile.get(settings)?.trim() || undefined
		: undefined;
	return {
		executable: cfg.cfgMnemosyneOssExecutable.get(settings)?.trim() || undefined,
		dataDir,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks: scope.recallBanks,
		sharedBanks: scope.recallBanks.filter(bank => bank !== scope.retainBank),
		scoping,
		ownership: cfg.cfgMnemosyneOssOwnership.get(settings),
		autoRecall: cfg.cfgMnemosyneOssAutoRecall.get(settings),
		autoRetain: cfg.cfgMnemosyneOssAutoRetain.get(settings),
		localEmbeddings: cfg.cfgMnemosyneOssLocalEmbeddings.get(settings),
		embeddingModel: cfg.cfgMnemosyneOssEmbeddingModel.get(settings)?.trim() || undefined,
		localConsolidation,
		localLlmRepo,
		localLlmFile,
		// The SDK ignores a lone repo or file and would load its default GGUF instead.
		consolidationMode: localConsolidation && localLlmRepo && localLlmFile ? "local" : "heuristic",
		autoMigrate: cfg.cfgMnemosyneOssAutoMigrate.get(settings),
		retainEveryNTurns: normalizePositiveInteger(cfg.cfgMnemosyneOssRetainEveryNTurns.get(settings)),
		recallLimit: normalizePositiveInteger(cfg.cfgMnemosyneOssRecallLimit.get(settings)),
		recallContextTurns: normalizePositiveInteger(cfg.cfgMnemosyneOssRecallContextTurns.get(settings)),
		recallMaxQueryChars: normalizePositiveInteger(cfg.cfgMnemosyneOssRecallMaxQueryChars.get(settings), 256),
		injectionTokenLimit: normalizePositiveInteger(cfg.cfgMnemosyneOssInjectionTokenLimit.get(settings), 256),
		requestTimeoutMs: normalizePositiveInteger(cfg.cfgMnemosyneOssRequestTimeoutMs.get(settings)),
		sleepTimeoutMs: normalizePositiveInteger(cfg.cfgMnemosyneOssSleepTimeoutMs.get(settings)),
		shutdownTimeoutMs: normalizePositiveInteger(cfg.cfgMnemosyneOssShutdownTimeoutMs.get(settings)),
		debug: cfg.cfgMnemosyneOssDebug.get(settings),
		diagnostic,
	};
}

function resolveDataDir(configured: string | undefined, cwd: string): string {
	const value =
		configured?.trim() ||
		Bun.env.MNEMOSYNE_DATA_DIR?.trim() ||
		path.join(os.homedir(), ".hermes", "mnemosyne", "data");
	const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	return path.resolve(cwd, expanded);
}

function normalizePositiveInteger(value: number, minimum = 1): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.max(minimum, Math.floor(value));
}
