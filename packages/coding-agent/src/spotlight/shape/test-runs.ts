/**
 * Test and lint runs become failures plus summary: failure sections, failure detail
 * with context, summary, diff and `path:line:col` lines and the tail stay; every other run of 3+ lines becomes one
 * counted marker into the saved full log. Kept lines are structure (`s`), short runs between them shown as context
 * (`c`), the noise folded (`f`).
 */
import type { SpotlightReason } from "@oh-my-pi/pi-tui/chat/spotlight";
import { alignedTo, bump, noteWhy, type Run, shifted } from "./run";
import { readCall } from "./view";

/** Shorter logs are shown as printed. */
const MIN_LINES = 40;
/** Shaping must hide at least this share of the lines. */
const MIN_HIDDEN = 0.3;
const BEFORE = 2;
const AFTER = 6;
const TAIL = 8;

const FAIL_LINE =
	/\b(FAIL(?:ED|URE|S)?|ERRORS?|Error|Errno|Exception|Traceback|assert(?:ion)?|Expected|Received|expected|received|panicked|Timeout|timed out)\b|[×✗✕●]|^E\s|^>\s|^\s+at\s|\.(?:py|ts|tsx|js):\d+/;
const SUMMARY_LINE =
	/\b\d+\s+(?:passed|failed|skipped|errors?|xfailed|warnings?|tests?)\b|Test Files|^\s*Tests\s+\d|Duration|^=+.*=+$|exit code/i;
const KEEP_LINE = /^(?:diff --git|@@|\+\+\+|---)|:\d+:\d+:|^\[exit code/;

/** Which lines of a test log stay; undefined when the log is too short or shaping would hide too little. */
function keptLines(lines: readonly string[]): Uint8Array | undefined {
	if (lines.length < MIN_LINES) return undefined;
	const keep = new Uint8Array(lines.length);
	let inFail = false;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (/^=+ (FAILURES|ERRORS) =+$|⎯+ Failed Tests|^FAIL\s|^\s*FAIL\s/.test(l)) inFail = true;
		if (/^=+ (short test summary|warnings summary|\d+ (passed|failed))|^\s*Test Files\s|^\s*Tests\s+\d/.test(l)) {
			inFail = false;
		}
		if (/short test summary/.test(l)) {
			for (let k = i; k < lines.length && !/^=+ \d+/.test(lines[k - 1] ?? ""); k++) keep[k] = 1;
		}
		if (inFail || KEEP_LINE.test(l) || SUMMARY_LINE.test(l)) keep[i] = 1;
		if (FAIL_LINE.test(l) && !/^\s*[✓√✔]/.test(l) && !/\bPASS(ED)?\b/.test(l) && !/Warning\b/.test(l)) {
			for (let k = Math.max(0, i - BEFORE); k <= Math.min(lines.length - 1, i + AFTER); k++) keep[k] = 1;
		}
	}
	for (let i = Math.max(0, lines.length - TAIL); i < lines.length; i++) keep[i] = 1;
	let hidden = 0;
	for (let i = 0; i < lines.length;) {
		if (keep[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < lines.length && !keep[j]) j++;
		if (j - i > 2) hidden += j - i;
		i = j;
	}
	return hidden >= MIN_HIDDEN * lines.length ? keep : undefined;
}

/** A test log cut to failures plus summary, gaps pointing into the saved log; undefined when not worth it. */
export async function shapeTestRun(run: Run, text: string): Promise<string | undefined> {
	const lines = text.split("\n");
	const keep = keptLines(lines);
	if (!keep) return undefined;
	const log = await run.sink.save(text, run.input.tool);
	const out: string[] = [];
	const why = Array.from<SpotlightReason>({ length: lines.length }).fill("s");
	let hidden = 0;
	for (let i = 0; i < lines.length;) {
		if (keep[i]) {
			out.push(lines[i++]);
			continue;
		}
		let j = i;
		while (j < lines.length && !keep[j]) j++;
		if (j - i <= 2) {
			why.fill("c", i, j);
			while (i < j) out.push(lines[i++]);
			continue;
		}
		why.fill("f", i, j);
		out.push(`… [${j - i} lines: ${readCall(log, i + 1, j)}]`);
		hidden += j - i;
		i = j;
	}
	// Until another step rewrites it, the log is the result's own text: its lines are base lines from the first.
	noteWhy(run, text === run.input.text ? shifted(0) : alignedTo(run, lines), why);
	bump(run, "testShaped");
	bump(run, "testHiddenLines", hidden);
	return out.join("\n");
}
