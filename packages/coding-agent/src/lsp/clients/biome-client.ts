/**
 * Biome CLI-based linter client.
 * Uses Biome's CLI with JSON output instead of LSP (which has stale diagnostics issues).
 */
import * as path from "node:path";
import { logger, ptree } from "@oh-my-pi/pi-utils";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../../lsp/types";
import { linterFilePath, runLinterCli } from "./cli-process";

// =============================================================================
// Biome JSON Output Types
// =============================================================================

interface BiomeJsonOutput {
	diagnostics: BiomeDiagnostic[];
}

/**
 * A single diagnostic from Biome's `--reporter=json` output (Biome 2.x).
 *
 * Positions are 1-indexed `{ line, column }` pairs; the path is a plain string
 * relative to the CLI's cwd. Older releases used byte-offset `span`s, which
 * this client no longer parses.
 */
interface BiomeDiagnostic {
	category: string; // e.g., "lint/correctness/noUnusedVariables"
	severity: string; // "error" | "warning" | "info" | "hint"
	message: string;
	location?: {
		path?: string;
		start?: { line: number; column: number };
		end?: { line: number; column: number };
	};
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse Biome severity to LSP DiagnosticSeverity.
 */
function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
			return 3;
		case "hint":
			return 4;
		default:
			return 2;
	}
}

/**
 * Run a Biome CLI command in its own process group (see `runLinterCli`).
 * Aborts and deadline expiry reject; a binary that cannot start is a failed run.
 */
async function runBiome(
	args: string[],
	cwd: string,
	resolvedCommand: string | undefined,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "biome";

	try {
		const { stdout, stderr, exitCode } = await runLinterCli(command, args, cwd, signal);
		return { stdout, stderr, success: exitCode === 0 };
	} catch (err) {
		if (signal?.aborted || (err instanceof ptree.Exception && err.aborted)) throw err;
		return { stdout: "", stderr: String(err), success: false };
	}
}

// Surface broken-binary / CLI failures once instead of silently reporting
// "no diagnostics" forever (and instead of spamming every writethrough).
const reportedBiomeFailures = new Set<string>();

function warnBiomeOnce(key: string, message: string, meta: Record<string, unknown>): void {
	if (reportedBiomeFailures.has(key)) return;
	reportedBiomeFailures.add(key);
	logger.warn(message, meta);
}

// =============================================================================
// Biome Client
// =============================================================================

/**
 * Biome CLI-based linter client.
 * Parses Biome's --reporter=json output into LSP Diagnostic format.
 */
export class BiomeClient implements LinterClient {
	/** Factory method for creating BiomeClient instances */
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new BiomeClient(config, cwd);
	}

	/**
	 * @param cwd - The Biome project root of the files this client serves; Biome
	 *   runs there, so it reads that root's configuration and reports paths
	 *   relative to it.
	 */
	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async format(filePath: string, content: string, signal?: AbortSignal): Promise<string> {
		// Keep the standalone LinterClient contract: callers supply the content to
		// format, regardless of what is currently on disk.
		await Bun.write(filePath, content);
		// The physical path: this client's root was found from it, and Biome
		// resolves its config and ignore rules for a path inside that root.
		const target = linterFilePath(filePath);

		const result = await runBiome(["format", "--write", target], this.cwd, this.config.resolvedCommand, signal);

		if (result.success) {
			return await Bun.file(target).text();
		}

		// Format failed, return original
		return content;
	}

	async lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]> {
		const target = linterFilePath(filePath);
		// Run biome lint with JSON reporter
		const result = await runBiome(["lint", "--reporter=json", target], this.cwd, this.config.resolvedCommand, signal);

		// Biome exits non-zero when diagnostics are found, so only an empty
		// stdout signals an actual run failure (missing binary, CLI error).
		if (!result.success && result.stdout.trim().length === 0) {
			warnBiomeOnce(`run:${this.cwd}`, "Biome lint failed; reporting no diagnostics", {
				cwd: this.cwd,
				stderr: result.stderr.slice(0, 500),
			});
			return [];
		}

		return this.#parseJsonOutput(result.stdout, target);
	}

	/**
	 * Parse Biome's JSON output into LSP Diagnostics.
	 */
	#parseJsonOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
		let parsed: BiomeJsonOutput;
		try {
			parsed = JSON.parse(jsonOutput);
		} catch {
			warnBiomeOnce(`parse:${this.cwd}`, "Failed to parse Biome JSON output; reporting no diagnostics", {
				cwd: this.cwd,
				file: targetFile,
			});
			return [];
		}

		const emitted = parsed.diagnostics ?? [];
		const target = linterFilePath(targetFile);
		const diagnostics: Diagnostic[] = [];
		// Biome's JSON reporter is experimental and may reshape its output in
		// patch releases. Track whether any diagnostic carried a usable location
		// so a schema drift surfaces as a warning instead of a silent empty list.
		let sawUsableLocation = false;

		for (const diag of emitted) {
			const location = diag.location;
			const filePath = location?.path;
			if (!filePath) continue;
			sawUsableLocation = true;

			// Biome reports paths relative to its cwd.
			const diagFile = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);

			// Only include diagnostics for the target file (compared physically:
			// the client root may be spelled through a symlink).
			if (linterFilePath(diagFile) !== target) continue;

			// Biome positions are 1-indexed; LSP ranges are 0-indexed.
			const start = location.start;
			const end = location.end ?? start;
			const startLine = start?.line ?? 1;
			const startColumn = start?.column ?? 1;
			const endLine = end?.line ?? startLine;
			const endColumn = end?.column ?? startColumn;

			diagnostics.push({
				range: {
					start: { line: startLine - 1, character: startColumn - 1 },
					end: { line: endLine - 1, character: endColumn - 1 },
				},
				severity: parseSeverity(diag.severity),
				message: diag.message,
				source: "biome",
				code: diag.category,
			});
		}

		// Non-empty output whose diagnostics all lacked a recognizable location
		// means the reporter schema changed out from under us — warn loudly
		// instead of masking the regression as "no lint issues".
		if (emitted.length > 0 && !sawUsableLocation) {
			warnBiomeOnce(
				`schema:${this.cwd}`,
				"Biome diagnostics had no recognizable location; reporter schema may have changed",
				{ cwd: this.cwd, file: targetFile, count: emitted.length },
			);
		}

		return diagnostics;
	}

	dispose(): void {
		// Nothing to dispose: each run is bounded by its caller's signal, its deadline and process teardown.
	}
}
