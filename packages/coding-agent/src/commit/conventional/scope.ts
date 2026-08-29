import * as path from "node:path";
import type { NumstatEntry } from "../types";
import type { ConventionalGenerationConfig } from "./config";

const PLACEHOLDER_DIRS: Record<string, true> = {
	src: true,
	lib: true,
	bin: true,
	crates: true,
	benches: true,
	examples: true,
	internal: true,
	pkg: true,
	include: true,
	tests: true,
	test: true,
	docs: true,
	packages: true,
	modules: true,
};

const SKIP_DIRS: Record<string, true> = {
	".test": true,
	tests: true,
	benches: true,
	examples: true,
	target: true,
	build: true,
	node_modules: true,
	".github": true,
};

/** Weighted path candidate considered for a conventional commit scope. */
export interface ScopeCandidate {
	path: string;
	percentage: number;
	confidence: number;
}

/** Result rendered into analysis prompts plus its wide-change classification. */
export interface ScopeCandidatesResult {
	scopeCandidates: string;
	isWide: boolean;
}

/** Accumulates changed-line totals per meaningful path component. */
export class ScopeAnalyzer {
	readonly componentLines = new Map<string, number>();
	totalLines = 0;

	/** Build an analyzer from raw `git diff --numstat` output. */
	static fromNumstat(numstat: string, config: ConventionalGenerationConfig): ScopeAnalyzer {
		const analyzer = new ScopeAnalyzer();
		for (const line of numstat.split(/\r?\n/)) analyzer.processNumstatLine(line, config);
		return analyzer;
	}

	/** Count changed non-binary, non-excluded lines. */
	static countChangedLines(numstat: string, config: ConventionalGenerationConfig): number {
		return ScopeAnalyzer.fromNumstat(numstat, config).totalLines;
	}

	/** Detect an abstract category for cross-cutting changes. */
	static analyzeWideChange(numstat: string): string | null {
		const paths = numstat
			.split(/\r?\n/)
			.map(pathFromNumstatLine)
			.filter(value => value !== null);
		if (paths.length === 0) return null;
		let markdown = 0;
		let tests = 0;
		let configs = 0;
		let hasCargoToml = false;
		let hasPackageJson = false;
		let errors = 0;
		let types = 0;
		for (const file of paths) {
			const lower = file.toLowerCase();
			const suffix = path.extname(file).toLowerCase();
			if (suffix === ".md") markdown += 1;
			if (file.includes("/test") || file.includes("test_") || file.includes("_test.") || file.includes(".test.")) {
				tests += 1;
			}
			if ([".toml", ".yaml", ".yml", ".json"].includes(suffix)) configs += 1;
			if (file.includes("Cargo.toml")) hasCargoToml = true;
			if (file.includes("package.json")) hasPackageJson = true;
			if (lower.includes("error") || lower.includes("exception") || lower.includes("fail")) errors += 1;
			if (lower.includes("type") || lower.includes("struct") || lower.includes("enum")) types += 1;
		}
		const total = paths.length;
		if (hasCargoToml || hasPackageJson) return "deps";
		if ((markdown * 100) / total > 70) return "docs";
		if ((tests * 100) / total > 60) return "tests";
		if ((errors * 100) / total > 40) return "error-handling";
		if ((types * 100) / total > 40) return "type-refactor";
		if ((configs * 100) / total > 50) return "config";
		return null;
	}

	/** Process one added/deleted/path numstat row. */
	processNumstatLine(line: string, config: ConventionalGenerationConfig): void {
		const parts = line.split("\t");
		if (parts.length < 3) return;
		const additions = parseCount(parts[0] ?? "");
		const deletions = parseCount(parts[1] ?? "");
		const changed = additions + deletions;
		if (changed === 0) return;
		const file = extractPathFromRename(parts.slice(2).join("\t"));
		if (config.excludedFiles.some(pattern => file.endsWith(pattern))) return;
		this.totalLines += changed;
		for (const component of extractComponentsFromPath(file)) {
			if (component.split("/").some(segment => segment.includes("."))) continue;
			this.componentLines.set(component, (this.componentLines.get(component) ?? 0) + changed);
		}
	}

