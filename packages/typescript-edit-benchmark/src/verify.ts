/**
 * File verification for edit benchmark.
 *
 * Compares output files against expected fixtures after Prettier formatting.
 * JavaScript and TypeScript also tolerate syntax-aware formatting differences;
 * whitespace inside literals and unparseable files remains significant.
 */
import * as path from "node:path";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { diffLines } from "diff";
import { formatContent } from "./formatter";
import { listFiles } from "./shared";

export interface VerificationResult {
	success: boolean;
	error?: string;
	duration: number;
	indentScore?: number;
	formattedEquivalent?: boolean;
	diffStats?: DiffStats;
	diff?: string;
}

export interface DiffStats {
	linesChanged: number;
	charsChanged: number;
}

function formatFileList(files: string[]): string {
	return files.length === 0 ? "(none)" : files.join(", ");
}

function createCompactDiff(expected: string, actual: string, contextLines = 3): string {
	const changes = diffLines(expected, actual);
	const output: string[] = [];
	let lineNum = 1;

	for (let i = 0; i < changes.length; i++) {
		const change = changes[i]!;
		const lines = splitLines(change.value);

		if (change.added || change.removed) {
			// Show context before (from previous unchanged chunk)
			if (i > 0 && !changes[i - 1]!.added && !changes[i - 1]!.removed) {
				const prevLines = splitLines(changes[i - 1]!.value);
				const contextStart = Math.max(0, prevLines.length - contextLines);
				if (contextStart > 0) {
					output.push(`@@ -${lineNum - (prevLines.length - contextStart)} @@`);
				}
				for (let j = contextStart; j < prevLines.length; j++) {
					output.push(` ${prevLines[j]}`);
				}
			}

			// Show the change
			const prefix = change.added ? "+" : "-";
			for (const line of lines) {
				output.push(`${prefix}${line}`);
			}

			// Show context after (from next unchanged chunk)
			if (i + 1 < changes.length && !changes[i + 1]!.added && !changes[i + 1]!.removed) {
				const nextLines = splitLines(changes[i + 1]!.value);
				const contextEnd = Math.min(nextLines.length, contextLines);
				for (let j = 0; j < contextEnd; j++) {
					output.push(` ${nextLines[j]}`);
				}
			}

			if (!change.added) {
				lineNum += lines.length;
			}
		} else {
			lineNum += lines.length;
		}
	}

	return output.join("\n");
}

export async function verifyExpectedFiles(expectedDir: string, actualDir: string): Promise<VerificationResult> {
	return verifyExpectedFileSubset(expectedDir, actualDir);
}

export async function verifyExpectedFileSubset(
	expectedDir: string,
	actualDir: string,
	files?: string[],
): Promise<VerificationResult> {
	const startTime = Date.now();
	let totalIndentScore = 0;
	let fileCount = 0;

	try {
		const expectedFixtureFiles = await listFiles(expectedDir);
		const expectedFiles = files?.length ? files.slice().sort() : expectedFixtureFiles;
		const actualFiles = await listFiles(actualDir);

		const missingFiles = expectedFiles.filter(file => !actualFiles.includes(file));
		const extraFiles = actualFiles.filter(file => !expectedFiles.includes(file));
		const missingExpected = expectedFiles.filter(file => !expectedFixtureFiles.includes(file));

		if (missingExpected.length > 0) {
			return {
				success: false,
				error: `Expected files missing from fixture: ${formatFileList(missingExpected)}`,
				duration: Date.now() - startTime,
			};
		}

		if (missingFiles.length > 0 || (files === undefined && extraFiles.length > 0)) {
			const parts: string[] = [];
			if (missingFiles.length > 0) {
				parts.push(`Missing files: ${formatFileList(missingFiles)}`);
			}
			if (files === undefined && extraFiles.length > 0) {
				parts.push(`Unexpected files: ${formatFileList(extraFiles)}`);
			}

			return {
				success: false,
				error: parts.join("; "),
				duration: Date.now() - startTime,
			};
		}

		for (const file of expectedFiles) {
			const expectedPath = path.join(expectedDir, file);
			const actualPath = path.join(actualDir, file);
			const expectedRaw = await Bun.file(expectedPath).text();
			const actualRaw = await Bun.file(actualPath).text();
			const expectedNormalized = normalizeLineEndings(expectedRaw);
			const actualNormalized = normalizeLineEndings(actualRaw);
			const expectedFormatted = await formatContent(expectedPath, expectedNormalized);
			const actualFormatted = await formatContent(actualPath, actualNormalized);
			const formattedEquivalent =
				expectedFormatted.formatted === actualFormatted.formatted ||
				(expectedFormatted.didFormat &&
					actualFormatted.didFormat &&
					normalizeCodeFormatting(file, expectedFormatted.formatted) ===
						normalizeCodeFormatting(file, actualFormatted.formatted));

			// Indent score: distance between agent's raw output and formatted output
			// This measures how much the formatter had to fix the agent's indentation
			const fileIndentScore = computeIndentDistanceForDiff(actualNormalized, actualFormatted.formatted);
			totalIndentScore += fileIndentScore;
			fileCount++;

			// Fail if formatted versions don't match (content is wrong, not just whitespace)
			if (!formattedEquivalent) {
				const diffOutput = createCompactDiff(expectedFormatted.formatted, actualFormatted.formatted);
				const diffStats = computeDiffStats(expectedFormatted.formatted, actualFormatted.formatted);
				return {
					success: false,
					error: `File mismatch for ${file}`,
					duration: Date.now() - startTime,
					diff: diffOutput,
					diffStats,
					indentScore: fileIndentScore,
					formattedEquivalent,
				};
			}
		}

		return {
			success: true,
			duration: Date.now() - startTime,
			indentScore: fileCount > 0 ? totalIndentScore / fileCount : 0,
			formattedEquivalent: true,
			diffStats: { linesChanged: 0, charsChanged: 0 },
		};
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
			duration: Date.now() - startTime,
		};
	}
}

