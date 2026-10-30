/**
 * `omp anonymize` — write a shareable copy of a session (and its subagent
 * transcripts) with turn contents redacted and metadata preserved.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, isEnoent, pathIsWithin } from "@oh-my-pi/pi-utils";
import { ANONYMIZED_REVIEW_NOTE, anonymizeSessionTranscripts } from "../session/session-anonymizer";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import { loadSessionFile } from "../session/session-loader";
import { resolveSessionFileArg } from "./session-arg";
import { CliUsageError } from "./usage-error";

export interface AnonymizeCommandArgs {
	/** Session file path or id prefix (default: most recent for cwd). */
	session?: string;
	/** Output directory (default: `./<session-file-stem>.anon`). */
	out?: string;
}

export async function runAnonymizeCommand(args: AnonymizeCommandArgs): Promise<void> {
	let sourcePath: string;
	try {
		sourcePath = await resolveSessionFileArg(args.session, getProjectDir());
	} catch (err) {
		// Unknown path/id or no sessions for the cwd is an input mistake, not a crash.
		throw new CliUsageError(err instanceof Error ? err.message : String(err));
	}
	const outDir = path.resolve(args.out ?? `${path.basename(sourcePath, ".jsonl")}.anon`);
	// Subagent transcripts sit next to the real file, not next to a symlink pointing at it.
	const sourceReal = await fs.realpath(sourcePath);
	if (!(await fs.stat(sourceReal)).isFile())
		throw new CliUsageError(__ompTranslate("{0} is not a session file", `${sourcePath}`));
	const { entries: records, malformedRecords } = await loadSessionFile(sourceReal);
	// The loader returns [] for a file without a valid session header.
	const header = records.find((record): record is SessionHeader => record.type === "session");
	if (!header) throw new CliUsageError(__ompTranslate("{0} is not a valid session file", `${sourcePath}`));
	const result = await anonymizeSessionTranscripts({
		header,
		entries: records.filter((record): record is SessionEntry => record.type !== "session"),
		sessionFile: sourceReal,
		malformedRecords,
	});
	// The output must never hold raw transcripts: writing into the session's directory (or an ancestor)
	// could overwrite the session and would bundle it, and `<stem>/` holds raw subagent transcripts.
	let outReal: string;
	let existing: string[];
	try {
		outReal = await realpathAllowingMissing(outDir);
		existing = await fs.readdir(outDir).catch((err: unknown) => {
			if (isEnoent(err)) return [];
			throw err;
		});
	} catch (err) {
		// `-o report.zip` (an existing file) or a file somewhere in the path is an input mistake.
		if ((err as NodeJS.ErrnoException).code === "ENOTDIR") {
			throw new CliUsageError(__ompTranslate("--out {0} is not a directory", `${outDir}`));
		}
		throw err;
	}
	if (
		pathIsWithin(outReal, path.dirname(sourceReal)) ||
		pathIsWithin(sourceReal.slice(0, -".jsonl".length), outReal)
	) {
		throw new CliUsageError(
			__ompTranslate(
				"--out {0} would mix the export with raw session transcripts; choose another directory",
				`${outDir}`,
			),
		);
	}
	// Merging into an existing directory would leave stale or unrelated files beside the export.
	if (existing.length > 0) {
		throw new CliUsageError(__ompTranslate("--out {0} is not empty; choose a new or empty directory", `${outDir}`));
	}
	for (const [name, content] of result.files) await Bun.write(path.join(outDir, name), content);

	const count = result.files.length;
	process.stdout.write(`Anonymized ${count} transcript${count === 1 ? "" : "s"} → ${outDir}\n`);
	if (result.subagentError)
		process.stdout.write(__ompTranslate("Subagent transcripts unavailable: {0}\n", `${result.subagentError}`));
	for (const [member, skipped] of result.malformed) {
		process.stdout.write(`Skipped ${skipped} malformed record${skipped === 1 ? "" : "s"} in ${member}\n`);
	}
	for (const member of result.unreadable)
		process.stdout.write(__ompTranslate("Not exported (no readable session header): {0}\n", `${member}`));
	process.stdout.write(`${ANONYMIZED_REVIEW_NOTE}\n`);
}

/** Real path of `target`, resolving its nearest existing ancestor when it does not exist yet. */
async function realpathAllowingMissing(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch (err) {
		if (!isEnoent(err)) throw err;
		const parent = path.dirname(target);
		if (parent === target) throw err;
		return path.join(await realpathAllowingMissing(parent), path.basename(target));
	}
}
