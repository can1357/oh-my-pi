import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";
import type { VcsGitRepo, VcsNumstatEntry } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger } from "@oh-my-pi/pi-utils";
import { CHANGELOG_CATEGORIES, type UnreleasedSection } from "../../commit/types";
import { detectChangelogBoundaries } from "./detect";
import { generateChangelogEntries } from "./generate";
import { parseUnreleasedSection } from "./parse";
import type { ChangelogProposal } from "../agentic/state";

const CHANGELOG_SECTIONS = CHANGELOG_CATEGORIES;

const DEFAULT_MAX_DIFF_CHARS = 120_000;
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

export interface ChangelogFlowInput {
	cwd: string;
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	stagedFiles: string[];
	maxDiffChars?: number;
	onProgress?: (message: string) => void;
}

interface ChangelogProposalInput {
	cwd: string;
	proposals: ChangelogProposal["entries"];
	dryRun: boolean;
	onProgress?: (message: string) => void;
}

/** Outcome of applying generated changelog entries to the index and worktree. */
export interface ChangelogApplyResult {
	/** Absolute paths of changelogs that received entries (index and worktree, unless dry-run). */
	updated: string[];
	/**
	 * Undo the writes so a later commit failure leaves the changelogs exactly as
	 * found. Each file's index blob and worktree bytes are reverted only if they
	 * still hold what `apply` wrote; anything else (hook edits, user edits) is kept.
	 */
	rollback(): Promise<void>;
}

interface ChangelogWrite {
	path: string;
	relPath: string;
	indexBefore: string | null;
	indexAfter: string;
	worktreeBefore: string;
	worktreeAfter: string;
}

const NO_CHANGELOG_WRITES: ChangelogApplyResult = { updated: [], rollback: async () => {} };

/**
 * Update CHANGELOG.md entries for staged changes.
 */
export async function runChangelogFlow({
	cwd,
	model,
	apiKey,
	thinkingLevel,
	stagedFiles,
	maxDiffChars,
	onProgress,
}: ChangelogFlowInput): Promise<ChangelogApplyResult> {
	if (stagedFiles.length === 0) return NO_CHANGELOG_WRITES;
	const repo = vcs.requireGit(cwd);
	onProgress?.("Detecting changelog boundaries...");
	const boundaries = await detectChangelogBoundaries(cwd, stagedFiles);
	if (boundaries.length === 0) return NO_CHANGELOG_WRITES;

	const sessionId = Bun.randomUUIDv7();
	const proposals: ChangelogProposalInput["proposals"] = [];
	for (const boundary of boundaries) {
		onProgress?.(`Generating entries for ${boundary.changelogPath}…`);
		const diff = await repo.diffText({ cached: true, files: boundary.files });
		if (!diff.trim()) continue;
		const stat = renderStat(await repo.numstat({ cached: true, files: boundary.files }));
		const diffForPrompt = truncateDiff(diff, maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS);
		const changelogContent = await Bun.file(boundary.changelogPath).text();
		let unreleased: UnreleasedSection;
		try {
			unreleased = parseUnreleasedSection(changelogContent);
		} catch (error) {
			logger.warn("commit changelog parse skipped", { path: boundary.changelogPath, error: String(error) });
			continue;
		}
		const existingEntries = formatExistingEntries(unreleased.entries);
		const isPackageChangelog = path.resolve(boundary.changelogPath) !== path.resolve(cwd, "CHANGELOG.md");
		const generated = await generateChangelogEntries({
			model,
			apiKey,
			sessionId,
			thinkingLevel,
			changelogPath: boundary.changelogPath,
			isPackageChangelog,
			existingEntries: existingEntries || undefined,
			stat,
			diff: diffForPrompt,
		});
		if (Object.keys(generated.entries).length === 0) continue;
		proposals.push({
			path: boundary.changelogPath,
			entries: generated.entries,
		});
	}

	if (proposals.length === 0) return NO_CHANGELOG_WRITES;
	return applyChangelogProposals({
		cwd,
		proposals,
		dryRun: false,
		onProgress,
	});
}

/**
 * Apply changelog entries provided by the commit agent.
 */
