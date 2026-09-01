import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsNumstatEntry } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getCommitCacheDbPath } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../../sdk";
import { resolvePrimaryModel, resolveSmolModel } from "../model-selection";
import type { ConventionalCommit } from "../types";
import { CommitInferenceCache } from "./cache";
import { type ConventionalGenerationConfig, conventionalGenerationConfig } from "./config";
import { type ConventionalGenerationContext, generateConventionalCommit } from "./generate";
import {
	type CommitInference,
	type CommitInferenceRequest,
	type CommitInferenceResponse,
	type CommitProgress,
	OmpCommitInference,
} from "./inference";
import { detectRepositoryContext, formatRepositoryContext } from "./repo-context";

/** Options for generating a conventional message from the staged tree. */
export interface GenerateGitCommitOptions {
	cwd: string;
	modelOverride?: string;
	stageIfEmpty?: boolean;
	onProgress?: CommitProgress;
	signal?: AbortSignal;
}

/** Conventional commit form values plus staging and validation metadata. */
export interface GeneratedGitCommit {
	commit: ConventionalCommit;
	validationError: string | null;
	stagedAll: boolean;
}
function renderNumstat(entries: VcsNumstatEntry[]): string {
	return entries
		.map(entry => `${entry.added ?? "-"}\t${entry.removed ?? "-"}\t${entry.path}`)
		.join("\n")
		.concat(entries.length > 0 ? "\n" : "");
}

function renderStat(entries: VcsNumstatEntry[]): string {
	if (entries.length === 0) return "";
	let insertions = 0;
	let deletions = 0;
	const lines = entries.map(entry => {
		const added = entry.added ?? 0;
		const removed = entry.removed ?? 0;
		insertions += added;
		deletions += removed;
		return ` ${entry.path} | ${added + removed} ${"+".repeat(Math.min(added, 40))}${"-".repeat(Math.min(removed, 40))}`;
	});
	lines.push(
		` ${entries.length} file${entries.length === 1 ? "" : "s"} changed, ${insertions} insertion${insertions === 1 ? "" : "s"}(+), ${deletions} deletion${deletions === 1 ? "" : "s"}(-)`,
	);
	return `${lines.join("\n")}\n`;
}

/** Generate a commit message from the staged tree, staging all only when the index is empty. */
export async function generateGitCommit(options: GenerateGitCommitOptions): Promise<GeneratedGitCommit> {
	const repo = vcs.requireGit(options.cwd);
	const settings = await Settings.init({ cwd: options.cwd });
	const config = conventionalGenerationConfig(settings.getGroup("commit"));
	let stagedFiles = await repo.changedFiles({ cached: true }, options.signal);
	let stagedAll = false;
	if (stagedFiles.length === 0 && options.stageIfEmpty !== false) {
		options.onProgress?.("Staging all changes…");
		await repo.stageFiles([], options.signal);
		stagedAll = true;
		stagedFiles = await repo.changedFiles({ cached: true }, options.signal);
	}
	if (stagedFiles.length === 0) throw new Error("No staged changes to analyze");

	options.onProgress?.("Reading staged changes…");
	const initialDiff = await repo.diffText({ cached: true }, options.signal);
	const diff =
		Buffer.byteLength(initialDiff) <= config.maxDiffLength
			? initialDiff
			: await repo.diffText({ cached: true, context: 1 }, options.signal);
	if (!diff.trim()) throw new Error("No staged changes to analyze");

	const numstatEntries = await repo.numstat({ cached: true }, options.signal);
	const stat = renderStat(numstatEntries);
	const numstat = renderNumstat(numstatEntries);
	const context = await collectGenerationContext(options.cwd, options.signal);

	const inference = new LazyCommitInference(() => createOmpInference(options, settings, config));
	try {
		const result = await generateConventionalCommit({ diff, stat, numstat, config, inference, context });
		return { ...result, stagedAll };
	} finally {
		await inference.dispose();
	}
}

async function createOmpInference(
	options: GenerateGitCommitOptions,
	settings: Settings,
	config: ConventionalGenerationConfig,
): Promise<OmpCommitInference> {
	options.signal?.throwIfAborted();
	const authStorage = await discoverAuthStorage();
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, options.cwd);
		const primary = await resolvePrimaryModel(options.modelOverride, settings, registry);
		const smol = options.modelOverride
			? primary
			: await resolveSmolModel(settings, registry, primary.model, primary.apiKey);
		const cache = config.cacheEnabled
			? await CommitInferenceCache.open(getCommitCacheDbPath(), config.cacheTtlDays)
			: null;
		return new OmpCommitInference({
			primary,
			smol,
			forcePrimaryForEveryRole: options.modelOverride !== undefined,
			config,
			cache,
			authStorage,
			onProgress: options.onProgress,
			signal: options.signal,
		});
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

async function collectGenerationContext(cwd: string, signal?: AbortSignal): Promise<ConventionalGenerationContext> {
	const repo = vcs.requireGit(cwd);
	const [repository, subjects, names] = await Promise.all([
		detectRepositoryContext(cwd).catch(() => ({ isMonorepo: false })),
		repo.logSubjects(100, signal).catch(() => []),
		projectNames(cwd),
	]);
	const scopeCounts = new Map<string, number>();
	for (const subject of subjects) {
		const colon = subject.indexOf(":");
		if (colon < 0) continue;
		const prefix = subject.slice(0, colon);
		const start = prefix.indexOf("(");
		const end = prefix.indexOf(")", start + 1);
		if (start < 0 || end < 0 || start >= end) continue;
		const scope = prefix.slice(start + 1, end);
		scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
	}
	const commonScopes = [...scopeCounts]
		.sort((left, right) => right[1] - left[1])
		.slice(0, 10)
		.map(([scope, count]) => `${scope} (${count})`)
		.join(", ");
	return {
		recentCommits: subjects.slice(0, 10).join("\n") || undefined,
		commonScopes: commonScopes || undefined,
		projectContext: formatRepositoryContext(repository) ?? undefined,
		projectNames: names,
	};
}

async function projectNames(cwd: string): Promise<string[]> {
	const root = vcs.git(cwd)?.info().repoRoot ?? cwd;
	const names = [path.basename(root)];
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		const packages: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (await Bun.file(path.join(root, entry.name, "__init__.py")).exists()) packages.push(entry.name);
		}
		if (packages.length === 1 && packages[0]) names.push(packages[0]);
	} catch {}
	return [...new Set(names)];
}

class LazyCommitInference implements CommitInference {
	readonly #create: () => Promise<OmpCommitInference>;
	#instance: Promise<OmpCommitInference> | undefined;

	constructor(create: () => Promise<OmpCommitInference>) {
		this.#create = create;
	}

	async complete<T>(request: CommitInferenceRequest, parse: (response: CommitInferenceResponse) => T): Promise<T> {
		this.#instance ??= this.#create();
		return (await this.#instance).complete(request, parse);
	}

	async dispose(): Promise<void> {
		if (!this.#instance) return;
		try {
			(await this.#instance).dispose();
		} catch {}
	}
}
