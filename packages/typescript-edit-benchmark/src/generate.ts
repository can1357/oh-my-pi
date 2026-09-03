#!/usr/bin/env bun
/**
 * Generate edit benchmark cases from TypeScript sources in a pi-mono-style repo.
 *
 * The goal is testing edit precision, not bug-finding ability. The mutation can
 * be trivial - what matters is whether the model can surgically apply the patch
 * in difficult contexts:
 *
 * - Repeated lines: The exact target line appears multiple times
 * - Long files: 300+ lines with edit in the middle
 * - Similar blocks: Multiple structurally similar functions
 * - Dense code: Minimal whitespace makes context harder to read
 * - Deep nesting: Whitespace-sensitive edits at high indent levels
 *
 * Difficulty modes control both FILE SELECTION and PROMPT DETAIL. Every prompt
 * fully determines the byte-exact fix (before/after blocks, validated by
 * re-solving them against the expected output); tiers vary how much locating
 * the model must do:
 * - easy: Short files, unique lines, exact line number given
 * - medium: Medium files, containing function given
 * - hard: Long files with similar blocks, no location hint
 * - nightmare: Long files where nearly identical regions repeat, no location hint
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { diffLines } from "diff";
import { formatContent } from "./formatter";
import {
	commonPrefixLength,
	commonSuffixLength,
	LANGUAGE_BY_EXTENSION,
	mergeNearbyPlacements,
	type Placement,
	pickFence,
	placementsFromDiff,
	type RenderedHunk,
	renderHunks,
	solveRenderedHunks,
} from "./hunks";
import { ALL_MUTATIONS, CATEGORY_MAP, type Mutation, type MutationInfo } from "./mutations";
import identifierTaskTemplate from "./prompts/identifier-task.md" with { type: "text" };
import mutationTaskTemplate from "./prompts/mutation-task.md" with { type: "text" };
import structuralTaskTemplate from "./prompts/structural-task.md" with { type: "text" };

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
using DEFAULT_SOURCE_REPO_DIR = TempDir.createSync("@pi-mono-source");
const DEFAULT_OUTPUT = path.join(import.meta.dir, "../fixtures.tar.gz");
/** Default when no `--typescript-dir` is passed: shallow-clone this repo and scan `packages/`. */
const DEFAULT_SOURCE_REPO_URL = "https://github.com/badlogic/pi-mono.git";

const EXCLUDE_DIRS = new Set([
	"__tests__",
	"__mocks__",
	"fixtures",
	"fixture",
	"dist",
	"build",
	"node_modules",
	"scripts",
]);

type Difficulty = "easy" | "medium" | "hard" | "nightmare";

interface FileEntry {
	path: string;
	content: string;
	lineCount: number;
	repeatedLines: Map<string, number[]>;
	similarBlockCount: number;
	density: number;
	maxIndent: number;
	functionRanges: Array<[string, number, number]>;
}

interface CaseResult {
	caseId: string;
	mutation: Mutation;
	finalInfo: MutationInfo;
	filePath: string;
	formattedMutatedContent: string;
	formattedOriginalContent: string;
	prompt: string;
	difficulty: Difficulty;
	difficultyScore: number;
}

interface Args {
	typescriptDir: string;
	output: string;
	countScale: number;
	seed: number;
	categories: string | null;
	difficulty: string;
	minScore: number | null;
	dryRun: boolean;
}