export async function applyChangelogProposals({
	cwd,
	proposals,
	dryRun,
	onProgress,
}: ChangelogProposalInput): Promise<ChangelogApplyResult> {
	const repo = vcs.requireGit(cwd);
	const updated: string[] = [];
	const writes: ChangelogWrite[] = [];
	for (const proposal of proposals) {
		if (
			Object.keys(proposal.entries).length === 0 &&
			(!proposal.deletions || Object.keys(proposal.deletions).length === 0)
		)
			continue;
		onProgress?.(`Applying entries for ${proposal.path}…`);
		const exists = await Bun.file(proposal.path).exists();
		if (!exists) {
			logger.warn("commit changelog path missing", { path: proposal.path });
			continue;
		}
		const changelogContent = await Bun.file(proposal.path).text();
		let unreleased: UnreleasedSection;
		try {
			unreleased = parseUnreleasedSection(changelogContent);
		} catch (error) {
			logger.warn("commit changelog parse skipped", { path: proposal.path, error: String(error) });
			continue;
		}
		const normalized = normalizeEntries(proposal.entries);
		const normalizedDeletions = proposal.deletions ? normalizeEntries(proposal.deletions) : undefined;
		if (Object.keys(normalized).length === 0 && !normalizedDeletions) continue;
		const updatedContent = applyChangelogEntries(changelogContent, unreleased, normalized, normalizedDeletions);
		if (!dryRun) {
			const relPath = path.relative(cwd, proposal.path);

			// 1. Staged baseline: index blob, or untracked
			const stagedContent = await readIndexBlob(repo, relPath);

			let updatedStagedContent: string;
			if (stagedContent !== null) {
				let stagedUnreleased: UnreleasedSection;
				try {
					stagedUnreleased = parseUnreleasedSection(stagedContent);
				} catch (error) {
					onProgress?.(`Skipped ${proposal.path}: staged baseline has no [Unreleased] section`);
					logger.warn(
						"commit changelog staged baseline lacks parseable [Unreleased] section; skipping to prevent collateral staging of unstaged worktree edits",
						{ path: proposal.path, error: String(error) },
					);
					continue;
				}
				updatedStagedContent = applyChangelogEntries(
					stagedContent,
					stagedUnreleased,
					normalized,
					normalizedDeletions,
				);
			} else {
				updatedStagedContent = updatedContent;
			}

			// 2. Stage the exact index content
			await repo.stageContent(relPath, updatedStagedContent);

			// 3. Update the worktree on disk with changes applied to current disk content
			await Bun.write(proposal.path, updatedContent);
			writes.push({
				path: proposal.path,
				relPath,
				indexBefore: stagedContent,
				indexAfter: updatedStagedContent,
				worktreeBefore: changelogContent,
				worktreeAfter: updatedContent,
			});
		}
		updated.push(proposal.path);
	}
	return {
		updated,
		rollback: async () => {
			for (const write of writes.reverse()) {
				if ((await readIndexBlob(repo, write.relPath)) === write.indexAfter) {
					if (write.indexBefore === null) await repo.unstage([write.relPath]);
					else await repo.stageContent(write.relPath, write.indexBefore);
				}
				if ((await Bun.file(write.path).text()) === write.worktreeAfter) {
					await Bun.write(write.path, write.worktreeBefore);
				}
			}
		},
	};
}

/** Content of `relPath` in the index, or null if missing. */
async function readIndexBlob(repo: VcsGitRepo, relPath: string): Promise<string | null> {
	try {
		return (await repo.showBlob(`:${relPath}`)).data.toString("utf8");
	} catch (error) {
		if (!vcs.isVcsError(error) || error.code !== "ObjectNotFound") throw error;
		return null;
	}
}

function truncateDiff(diff: string, maxChars: number): string {
	if (diff.length <= maxChars) return diff;
	return `${diff.slice(0, maxChars)}\n[…${diff.length - maxChars}ch elided…]`;
}

function formatExistingEntries(entries: Record<string, string[]>): string {
	const lines: string[] = [];
	for (const section of CHANGELOG_SECTIONS) {
		const values = entries[section] ?? [];
		if (values.length === 0) continue;
		lines.push(`${section}:`);
		for (const value of values) {
			lines.push(`- ${value}`);
		}
	}
	return lines.join("\n");
}

function applyChangelogEntries(
	content: string,
	unreleased: UnreleasedSection,
	entries: Record<string, string[]>,
	deletions?: Record<string, string[]>,
): string {
	const lines = content.split("\n");
	const before = lines.slice(0, unreleased.startLine + 1);
	const after = lines.slice(unreleased.endLine);

	let base = unreleased.entries;
	if (deletions) {
		base = applyDeletions(base, deletions);
	}
	const merged = mergeEntries(base, entries);
	const sectionLines = renderUnreleasedSections(merged);
	return [...before, ...sectionLines, ...after].join("\n");
}

function applyDeletions(
	existing: Record<string, string[]>,
	deletions: Record<string, string[]>,
): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [section, items] of Object.entries(existing)) {
		const toDelete = new Set((deletions[section] ?? []).map(d => d.toLowerCase()));
		const filtered = items.filter(item => !toDelete.has(item.toLowerCase()));
		if (filtered.length > 0) {
			result[section] = filtered;
		}
	}
	return result;
}

function mergeEntries(
	existing: Record<string, string[]>,
	incoming: Record<string, string[]>,
): Record<string, string[]> {
	const merged: Record<string, string[]> = { ...existing };
	for (const [section, items] of Object.entries(incoming)) {
		const current = merged[section] ?? [];
		const lower = new Set(current.map(item => item.toLowerCase()));
		for (const item of items) {
			if (!lower.has(item.toLowerCase())) {
				current.push(item);
			}
		}
		merged[section] = current;
	}
	return merged;
}

function renderUnreleasedSections(entries: Record<string, string[]>): string[] {
	const lines: string[] = [""];
	for (const section of CHANGELOG_SECTIONS) {
		const items = entries[section] ?? [];
		if (items.length === 0) continue;
		lines.push(`### ${section}`);
		for (const item of items) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function normalizeEntries(entries: Record<string, string[]>): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [section, items] of Object.entries(entries)) {
		const trimmed = items.map(item => item.trim().replace(/\.$/, "")).filter(item => item.length > 0);
		if (trimmed.length === 0) continue;
		result[section] = Array.from(new Set(trimmed.map(item => item.trim())));
	}
	return result;
}
