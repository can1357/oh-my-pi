import * as path from "node:path";
import type { CommitType, ConventionalAnalysis, NumstatEntry } from "../../commit/types";
import type { CommitProposal } from "./state";

const TEST_PATTERNS = ["/test/", "/tests/", "/__tests__/", "_test.", ".test.", ".spec.", "_spec."];
const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".less", ".sass"]);

function inferTypeFromFiles(numstat: NumstatEntry[]): CommitType {
	if (numstat.length === 0) return "chore";

	let hasTests = false;
	let hasDocs = false;
	let hasConfig = false;
	let hasStyle = false;
	let hasSource = false;

	for (const entry of numstat) {
		const lowerPath = entry.path.toLowerCase();
		const ext = getExtension(entry.path);

		if (TEST_PATTERNS.some(pattern => lowerPath.includes(pattern))) {
			hasTests = true;
		} else if (DOC_EXTENSIONS.has(ext)) {
			hasDocs = true;
		} else if (CONFIG_EXTENSIONS.has(ext)) {
			hasConfig = true;
		} else if (STYLE_EXTENSIONS.has(ext)) {
			hasStyle = true;
		} else {
			hasSource = true;
		}
	}

	if (hasTests && !hasSource && !hasDocs) return "test";
	if (hasDocs && !hasSource && !hasTests) return "docs";
	if (hasStyle && !hasSource && !hasTests) return "style";
	if (hasConfig && !hasSource && !hasTests && !hasDocs) return "chore";
	return "refactor";
}

function getExtension(filePath: string): string {
	const name = path.basename(filePath);
	const dotIndex = name.lastIndexOf(".");
	return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

export function generateFallbackAnalysis(numstat: NumstatEntry[]): ConventionalAnalysis {
	const type = inferTypeFromFiles(numstat);
	const details = numstat.slice(0, 3).map(e => ({
		text: `Updated ${path.basename(e.path)}`,
		userVisible: false,
	}));

	return {
		type,
		scope: null,
		details,
		issueRefs: [],
	};
}

export function generateFallbackSummary(type: CommitType, numstat: NumstatEntry[]): string {
	const verbMap: Record<string, string> = {
		test: "updated tests for",
		docs: "updated documentation for",
		refactor: "refactored",
		style: "formatted",
		chore: "updated",
		feat: "updated",
		fix: "updated",
		perf: "updated",
		build: "updated",
		ci: "updated",
		revert: "reverted changes in",
	};
	const verb = verbMap[type] ?? "updated";
	const file = path.basename(numstat[0]?.path ?? "files");

	if (numstat.length === 1) {
		return `${verb} ${file}`;
	}
	return `${verb} ${file} and ${numstat.length - 1} other${numstat.length === 2 ? "" : "s"}`;
}

export function generateFallbackProposal(numstat: NumstatEntry[]): CommitProposal {
	const analysis = generateFallbackAnalysis(numstat);
	const summary = generateFallbackSummary(analysis.type, numstat);

	return {
		analysis,
		summary,
		warnings: ["Commit generated using fallback due to agent failure"],
	};
}
