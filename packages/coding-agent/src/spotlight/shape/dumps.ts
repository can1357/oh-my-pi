/**
 * Data dumps: lossless compaction under a header naming where the verbatim text is. The
 * valve, not this step, decides how much of a long dump the agent sees.
 */
import { namesSource, printsFiles, readsOnlyData, SOURCE_PATH } from "./command";
import { densify, losslessView } from "./compact";
import { bump, type Run } from "./run";
import type { View } from "./view";

/** Outputs this short (in lines and characters) pass through untouched. */
const PASS_LINES = 40;
const PASS_CHARS = 6_000;
/** A file read naming no data stays whole unless its strict JSON compacts to more than this. */
const FILE_JSON_CHARS = 30_000;

/**
 * A read whose strict JSON compacts to over 30k characters: the compacted JSON. `verbatim` names where the raw text
 * is (the file for `read`, a saved copy for bash).
 */
async function jsonFileDump(run: Run, raw: string, verbatim: () => Promise<string>): Promise<View | undefined> {
	const dense = densify(raw, true);
	if (!dense.blocks || dense.text.length <= FILE_JSON_CHARS) return undefined;
	bump(run, "compacted");
	const header = `[display only: compacted JSON; verbatim: ${await verbatim()}]`;
	return { lines: [header, ...dense.text.split("\n")], spans: null };
}

/** The lossless view under a header naming the verbatim text; undefined when compaction changes nothing. */
async function compactDump(run: Run, raw: string, verbatim: () => Promise<string>): Promise<View | undefined> {
	const lossless = losslessView(raw);
	if (lossless === raw) return undefined;
	bump(run, "compacted");
	const header = `[display only: compacted/trimmed; verbatim: ${await verbatim()}]`;
	return { lines: [header, ...lossless.split("\n")], spans: null };
}

/** Command output (bash, eval) as a dump; undefined when it passes through. */
export async function shapeDumpOutput(run: Run, text: string): Promise<string | undefined> {
	const raw = text.replace(/\n+$/, "");
	if (raw.split("\n").length <= PASS_LINES && raw.length <= PASS_CHARS) return undefined;
	const command = run.input.command ?? "";
	let saved: Promise<string> | undefined;
	const verbatim = () => (saved ??= run.sink.save(raw, run.input.tool));
	const sourceDump =
		run.input.tool === "bash" && printsFiles(command) && !readsOnlyData(command) && namesSource(command);
	const view = sourceDump ? await jsonFileDump(run, raw, verbatim) : await compactDump(run, raw, verbatim);
	return view?.lines.join("\n");
}

/** A `read` of a file as a dump: a non-source file compacted, a source file only past 30k of strict JSON. */
export async function shapeDumpRead(run: Run): Promise<View | undefined> {
	const read = run.input.read;
	if (!read) return undefined;
	const raw = read.lines.join("\n");
	if (read.lines.length <= PASS_LINES && raw.length <= PASS_CHARS) return undefined;
	const verbatim = async () => read.path;
	if (SOURCE_PATH.test(read.path)) return jsonFileDump(run, raw, verbatim);
	return compactDump(run, raw, verbatim);
}
