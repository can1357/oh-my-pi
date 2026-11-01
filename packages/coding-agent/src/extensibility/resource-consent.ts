/**
 * What a person is shown before resource files leave the machine. Shared by the `/skills
 * diagnostics` panel and `plugin doctor --analyze` so both disclose the same boundary and both settle caps
 * before the first prompt.
 */
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { MAX_RESOURCE_ANALYSIS_PROMPT_BYTES, preflightResourceAnalysis } from "./resource-analysis";
import type { ResourceSnapshot } from "./resource-snapshot";

/**
 * Known secret patterns and credential files are filtered, which is not a guarantee: a secret in an
 * unrecognised form inside a listed file is sent as written. The prompt must say so.
 */
export const SEND_DISCLOSURE =
	"Files are treated as data and never executed. Known secret patterns and credential files are filtered out, but the files can still contain private information in other forms: review what is listed before sending. Your conversation, system prompt and credential store are not included. Charges may apply.";

export const INCOMPLETE_COVERAGE_DISCLOSURE =
	"Coverage is incomplete: skipped files (links, oversized, unreadable or past a limit) are not shown to the model, so the result is advisory and can never be used to hide a copy.";

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

/** One line: label, location, files and size read, and whether coverage was partial. */
export function describeSnapshot(snapshot: ResourceSnapshot): string {
	const { label, root } = snapshot.candidate;
	const bytes = snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
	const partial = snapshot.complete ? "" : `, PARTIAL: ${snapshot.omissions.length} omission(s)`;
	return `${sanitizeDisplaySingleLine(label)}  ${sanitizeDisplaySingleLine(root)} (${snapshot.files.length} files, ${kib(bytes)}${partial})`;
}

/**
 * The request as it will be sent: each resource with size and coverage, the total against the cap,
 * and a warning for partial coverage. Throws, before anything is asked or billed, when the analyzer
 * would refuse the request (too few or too many resources, over the size cap, duplicate roots).
 */
export function describeRequest(snapshots: readonly ResourceSnapshot[]): string {
	const { bytes } = preflightResourceAnalysis(snapshots);
	const lines = snapshots.map(snapshot => `  ${describeSnapshot(snapshot)}`);
	lines.push(
		`Resource data: ${kib(bytes)} of the ${kib(MAX_RESOURCE_ANALYSIS_PROMPT_BYTES)} budget, plus prompt framing.`,
	);
	if (snapshots.some(snapshot => !snapshot.complete)) {
		lines.push(INCOMPLETE_COVERAGE_DISCLOSURE);
	}
	return lines.join("\n");
}