function computeDiffStats(expected: string, actual: string): DiffStats {
	const changes = diffLines(expected, actual);
	let linesChanged = 0;
	let charsChanged = 0;

	for (const change of changes) {
		if (!change.added && !change.removed) {
			continue;
		}
		const lines = splitLines(change.value);
		linesChanged += lines.length;
		charsChanged += change.value.length;
	}

	return { linesChanged, charsChanged };
}

function computeIndentDistanceForDiff(expected: string, actual: string): number {
	const changes = diffLines(expected, actual);
	let totalDistance = 0;
	let samples = 0;
	let pendingRemoved: string[] = [];
	let pendingAdded: string[] = [];

	const flush = () => {
		const max = Math.max(pendingRemoved.length, pendingAdded.length);
		for (let i = 0; i < max; i++) {
			const removedLine = pendingRemoved[i] ?? "";
			const addedLine = pendingAdded[i] ?? "";
			totalDistance += Math.abs(countIndent(removedLine) - countIndent(addedLine));
			samples += 1;
		}
		pendingRemoved = [];
		pendingAdded = [];
	};

	for (const change of changes) {
		const lines = splitLines(change.value);
		if (change.removed) {
			pendingRemoved.push(...lines);
			continue;
		}
		if (change.added) {
			pendingAdded.push(...lines);
			continue;
		}
		if (pendingRemoved.length > 0 || pendingAdded.length > 0) {
			flush();
		}
	}
	if (pendingRemoved.length > 0 || pendingAdded.length > 0) {
		flush();
	}

	return samples > 0 ? totalDistance / samples : 0;
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

/** Remove only syntax-level formatting, preserving literal and comment contents. */
function normalizeCodeFormatting(file: string, content: string): string {
	const extension = path.extname(file).toLowerCase();
	if (![".js", ".jsx", ".ts", ".tsx"].includes(extension)) return content;
	try {
		const ast = parse(content, {
			sourceType: "unambiguous",
			allowReturnOutsideFunction: true,
			plugins: [
				extension === ".ts" || extension === ".tsx" ? "typescript" : "flow",
				"jsx",
				"flowComments",
				"importAssertions",
				"decorators-legacy",
			],
		});
		return generate(ast, { compact: true }).code;
	} catch {
		return content;
	}
}

function splitLines(value: string): string[] {
	return value.split("\n").filter((line, idx, arr) => idx < arr.length - 1 || line);
}

function countIndent(line: string): number {
	let count = 0;
	for (const char of line) {
		if (char === " ") {
			count += 1;
		} else if (char === "\t") {
			count += 2;
		} else {
			break;
		}
	}
	return count;
}