	/** Return candidates sorted by confidence descending. */
	buildScopeCandidates(): ScopeCandidate[] {
		if (this.totalLines === 0) return [];
		const candidates: ScopeCandidate[] = [];
		for (const [candidatePath, lines] of this.componentLines) {
			if (!candidatePath.includes("/") && PLACEHOLDER_DIRS[candidatePath]) continue;
			const percentage = (lines / this.totalLines) * 100;
			const twoSegment = candidatePath.includes("/");
			const confidence = twoSegment ? (percentage > 60 ? percentage * 1.2 : percentage * 0.8) : percentage;
			candidates.push({ path: candidatePath, percentage, confidence });
		}
		return candidates.sort((left, right) => right.confidence - left.confidence);
	}
}

/** Extract the exact scope hint string consumed by llm-git's prompts. */
export function extractScopeCandidates(
	source: string | readonly NumstatEntry[],
	config: ConventionalGenerationConfig,
): ScopeCandidatesResult {
	const numstat =
		typeof source === "string"
			? source
			: source.map(entry => `${entry.additions}\t${entry.deletions}\t${entry.path}`).join("\n");
	const analyzer = ScopeAnalyzer.fromNumstat(numstat, config);
	const candidates = analyzer.buildScopeCandidates();
	if (analyzer.totalLines === 0) return { scopeCandidates: "(none - no meaningful scopes)", isWide: false };
	const wide =
		(candidates.length > 0 && (candidates[0]?.percentage ?? 100) / 100 < config.wideChangeThreshold) ||
		new Set(candidates.map(candidate => candidate.path.split("/", 1)[0])).size >= 3;
	if (wide) {
		const pattern = config.wideChangeAbstract ? ScopeAnalyzer.analyzeWideChange(numstat) : null;
		return {
			scopeCandidates: pattern ? `(cross-cutting: ${pattern})` : "(none - multi-component change)",
			isWide: true,
		};
	}
	const parts: string[] = [];
	for (const candidate of candidates.slice(0, 5)) {
		if (candidate.percentage < 10) continue;
		const confidence =
			candidate.path.includes("/") && candidate.percentage > 60 ? "high confidence" : "moderate confidence";
		parts.push(`${candidate.path} (${candidate.percentage.toFixed(0)}%, ${confidence})`);
	}
	if (parts.length === 0) return { scopeCandidates: "(none - unclear component)", isWide: false };
	let scopeCandidates = parts.join(", ");
	if (candidates.slice(0, 5).some(candidate => candidate.path.includes("/") && candidate.percentage > 60)) {
		scopeCandidates += "\nPrefer 2-segment scopes marked 'high confidence'.";
	}
	return { scopeCandidates, isWide: false };
}

/** Extract a rename destination from git's brace or arrow numstat syntax. */
export function extractPathFromRename(pathPart: string): string {
	const value = pathPart.trim();
	const braceStart = value.indexOf("{");
	if (braceStart >= 0) {
		const arrow = value.indexOf(" => ", braceStart);
		if (arrow >= 0) {
			const braceEnd = value.indexOf("}", arrow);
			if (braceEnd >= 0) {
				return `${value.slice(0, braceStart)}${value.slice(arrow + 4, braceEnd).trim()}${value.slice(braceEnd + 1)}`.trim();
			}
		}
		return value;
	}
	const arrow = value.indexOf(" => ");
	return arrow >= 0 ? value.slice(arrow + 4).trim() : value;
}

/** Extract single- and two-segment meaningful components from a path. */
export function extractComponentsFromPath(file: string): string[] {
	const segments = file.replaceAll("\\", "/").split("/").filter(Boolean);
	const meaningful: string[] = [];
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (PLACEHOLDER_DIRS[segment]) {
			if (segments.length > index + 1) continue;
			break;
		}
		if (segment.includes(".") && !segment.startsWith(".") && segment.lastIndexOf(".") > 0) continue;
		if (SKIP_DIRS[segment]) continue;
		const dot = segment.lastIndexOf(".");
		const stripped = dot >= 0 ? segment.slice(0, dot) : segment;
		if (stripped && !stripped.startsWith(".")) meaningful.push(stripped);
	}
	if (meaningful.length === 0) return [];
	return meaningful.length >= 2 ? [meaningful[0] ?? "", `${meaningful[0]}/${meaningful[1]}`] : [meaningful[0] ?? ""];
}

function pathFromNumstatLine(line: string): string | null {
	const parts = line.split("\t");
	return parts.length >= 3 ? extractPathFromRename(parts.slice(2).join("\t")) : null;
}

function parseCount(raw: string): number {
	const count = Number.parseInt(raw, 10);
	return Number.isNaN(count) ? 0 : count;
}
