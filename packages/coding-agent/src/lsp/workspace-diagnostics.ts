import * as fs from "node:fs";
import * as path from "node:path";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";

/** Project type detection result */
export interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "dart" | "unknown";
	command?: string[];
	description: string;
}

/**
 * How many workspace checkers may run at once.
 *
 * Checkers like `cargo check` and `tsc` are each CPU- and memory-hungry and
 * already parallelize internally, so a polyglot root runs them a couple at a
 * time rather than launching every toolchain at once.
 */
const MAX_CONCURRENT_CHECKERS = 2;

/** Convert a `go.work` use directory into the package pattern `go build` needs. */
function goWorkspaceBuildPattern(diskPath: string): string | null {
	const trimmed = diskPath.trim();
	if (!trimmed) return null;

	const isAbsolute = path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed);
	const normalized = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
	const dir = normalized || ".";
	if (dir === ".") return "./...";
	if (dir.endsWith("/...")) return dir;
	if (isAbsolute || dir.startsWith("./") || dir.startsWith("../")) return `${dir}/...`;
	return `./${dir}/...`;
}

/** Parse `go work edit -json` output into per-module package patterns. */
function parseGoWorkspaceBuildPatterns(output: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return [];
	}

	if (!parsed || typeof parsed !== "object" || !("Use" in parsed) || !Array.isArray(parsed.Use)) return [];

	const patterns = new Set<string>();
	for (const entry of parsed.Use) {
		if (!entry || typeof entry !== "object" || !("DiskPath" in entry) || typeof entry.DiskPath !== "string") {
			continue;
		}
		const pattern = goWorkspaceBuildPattern(entry.DiskPath);
		if (pattern) patterns.add(pattern);
	}
	return [...patterns];
}