function parseArguments(): Args {
	const { values } = parseArgs({
		options: {
			"typescript-dir": { type: "string", default: DEFAULT_SOURCE_REPO_DIR.path() },
			output: { type: "string", default: DEFAULT_OUTPUT },
			"count-scale": { type: "string", default: "1" },
			seed: { type: "string", default: "42" },
			categories: { type: "string" },
			difficulty: { type: "string", default: "easy,medium,hard,nightmare" },
			"min-score": { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});

	return {
		typescriptDir: values["typescript-dir"] ?? DEFAULT_SOURCE_REPO_DIR.path(),
		output: values.output ?? DEFAULT_OUTPUT,
		countScale: Number.parseFloat(values["count-scale"] ?? "1"),
		seed: parseInt(values.seed ?? "42", 10),
		categories: values.categories ?? null,
		difficulty: values.difficulty ?? "easy,medium,hard,nightmare",
		minScore: values["min-score"] ? parseInt(values["min-score"], 10) : null,
		dryRun: values["dry-run"] ?? false,
	};
}

/** Target changed-line range for a generated case. */
type SizeRange = [number, number];

/** How many cases to generate for a mutation, and which changed-line bands to cycle through. */
interface MutationPlan {
	count: number;
	sizes?: SizeRange[];
}

const BLOCK_SIZES: SizeRange[] = [
	[6, 20],
	[21, 60],
	[61, 150],
	[6, 20],
	[21, 60],
	[6, 20],
	[61, 150],
	[21, 60],
];

/**
 * Per-mutation case counts and changed-line targets, calibrated against the
 * per-tool-call edit-shape distribution measured from real agent sessions
 * (`edit-shape-stats.ts`, calibration reference): 1 → 23%, 2-5 → 30%,
 * 6-20 → 29%, 21-60 → 14%, 61+ → 5%. The request×file cumulative numbers form
 * an upper bound; the suite deliberately sits at or slightly above the
 * per-call sizes. Token-level mutations supply the 1-line mass; small
 * structural and multi-site mutations the 2-5 band; block-level mutations
 * cycle through the larger bands via `sizes`.
 */
const MUTATION_PLANS: Record<string, MutationPlan> = {
	"swap-comparison": { count: 1 },
	"swap-equality": { count: 1 },
	"swap-logical": { count: 1 },
	"remove-negation": { count: 1 },
	"swap-increment-decrement": { count: 1 },
	"swap-arithmetic": { count: 1 },
	"flip-boolean": { count: 1 },
	"remove-optional-chain": { count: 1 },
	"swap-call-args": { count: 1 },
	"swap-nullish": { count: 1 },
	"swap-regex-quantifier": { count: 1 },
	"unicode-hyphen": { count: 1 },
	"off-by-one": { count: 1 },
	"swap-adjacent-lines": { count: 6 },
	"duplicate-line-flip": { count: 6 },
	"identifier-multi-edit": { count: 10 },
	"swap-if-else": { count: 8 },
	"wrap-redundant-if": { count: 14, sizes: BLOCK_SIZES },
	"swap-sibling-blocks": { count: 14, sizes: BLOCK_SIZES },
	"duplicate-block": { count: 6, sizes: BLOCK_SIZES },
	"move-distant-block": { count: 10, sizes: BLOCK_SIZES },
	"remove-case-label": { count: 8 },
	"composite-multi-edit": { count: 16 },
};

async function ensureSourceRepo(typescriptDir: string): Promise<void> {
	if (fs.existsSync(typescriptDir)) {
		const packagesDir = path.join(typescriptDir, "packages");
		if (fs.existsSync(packagesDir) && fs.statSync(packagesDir).isDirectory()) return;
		throw new Error(`Directory exists but missing packages/: ${typescriptDir}`);
	}

	console.log(`Cloning pi-mono repository to ${typescriptDir}…`);
	fs.mkdirSync(path.dirname(typescriptDir), { recursive: true });
	const result = await $`git clone --depth 1 ${DEFAULT_SOURCE_REPO_URL} ${typescriptDir}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		const decoder = new TextDecoder();
		const stderr = result.stderr ? decoder.decode(result.stderr) : "";
		throw new Error(`Failed to clone pi-mono: ${stderr.trim()}`);
	}
	console.log("Clone complete.");
}

function isExcluded(filePath: string): boolean {
	const parts = filePath.split("/");
	for (const part of parts) {
		if (EXCLUDE_DIRS.has(part)) return true;
	}
	const filename = path.basename(filePath);
	if (filename.includes(".test.") || filename.includes(".spec.") || filename.includes(".fixture.")) {
		return true;
	}
	return false;
}

function hasStructure(content: string): boolean {
	return ["function ", "class ", "export ", "=>"].some(token => content.includes(token));
}

async function collectFiles(typescriptDir: string): Promise<string[]> {
	const sourceDir = path.join(typescriptDir, "packages");
	const candidates: string[] = [];

	async function walk(dir: string): Promise<void> {
		if (isExcluded(dir)) return;
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				const ext = `.${entry.name.split(".").pop()}`;
				if (SUPPORTED_EXTENSIONS.has(ext) && !isExcluded(fullPath)) {
					candidates.push(fullPath);
				}
			}
		}
	}

	await walk(sourceDir);
	return candidates.sort();
}

async function readFileAsync(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

function findRepeatedLines(content: string, minRepeats = 2): Map<string, number[]> {
	const lines = content.split("\n");
	const positions = new Map<string, number[]>();
	const trivial = new Set(["{", "}", "};", ");", "],", "});", "return;", "break;", "continue;", ""]);

	for (let i = 0; i < lines.length; i++) {
		const stripped = lines[i].trim();
		if (stripped.length < 10 || trivial.has(stripped)) continue;
		const pos = positions.get(stripped) ?? [];
		pos.push(i + 1);
		positions.set(stripped, pos);
	}

	const result = new Map<string, number[]>();
	for (const [line, pos] of positions) {
		if (pos.length >= minRepeats) {
			result.set(line, pos);
		}
	}
	return result;
}

function countSimilarBlocks(content: string): number {
	const funcPattern = /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g;
	const matches = [...content.matchAll(funcPattern)];
	return matches.length;
}

function computeDensity(content: string): number {
	if (!content) return 0;
	const nonWs = content.replace(/[\s\n\t]/g, "").length;
	return nonWs / content.length;
}

function findMaxIndent(content: string): number {
	let maxIndent = 0;
	for (const line of content.split("\n")) {
		if (line.trim()) {
			const indent = line.length - line.trimStart().length;
			maxIndent = Math.max(maxIndent, indent);
		}
	}
	return maxIndent;
}

function findFunctionRanges(content: string): Array<[string, number, number]> {
	const lines = content.split("\n");
	const ranges: Array<[string, number, number]> = [];
	const funcPattern = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/;

	let braceDepth = 0;
	let currentFunc: string | null = null;
	let funcStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = funcPattern.exec(line);
		if (match && braceDepth === 0) {
			if (currentFunc) {
				ranges.push([currentFunc, funcStart, i]);
			}
			currentFunc = match[1] ?? match[2];
			funcStart = i + 1;
		}

		braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;

		if (currentFunc && braceDepth === 0 && line.includes("}")) {
			ranges.push([currentFunc, funcStart, i + 1]);
			currentFunc = null;
		}
	}

	if (currentFunc) {
		ranges.push([currentFunc, funcStart, lines.length]);
	}

	return ranges;
}

async function analyzeFile(filePath: string): Promise<FileEntry> {
	const content = await readFileAsync(filePath);
	const lines = content.split("\n");
	return {
		path: filePath,
		content,
		lineCount: lines.length,
		repeatedLines: findRepeatedLines(content),
		similarBlockCount: countSimilarBlocks(content),
		density: computeDensity(content),
		maxIndent: findMaxIndent(content),
		functionRanges: findFunctionRanges(content),
	};
}

async function filterFiles(paths: string[], minLines = 30, maxLines = 800): Promise<FileEntry[]> {
	const filtered: FileEntry[] = [];
	for (const filePath of paths) {
		const content = await readFileAsync(filePath);
		const lineCount = content.split("\n").length;
		if (lineCount < minLines || lineCount > maxLines) continue;
		if (!hasStructure(content)) continue;
		const entry = await analyzeFile(filePath);
		filtered.push(entry);
	}
	return filtered;
}

function scoreDifficulty(entry: FileEntry, lineNumber: number): number {
	let score = 0;
	const lines = entry.content.split("\n");
	if (lineNumber < 1 || lineNumber > lines.length) return 0;

	const lineContent = lines[lineNumber - 1].trim();

	// File length bonus
	if (entry.lineCount > 300) score += 3;
	else if (entry.lineCount > 150) score += 1;

	// Middle of file bonus
	const middleStart = entry.lineCount * 0.33;
	const middleEnd = entry.lineCount * 0.66;
	if (lineNumber >= middleStart && lineNumber <= middleEnd) score += 2;

	// Repeated line bonus
	if (entry.repeatedLines.has(lineContent)) {
		const repeatCount = entry.repeatedLines.get(lineContent)!.length;
		score += Math.min(repeatCount, 5);
	}

	// Similar function blocks bonus
	if (entry.similarBlockCount >= 5) score += 3;
	else if (entry.similarBlockCount >= 3) score += 1;

	// Dense code bonus
	if (entry.density > 0.75) score += 2;
	else if (entry.density > 0.65) score += 1;

	// Deep nesting bonus
	const lineIndent = lines[lineNumber - 1].length - lines[lineNumber - 1].trimStart().length;
	if (lineIndent >= 16) score += 2;
	else if (lineIndent >= 8) score += 1;

	// Generic context penalty
	const trivialLines = new Set(["{", "}", "};", ");", "});", "return;", "break;", "continue;", ""]);
	const contextStart = Math.max(0, lineNumber - 3);
	const contextEnd = Math.min(lines.length, lineNumber + 2);
	let trivialContext = 0;
	for (let i = contextStart; i < contextEnd; i++) {
		if (trivialLines.has(lines[i].trim())) trivialContext++;
	}
	if (trivialContext >= 3) score += 2;

	// Similar variable names nearby
	const funcName = findContainingFunction(entry, lineNumber);
	if (funcName) {
		for (const [name, start, end] of entry.functionRanges) {
			if (name === funcName) {
				const funcLines = lines.slice(start - 1, end);
				const identifiers = new Set(funcLines.join("\n").match(/\b[a-z][a-zA-Z0-9]*\b/g) ?? []);
				let similarPairs = 0;
				const ids = Array.from(identifiers);
				for (const a of ids) {
					for (const b of ids) {
						if (a !== b && (a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a))) {
							similarPairs++;
						}
					}
				}
				if (similarPairs >= 3) score += 2;
				break;
			}
		}
	}

	return score;
}

function findContainingFunction(entry: FileEntry, lineNumber: number): string | null {
	for (const [name, start, end] of entry.functionRanges) {
		if (lineNumber >= start && lineNumber <= end) return name;
	}
	return null;
}

function getCandidatesForDifficulty(files: FileEntry[], difficulty: Difficulty): FileEntry[] {
	switch (difficulty) {
		case "easy":
			return files.filter(f => f.lineCount < 150 && f.repeatedLines.size < 3);
		case "medium":
			return files.filter(f => f.lineCount >= 100 && f.lineCount <= 300);
		case "hard":
			return files.filter(f => f.lineCount > 200 && f.similarBlockCount >= 3);
		case "nightmare":
			return files.filter(f => f.repeatedLines.size > 0 && f.lineCount > 200);
		default:
			return files;
	}
}

function regionAvailable(usedLines: Map<string, number[]>, filePath: string, lineNumber: number): boolean {
	const used = usedLines.get(filePath) ?? [];
	return !used.some(ln => Math.abs(ln - lineNumber) <= 3);
}

function recordRegion(usedLines: Map<string, number[]>, filePath: string, lineNumber: number): void {
	const used = usedLines.get(filePath) ?? [];
	used.push(lineNumber);
	usedLines.set(filePath, used);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where a bug sits for medium prompts: containing function, else file-third region. */
function locateBug(
	content: string,
	lineNumber: number,
	lineCount: number,
): { functionName?: string; region?: "top" | "middle" | "end" } {
	for (const [name, start, end] of findFunctionRanges(content)) {
		if (lineNumber >= start && lineNumber <= end) return { functionName: name };
	}
	const ratio = lineCount > 0 ? lineNumber / lineCount : 0;
	return { region: ratio < 0.33 ? "top" : ratio < 0.66 ? "middle" : "end" };
}

/**
 * Rename-style prompt for identifier-multi-edit: names the misspelled and
 * correct identifiers so "replace every occurrence" admits exactly one
 * byte-exact answer. Returns null when a plain word-boundary rename does not
 * reproduce the expected file (e.g. the misspelling collides with other text).
 */
function buildIdentifierPrompt(
	filePath: string,
	info: MutationInfo,
	difficulty: Difficulty,
	input: string,
	expected: string,
): string | null {
	const pair = info.identifier;
	if (!pair) return null;
	const wordRe = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(pair.misspelled)}(?![A-Za-z0-9_$])`, "g");
	if (input.replace(wordRe, pair.correct) !== expected) return null;

	const affectedLines: number[] = [];
	input.split("\n").forEach((line, index) => {
		if (wordRe.test(line)) affectedLines.push(index + 1);
		wordRe.lastIndex = 0;
	});
	if (affectedLines.length === 0) return null;

	return prompt.render(identifierTaskTemplate, {
		filename: path.basename(filePath),
		correct: pair.correct,
		misspelled: pair.misspelled,
		count: affectedLines.length,
		affectedLines: difficulty === "easy" ? affectedLines : undefined,
	});
}

/** Mutations whose fixtures read as natural instructions instead of raw before/after patches. */
type StructuralKind =
	| "case-label"
	| "duplicate-block"
	| "move-block"
	| "wrap-if"
	| "swap-blocks"
	| "swap-lines"
	| "swap-if-else";

const STRUCTURAL_KINDS: Record<string, StructuralKind> = {
	"remove-case-label": "case-label",
	"duplicate-block": "duplicate-block",
	"move-distant-block": "move-block",
	"wrap-redundant-if": "wrap-if",
	"swap-sibling-blocks": "swap-blocks",
	"swap-adjacent-lines": "swap-lines",
	"swap-if-else": "swap-if-else",
};

function countTrimmedLine(lines: string[], needle: string): number {
	let count = 0;
	for (const line of lines) {
		if (line.trim() === needle) count++;
	}
	return count;
}

/** Whether a line is a usable prose anchor (contains an identifier, not just punctuation like `);`). */
function isAnchorLine(line: string): boolean {
	return /[A-Za-z_$]{2,}/.test(line);
}

function firstNonEmptyTrimmed(lines: string[]): string {
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/** A placement reduced to its changed core (shared context trimmed away). */
function trimPlacement(
	inputLines: string[],
	placement: Placement,
): { start: number; oldCore: string[]; newCore: string[] } {
	const old = inputLines.slice(placement.start, placement.start + placement.oldLen);
	const fresh = placement.newLines;
	const prefix = commonPrefixLength(old, fresh);
	const suffix = commonSuffixLength(old, fresh, Math.min(old.length, fresh.length) - prefix);
	return {
		start: placement.start + prefix,
		oldCore: old.slice(prefix, old.length - suffix),
		newCore: fresh.slice(prefix, fresh.length - suffix),
	};
}

/** Nearest non-blank line trimmed, scanning from `index` in `direction`. */
function nearestVisibleLine(lines: string[], index: number, direction: 1 | -1): string {
	for (let i = index; i >= 0 && i < lines.length; i += direction) {
		const trimmed = lines[i].trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/**
 * Derive instruction data for a structural mutation from its placements.
 * Every referenced anchor line is validated to occur exactly the expected
 * number of times, so the instruction identifies a unique edit; returns null
 * when the instruction would be ambiguous (the caller then rejects the
 * candidate and retries — structural kinds never ship raw-patch fallbacks).
 */
function structuralPromptData(
	kind: StructuralKind,
	inputLines: string[],
	placements: Placement[],
): Record<string, unknown> | null {
	const cores = placements.map(placement => trimPlacement(inputLines, placement));
	const visible = (lines: string[]): string[] => lines.filter(line => line.trim() !== "");

	switch (kind) {
		case "case-label": {
			if (cores.length !== 1) return null;
			const { start, oldCore, newCore } = cores[0];
			const added = visible(newCore);
			if (visible(oldCore).length !== 0 || added.length !== 1) return null;
			const label = added[0].trim();
			const before = nearestVisibleLine(inputLines, start + oldCore.length, 1);
			if (!label.startsWith("case") || !(before.startsWith("case") || before.startsWith("default"))) return null;
			if (countTrimmedLine(inputLines, before) !== 1) return null;
			return { label, before };
		}
		case "duplicate-block": {
			if (cores.length !== 1) return null;
			const { oldCore, newCore } = cores[0];
			if (visible(newCore).length !== 0 || visible(oldCore).length === 0) return null;
			const head = firstNonEmptyTrimmed(oldCore);
			if (!head || countTrimmedLine(inputLines, head) !== 2) return null;
			return { head };
		}
		case "move-block": {
			if (cores.length !== 2) return null;
			const insert = cores.find(core => visible(core.oldCore).length === 0);
			const remove = cores.find(core => visible(core.newCore).length === 0);
			if (!insert || !remove || insert === remove) return null;
			if (visible(remove.oldCore).join("\n") !== visible(insert.newCore).join("\n")) return null;
			const head = firstNonEmptyTrimmed(remove.oldCore);
			const destination = nearestVisibleLine(inputLines, insert.start + insert.oldCore.length, 1);
			const currentPrev = nearestVisibleLine(inputLines, remove.start - 1, -1);
			if (![head, destination, currentPrev].every(isAnchorLine)) return null;
			for (const anchor of [head, destination, currentPrev]) {
				if (countTrimmedLine(inputLines, anchor) !== 1) return null;
			}
			return { head, destination, currentPrev };
		}
		case "wrap-if": {
			if (cores.length !== 1) return null;
			const { start, oldCore } = cores[0];
			const relative = oldCore.findIndex(line => line.trim() === "if (true) {");
			if (relative < 0) return null;
			return { wrapperLine: start + relative + 1 };
		}
		case "swap-blocks":
		case "swap-lines": {
			const merged = mergeNearbyPlacements(inputLines, placements, 2);
			let firstHead = "";
			let secondHead = "";
			if (merged.length === 1) {
				const { oldCore, newCore } = trimPlacement(inputLines, merged[0]);
				firstHead = firstNonEmptyTrimmed(oldCore);
				secondHead = firstNonEmptyTrimmed(newCore);
			} else if (cores.length === 2) {
				// jsdiff renders `A,B -> B,A` as insert-A-before-B plus delete-A-after-B,
				// with all of B as unchanged context in between; match the moved body.
				const insert = cores.find(core => visible(core.oldCore).length === 0);
				const remove = cores.find(core => visible(core.newCore).length === 0);
				if (!insert || !remove || insert === remove) return null;
				if (visible(remove.oldCore).join("\n") !== visible(insert.newCore).join("\n")) return null;
				secondHead = firstNonEmptyTrimmed(insert.newCore);
				firstHead = nearestVisibleLine(inputLines, insert.start + insert.oldCore.length, 1);
			} else {
				return null;
			}
			if (!firstHead || !secondHead || firstHead === secondHead) return null;
			if (!isAnchorLine(firstHead) || !isAnchorLine(secondHead)) return null;
			if (countTrimmedLine(inputLines, firstHead) !== 1 || countTrimmedLine(inputLines, secondHead) !== 1)
				return null;
			return { firstHead, secondHead };
		}
		case "swap-if-else": {
			if (cores.length > 2) return null;
			const condition = nearestVisibleLine(inputLines, cores[0].start - 1, -1);
			if (!condition.startsWith("if") && !condition.includes(" if ")) return null;
			if (countTrimmedLine(inputLines, condition) !== 1) return null;
			return { condition };
		}
	}
}

/**
 * Build the task prompt for a mutation case, or null when no uniquely solvable
 * prompt exists (the caller then retries with a different candidate).
 *
 * Structural mutations render as natural instructions ("move X back before Y")
 * with the expected after-state as reference; identifier renames as a
 * replace-every-occurrence instruction; everything else as explicit
 * before/after blocks. All variants are validated by re-solving the hunks
 * against the expected output, so every prompt admits exactly one byte-exact
 * answer. Difficulty only controls location detail.
 */
function buildPrompt(
	filePath: string,
	mutation: Mutation,
	info: MutationInfo,
	difficulty: Difficulty,
	input: string,
	expected: string,
): string | null {
	if (mutation.name === "identifier-multi-edit") {
		return buildIdentifierPrompt(filePath, info, difficulty, input, expected);
	}

	const inputLines = input.replace(/\n$/, "").split("\n");
	const placements = placementsFromDiff(input, expected);
	if (placements.length === 0 || placements.length > 5) return null;
	const hunks = renderHunks(inputLines, placements);
	if (!hunks) return null;
	const solved = solveRenderedHunks(inputLines, hunks);
	if (!solved || ensureTrailingNewline(solved.join("\n")) !== expected) return null;

	const language = LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "";
	const fence = pickFence(hunks);
	const hunkContext = (hunk: RenderedHunk): { startLine: number | undefined } => ({
		startLine: !hunk.unique || difficulty === "easy" ? hunk.startLine : undefined,
	});

	const structuralKind = STRUCTURAL_KINDS[mutation.name];
	if (structuralKind) {
		// Structural tasks read as natural instructions; a candidate whose
		// instruction would be ambiguous is rejected so the caller retries —
		// never downgraded to a raw before/after patch.
		const data = structuralPromptData(structuralKind, inputLines, placements);
		if (!data) return null;
		const rendered = prompt.render(structuralTaskTemplate, {
			filename: path.basename(filePath),
			kind: structuralKind,
			...data,
			fence,
			language,
			hunkCount: hunks.length,
			hunks: hunks.map(hunk => ({
				// After-state regions are only interpretable with a position.
				startLine: hunk.startLine,
				newCode: hunk.newBlock.join("\n"),
			})),
		});
		return rendered.length <= 20_000 ? rendered : null;
	}

	const location = difficulty === "medium" ? locateBug(input, hunks[0].startLine, inputLines.length) : {};
	const rendered = prompt.render(mutationTaskTemplate, {
		filename: path.basename(filePath),
		name: mutation.name,
		functionName: location.functionName,
		region: location.region,
		nightmare: difficulty === "nightmare",
		fence,
		language,
		hunkCount: hunks.length,
		hunks: hunks.map(hunk => ({
			...hunkContext(hunk),
			isDelete: hunk.newBlock.length === 0,
			oldCode: hunk.oldBlock.join("\n"),
			newCode: hunk.newBlock.join("\n"),
		})),
	});
	return rendered.length <= 20_000 ? rendered : null;
}

function createSeededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

function countChangedHunks(original: string, mutated: string): number {
	const changes = diffLines(original, mutated);
	let hunks = 0;
	let inChangedChunk = false;
	for (const change of changes) {
		if (change.added || change.removed) {
			if (!inChangedChunk) {
				hunks++;
				inChangedChunk = true;
			}
		} else {
			inChangedChunk = false;
		}
	}
	return hunks;
}

function countChangedLines(original: string, mutated: string): number {
	const changes = diffLines(original, mutated);
	let changedLines = 0;
	for (const change of changes) {
		if (!change.added && !change.removed) continue;
		const split = change.value.split("\n");
		changedLines += split.filter((line, idx) => idx < split.length - 1 || line.length > 0).length;
	}
	return changedLines;
}

function countPositionalLineChanges(original: string, mutated: string): number {
	const originalLines = original.split("\n");
	const mutatedLines = mutated.split("\n");
	const max = Math.max(originalLines.length, mutatedLines.length);
	let changed = 0;
	for (let i = 0; i < max; i++) {
		if ((originalLines[i] ?? "") !== (mutatedLines[i] ?? "")) {
			changed++;
		}
	}
	return changed;
}

function countPositionalLineHunks(original: string, mutated: string): number {
	const originalLines = original.split("\n");
	const mutatedLines = mutated.split("\n");
	const max = Math.max(originalLines.length, mutatedLines.length);
	let hunks = 0;
	let inChanged = false;
	for (let i = 0; i < max; i++) {
		const changed = (originalLines[i] ?? "") !== (mutatedLines[i] ?? "");
		if (changed) {
			if (!inChanged) {
				hunks++;
				inChanged = true;
			}
		} else {
			inChanged = false;
		}
	}
	return hunks;
}

function splitChangedLines(value: string): string[] {
	const lines = value.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

interface DiffHunk {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
	removedLines: string[];
	addedLines: string[];
}

function distanceToRange(lineNumber: number, start: number, end: number): number {
	if (start > end) return Math.abs(lineNumber - start);
	if (lineNumber < start) return start - lineNumber;
	if (lineNumber > end) return lineNumber - end;
	return 0;
}

function resolveLineForHunk(hunk: DiffHunk, fallbackLine: number, maxLine: number): number {
	if (maxLine <= 0) return 1;
	if (hunk.newStart <= hunk.newEnd) {
		return Math.max(hunk.newStart, Math.min(fallbackLine, hunk.newEnd));
	}
	return Math.max(1, Math.min(hunk.newStart, maxLine));
}

function snippetFromChangedLines(changedLines: string[], fallbackLines: string[], lineNumber: number): string {
	if (changedLines.length > 0) {
		return changedLines.slice(0, 3).join("\n");
	}
	const fallback = fallbackLines[lineNumber - 1] ?? "";
	return fallback.trim() ? fallback : "";
}

function resolveFormattedMutationInfo(
	originalContent: string,
	mutatedContent: string,
	fallbackInfo: MutationInfo,
): MutationInfo | null {
	const changes = diffLines(originalContent, mutatedContent);
	const hunks: DiffHunk[] = [];
	let oldLine = 1;
	let newLine = 1;
	let index = 0;

	while (index < changes.length) {
		const change = changes[index];
		if (!change.added && !change.removed) {
			const unchangedCount = splitChangedLines(change.value).length;
			oldLine += unchangedCount;
			newLine += unchangedCount;
			index++;
			continue;
		}

		const hunk: DiffHunk = {
			oldStart: oldLine,
			oldEnd: oldLine - 1,
			newStart: newLine,
			newEnd: newLine - 1,
			removedLines: [],
			addedLines: [],
		};

		while (index < changes.length) {
			const part = changes[index];
			if (!part.added && !part.removed) break;
			const lines = splitChangedLines(part.value);
			if (part.removed) {
				hunk.removedLines.push(...lines);
				oldLine += lines.length;
				hunk.oldEnd = oldLine - 1;
			}
			if (part.added) {
				hunk.addedLines.push(...lines);
				newLine += lines.length;
				hunk.newEnd = newLine - 1;
			}
			index++;
		}

		hunks.push(hunk);
	}

	if (hunks.length === 0) return null;

	let chosen = hunks[0];
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const hunk of hunks) {
		const oldDistance = distanceToRange(fallbackInfo.lineNumber, hunk.oldStart, hunk.oldEnd);
		const newDistance = distanceToRange(fallbackInfo.lineNumber, hunk.newStart, hunk.newEnd);
		const distance = Math.min(oldDistance, newDistance);
		if (distance < bestDistance) {
			bestDistance = distance;
			chosen = hunk;
		}
	}

	const mutatedLines = mutatedContent.split("\n");
	const originalLines = originalContent.split("\n");
	const lineNumber = resolveLineForHunk(chosen, fallbackInfo.lineNumber, mutatedLines.length);
	if (lineNumber < 1 || lineNumber > Math.max(mutatedLines.length, 1)) return null;

	const resolved: MutationInfo = {
		lineNumber,
		originalSnippet: snippetFromChangedLines(chosen.removedLines, originalLines, Math.max(1, chosen.oldStart)),
		mutatedSnippet: snippetFromChangedLines(chosen.addedLines, mutatedLines, lineNumber),
		identifier: fallbackInfo.identifier,
	};

	if (resolved.originalSnippet && !originalContent.includes(resolved.originalSnippet)) return null;
	if (resolved.mutatedSnippet && !mutatedContent.includes(resolved.mutatedSnippet)) return null;

	return resolved;
}

async function generateCase(
	rng: () => number,
	mutation: Mutation,
	files: FileEntry[],
	usedLines: Map<string, number[]>,
	difficulty: Difficulty,
	minScore: number | null,
	sizeRange: SizeRange | null,
	attemptLimit = 100,
): Promise<CaseResult | null> {
	let candidates = getCandidatesForDifficulty(files, difficulty);
	if (candidates.length === 0) candidates = files;

	function canApply(entry: FileEntry): boolean {
		try {
			return mutation.canApply(entry.content);
		} catch {
			return false;
		}
	}

	let applicable = candidates.filter(canApply);
	if (applicable.length === 0 && candidates !== files) {
		applicable = files.filter(canApply);
	}
	if (applicable.length === 0) return null;

	const targetMinScore = minScore ?? { easy: 0, medium: 2, hard: 5, nightmare: 8 }[difficulty] ?? 0;

	for (let attempt = 0; attempt < attemptLimit; attempt++) {
		const entry = applicable[Math.floor(rng() * applicable.length)];
		let mutatedContent: string;
		let rawInfo: MutationInfo;
		try {
			[mutatedContent, rawInfo] = mutation.mutate(entry.content, rng);
		} catch {
			continue;
		}
		if (mutatedContent === entry.content) continue;
		const changedHunks = countChangedHunks(entry.content, mutatedContent);
		const changedLines = countChangedLines(entry.content, mutatedContent);
		const positionalHunks = countPositionalLineHunks(entry.content, mutatedContent);
		const positionalChanges = countPositionalLineChanges(entry.content, mutatedContent);
		const isStructural = mutation.category === "structural";
		const isMultiEdit = mutation.multiHunk === true;
		if (!isStructural && !isMultiEdit) {
			if (changedHunks !== 1) continue;
			if (positionalHunks !== 1) continue;
			if (changedLines > 30 || positionalChanges > 30) continue;
		}
		// Coarse pre-format lower bound: removed+added always >= the run-based
		// metric, so anything below the minimum can be rejected before Prettier.
		if (sizeRange && changedLines < sizeRange[0]) continue;

		if (!regionAvailable(usedLines, entry.path, rawInfo.lineNumber)) continue;

		const diffScore = scoreDifficulty(entry, rawInfo.lineNumber);

		if (difficulty === "nightmare") {
			const lines = entry.content.split("\n");
			if (rawInfo.lineNumber <= lines.length) {
				const lineContent = lines[rawInfo.lineNumber - 1].trim();
				if (!entry.repeatedLines.has(lineContent)) continue;
			}
		}

		if (diffScore < targetMinScore) continue;

		const filename = path.basename(entry.path);
		const [formattedInput, formattedExpected] = await Promise.all([
			formatContent(filename, mutatedContent),
			formatContent(filename, entry.content),
		]);
		const normalizedMutated = ensureTrailingNewline(formattedInput.formatted);
		const normalizedOriginal = ensureTrailingNewline(formattedExpected.formatted);
		const finalInfo = resolveFormattedMutationInfo(normalizedOriginal, normalizedMutated, rawInfo);
		if (!finalInfo) continue;

		// Enforce the size target with the same metric edit-shape-stats.ts uses:
		// sum of max(old, new) per change run, on the formatted input/expected.
		if (sizeRange) {
			const finalChanged = placementsFromDiff(normalizedMutated, normalizedOriginal).reduce(
				(sum, placement) => sum + Math.max(placement.oldLen, placement.newLines.length),
				0,
			);
			if (finalChanged < sizeRange[0] || finalChanged > sizeRange[1]) continue;
		}

		const taskPrompt = buildPrompt(
			entry.path,
			mutation,
			finalInfo,
			difficulty,
			normalizedMutated,
			normalizedOriginal,
		);
		if (!taskPrompt) continue;

		recordRegion(usedLines, entry.path, rawInfo.lineNumber);
		return {
			caseId: "",
			mutation,
			finalInfo,
			filePath: entry.path,
			formattedMutatedContent: normalizedMutated,
			formattedOriginalContent: normalizedOriginal,
			prompt: taskPrompt,
			difficulty,
			difficultyScore: diffScore,
		};
	}

	return null;
}

function ensureTrailingNewline(content: string): string {
	return content.replace(/\n*$/, "\n");
}

interface TarEntry {
	name: string;
	content: string;
}

async function writeTarball(entries: TarEntry[], outputPath: string): Promise<void> {
	const data: Record<string, string> = {};
	for (const entry of entries) {
		data[entry.name] = entry.content;
	}
	await Bun.Archive.write(outputPath, data, { compress: "gzip" });
}

async function buildCaseEntries(result: CaseResult, typescriptDir: string): Promise<TarEntry[]> {
	const filename = path.basename(result.filePath);
	const relativePath = path.relative(typescriptDir, result.filePath);
	const caseDir = `fixtures/${result.caseId}`;

	const lines = result.formattedOriginalContent.split("\n");
	const lineContent = result.finalInfo.lineNumber <= lines.length ? lines[result.finalInfo.lineNumber - 1].trim() : "";

	const entry: FileEntry = {
		path: result.filePath,
		content: result.formattedOriginalContent,
		lineCount: lines.length,
		repeatedLines: findRepeatedLines(result.formattedOriginalContent),
		similarBlockCount: countSimilarBlocks(result.formattedOriginalContent),
		density: computeDensity(result.formattedOriginalContent),
		maxIndent: findMaxIndent(result.formattedOriginalContent),
		functionRanges: findFunctionRanges(result.formattedOriginalContent),
	};

	const isRepeated = entry.repeatedLines.has(lineContent);

	const metadata = {
		mutation_type: result.mutation.name,
		mutation_category: result.mutation.category,
		difficulty: result.difficulty,
		difficulty_score: result.difficultyScore,
		line_number: result.finalInfo.lineNumber,
		original_snippet: result.finalInfo.originalSnippet,
		mutated_snippet: result.finalInfo.mutatedSnippet,
		file_path: relativePath,
		context: {
			file_lines: entry.lineCount,
			is_repeated_line: isRepeated,
			repeat_count: entry.repeatedLines.get(lineContent)?.length ?? 0,
			similar_block_count: entry.similarBlockCount,
			density: Math.round(entry.density * 1000) / 1000,
			line_indent:
				result.finalInfo.lineNumber <= lines.length
					? lines[result.finalInfo.lineNumber - 1].length -
						lines[result.finalInfo.lineNumber - 1].trimStart().length
					: 0,
			containing_function: findContainingFunction(entry, result.finalInfo.lineNumber),
		},
	};

	if (!result.formattedOriginalContent.includes(result.finalInfo.originalSnippet)) {
		throw new Error(`Generated case ${result.caseId} has invalid original snippet metadata`);
	}
	if (!result.formattedMutatedContent.includes(result.finalInfo.mutatedSnippet)) {
		throw new Error(`Generated case ${result.caseId} has invalid mutated snippet metadata`);
	}

	return [
		{ name: `${caseDir}/input/${filename}`, content: result.formattedMutatedContent },
		{ name: `${caseDir}/expected/${filename}`, content: result.formattedOriginalContent },
		{ name: `${caseDir}/prompt.md`, content: result.prompt },
		{ name: `${caseDir}/metadata.json`, content: JSON.stringify(metadata, null, 2) },
	];
}

function chooseDifficulties(difficulties: Difficulty[], count: number): Difficulty[] {
	return Array.from({ length: count }, (_, i) => difficulties[i % difficulties.length]);
}

async function main(): Promise<number> {
	const args = parseArguments();
	const rng = createSeededRng(args.seed);
	const typescriptDir = args.typescriptDir;

	await ensureSourceRepo(typescriptDir);

	const rawFiles = await collectFiles(typescriptDir);
	const files = await filterFiles(rawFiles);
	if (files.length === 0) {
		console.error("No eligible files found.");
		return 1;
	}

	console.log(`Analyzed ${files.length} files`);
	const withRepeats = files.filter(f => f.repeatedLines.size > 0).length;
	const longFiles = files.filter(f => f.lineCount > 200).length;
	const similarBlocks = files.filter(f => f.similarBlockCount >= 3).length;
	console.log(`  ${withRepeats} with repeated lines, ${longFiles} long files, ${similarBlocks} with similar blocks`);

	const difficulties = args.difficulty
		.split(",")
		.map(s => s.trim())
		.filter(Boolean) as Difficulty[];
	if (difficulties.length === 0) {
		console.error("No difficulties specified.");
		return 1;
	}

	let mutations = ALL_MUTATIONS;
	if (args.categories) {
		const categories = new Set(
			args.categories
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		const unknown = Array.from(categories).filter(c => !(c in CATEGORY_MAP));
		if (unknown.length > 0) {
			console.error(`Unknown categories: ${unknown.join(", ")}`);
			return 1;
		}
		mutations = ALL_MUTATIONS.filter(m => categories.has(m.category));
	}

	const usedLines = new Map<string, number[]>();
	const results: CaseResult[] = [];

	const fallbackOrder: Difficulty[] = ["hard", "medium", "easy"];

	for (const mutation of mutations) {
		const plan = MUTATION_PLANS[mutation.name] ?? { count: 4 };
		const count = Math.max(1, Math.round(plan.count * args.countScale));
		const difficultiesForType = chooseDifficulties(difficulties, count);
		let generated = 0;

		for (let index = 0; index < count; index++) {
			const difficulty = difficultiesForType[index];
			const sizeRange = plan.sizes ? plan.sizes[index % plan.sizes.length] : null;
			let result = await generateCase(rng, mutation, files, usedLines, difficulty, args.minScore, sizeRange);

			if (!result) {
				for (const fallback of fallbackOrder) {
					if (fallback === difficulty) continue;
					result = await generateCase(rng, mutation, files, usedLines, fallback, 0, sizeRange);
					if (result) {
						console.log(`Note: ${mutation.name} case ${index + 1} fell back from ${difficulty} to ${fallback}`);
						break;
					}
				}
			}

			if (!result) {
				console.log(`Warning: Skipping ${mutation.name} case ${index + 1} (no applicable files left)`);
				continue;
			}

			generated++;
			const caseId = `${mutation.category}-${mutation.name}-${String(index + 1).padStart(3, "0")}`;
			results.push({
				...result,
				caseId,
			});
		}

		if (generated === 0) {
			console.log(`Warning: No cases generated for ${mutation.name} (mutation may be too rare)`);
		} else if (generated < count) {
			console.log(`Note: Only ${generated}/${count} cases generated for ${mutation.name}`);
		}
	}

	if (args.dryRun) {
		const byDifficulty = new Map<Difficulty, CaseResult[]>();
		for (const result of results) {
			const list = byDifficulty.get(result.difficulty) ?? [];
			list.push(result);
			byDifficulty.set(result.difficulty, list);
		}

		for (const diff of difficulties) {
			const cases = byDifficulty.get(diff) ?? [];
			console.log(`\n${diff.toUpperCase()} (${cases.length} cases):`);
			for (const result of cases.slice(0, 5)) {
				const rel = path.relative(typescriptDir, result.filePath);
				console.log(`  ${result.caseId}: ${rel}`);
				console.log(
					`    score=${result.difficultyScore}, lines=${result.formattedOriginalContent.split("\n").length}`,
				);
			}
			if (cases.length > 5) {
				console.log(`  ... and ${cases.length - 5} more`);
			}
		}

		const scores = results.map(r => r.difficultyScore);
		const min = Math.min(...scores);
		const max = Math.max(...scores);
		const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
		console.log(`\nScore distribution: min=${min}, max=${max}, avg=${avg.toFixed(1)}`);
		return 0;
	}

	const tarEntries: Promise<TarEntry[]>[] = [];
	for (const result of results) {
		tarEntries.push(buildCaseEntries(result, typescriptDir));
	}

	await writeTarball((await Promise.all(tarEntries)).flat(), args.output);

	console.log(`Generated ${results.length} cases in ${args.output}`);
	const scores = results.map(r => r.difficultyScore);
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
	console.log(`Score distribution: min=${min}, max=${max}, avg=${avg.toFixed(1)}`);
	return 0;
}

process.exit(await main());
