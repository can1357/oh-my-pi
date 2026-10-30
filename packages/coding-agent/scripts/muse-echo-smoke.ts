/**
 * Offline smoke run for the Muse delegation runner.
 *
 * Usage (from the repo root):
 *   bun packages/coding-agent/scripts/muse-echo-smoke.ts "say hello and finish"
 *
 * This is the only caller that passes `--provider echo`. It never contacts the
 * licensed provider, never reads credentials, and prints only the sanitized
 * outcome the tool would return.
 */
import * as path from "node:path";
import { runMuseExec } from "../src/muse/exec";

const prompt = process.argv[2]?.trim() || "say hello and finish";
const workspace = path.resolve(process.argv[3] ?? process.cwd());

try {
	const result = await runMuseExec({
		prompt,
		workspace,
		provider: "echo",
		timeoutMs: 120_000,
	});
	const { outcome } = result;
	console.log(
		JSON.stringify(
			{
				status: outcome.status,
				terminal: outcome.terminal,
				reason: outcome.reason,
				answer: outcome.answer,
				records: outcome.records,
				skippedLines: outcome.skippedLines,
				unknownPayloads: outcome.unknownPayloads,
				tasks: outcome.tasks,
				usage: outcome.usage,
				elapsedMs: result.elapsedMs,
				exitCode: result.exitCode,
				stderr: result.stderr,
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