/** Resolve the `go build` command for a `go.work` workspace. */
async function resolveGoWorkspaceDiagnosticsCommand(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const fallback = ["go", "build", "./..."];
	try {
		const proc = Bun.spawn(["go", "work", "edit", "-json"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const abortHandler = () => {
			proc.kill();
		};
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const exitCode = await proc.exited;
			throwIfAborted(signal);
			if (exitCode !== 0) return fallback;
			const patterns = parseGoWorkspaceBuildPatterns(stdout);
			return patterns.length > 0 ? ["go", "build", ...patterns] : fallback;
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}
	} catch {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return fallback;
	}
}

/**
 * Detect every project type present at the workspace root.
 *
 * Detection used to return on the first matching marker, so a polyglot root
 * (for example `Cargo.toml` alongside `tsconfig.json`) only ever ran the
 * highest-priority checker and silently skipped the rest: the workspace was
 * reported as verified while whole languages went unchecked. Every marker is
 * collected instead, in the original priority order, so single-language roots
 * keep their exact previous result while polyglot roots check everything.
 *
 * `go.work` still wins over `go.mod` and `pyproject.toml` over
 * `pyrightconfig.json` — those pairs are two markers for one toolchain, not
 * two separate languages.
 */
export async function detectProjectTypes(cwd: string, signal?: AbortSignal): Promise<ProjectType[]> {
	const detected: ProjectType[] = [];
	const marker = (name: string) => fs.existsSync(path.join(cwd, name));

	if (marker("Cargo.toml")) {
		const command = ["cargo", "check", "--message-format=short"];
		detected.push({ type: "rust", command, description: "Rust (cargo check)" });
	}

	if (marker("tsconfig.json")) {
		const command = ["npx", "tsc", "--noEmit"];
		detected.push({ type: "typescript", command, description: "TypeScript (tsc --noEmit)" });
	}

	// Check for Go workspaces before single-module Go projects.
	if (marker("go.work")) {
		detected.push({
			type: "go",
			command: await resolveGoWorkspaceDiagnosticsCommand(cwd, signal),
			description: "Go workspace (go build)",
		});
	} else if (marker("go.mod")) {
		detected.push({ type: "go", command: ["go", "build", "./..."], description: "Go (go build)" });
	}

	if (marker("pyproject.toml") || marker("pyrightconfig.json")) {
		detected.push({ type: "python", command: ["pyright"], description: "Python (pyright)" });
	}

	// Dart/Flutter (pubspec.yaml). `dart analyze` covers Flutter packages too,
	// so there is no need to branch on whether this is a Flutter project.
	if (marker("pubspec.yaml")) {
		detected.push({ type: "dart", command: ["dart", "analyze"], description: "Dart (dart analyze)" });
	}

	if (detected.length === 0) {
		return [{ type: "unknown", description: "Unknown project type" }];
	}
	return detected;
}

/** Interpret an empty checker result without mistaking a crash for a clean workspace. */
export function interpretEmptyDiagnosticsResult(
	exitCode: number,
	signalCode: string | null,
	command: readonly string[],
): string {
	if (exitCode === 0) return "No issues found";
	const detail = signalCode ? `was killed by ${signalCode}` : `exited with code ${exitCode}`;
	return `Failed to run ${command.join(" ")}: the checker ${detail} without reporting anything, so the workspace was not verified`;
}

/** Join per-language descriptions for the aggregate header. */
export function combineProjectDescriptions(projectTypes: readonly ProjectType[]): string {
	return projectTypes.map(projectType => projectType.description).join(" + ");
}

/**
 * Label each section when more than one checker ran.
 *
 * A single detected language keeps the bare output it has always produced, so
 * existing callers and their expectations are untouched.
 */
export function combineDiagnosticsOutputs(sections: readonly { description: string; output: string }[]): string {
	if (sections.length === 1) return sections[0]?.output ?? "";
	return sections.map(section => `=== ${section.description} ===\n${section.output}`).join("\n\n");
}

/** Run a bounded number of tasks at a time, preserving input order in the results. */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;

	const worker = async (): Promise<void> => {
		while (true) {
			const index = cursor++;
			const item = items[index];
			if (index >= items.length || item === undefined) return;
			results[index] = await run(item);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Run one language's checker and render its output. */
async function runProjectDiagnostics(cwd: string, projectType: ProjectType, signal?: AbortSignal): Promise<string> {
	const command = projectType.command;
	if (!command) {
		return "Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.work/go.mod), Python (pyproject.toml), Dart (pubspec.yaml)";
	}
	try {
		const proc = Bun.spawn(command, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const abortHandler = () => {
			proc.kill();
		};
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;
			throwIfAborted(signal);
			const combined = (stdout + stderr).trim();
			if (!combined) {
				// A checker that exits non-zero without writing a single byte never
				// inspected the workspace: it failed to start (missing toolchain),
				// crashed, or was killed (OOM). Reporting "No issues found" there
				// tells the agent the workspace is clean when nothing actually
				// checked it. A non-zero exit *with* output is the normal way
				// tsc/cargo/pyright report diagnostics and still falls through to
				// the branch below. Mirrors the exit-status gate
				// `resolveGoWorkspaceDiagnosticsCommand` already applies above.
				return interpretEmptyDiagnosticsResult(exitCode, proc.signalCode, command);
			}
			// Limit output length. The cap is per language so a noisy checker
			// cannot crowd its siblings out of a polyglot report.
			const lines = combined.split("\n");
			if (lines.length > 50) {
				return `${lines.slice(0, 50).join("\n")}\n[…${lines.length - 50}ln elided…]`;
			}
			return combined;
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}
	} catch (e) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return `Failed to run ${command.join(" ")}: ${e}`;
	}
}

/** Run workspace diagnostics command and parse output */
export async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType; projectTypes: ProjectType[] }> {
	throwIfAborted(signal);
	const projectTypes = await detectProjectTypes(cwd, signal);
	const primary = projectTypes[0] ?? { type: "unknown" as const, description: "Unknown project type" };
	// Keep the single-language shape byte-identical; only name every checker
	// when more than one actually ran.
	const projectType =
		projectTypes.length > 1 ? { ...primary, description: combineProjectDescriptions(projectTypes) } : primary;

	const outputs = await mapWithConcurrency(projectTypes, MAX_CONCURRENT_CHECKERS, async detectedType => ({
		description: detectedType.description,
		output: await runProjectDiagnostics(cwd, detectedType, signal),
	}));

	return { output: combineDiagnosticsOutputs(outputs), projectType, projectTypes };
}
