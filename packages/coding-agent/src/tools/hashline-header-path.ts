import {
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
} from "@oh-my-pi/pi-tui/tools/hashline-format";

const HL_TRAILING_TAG_RE = new RegExp(`${HL_FILE_HASH_SEP}[0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}}$`);

/** Strip the hashline `[path#TAG]` wrapper from a write/edit target so the inner
 *  filesystem path drives both authorization and resolution. Only unwraps inputs
 *  that match the strict hashline header shape (`[path]` or `[path#XXXX]` with a
 *  4-hex tag); anything else returns the original string so the downstream
 *  resolver surfaces the real error. A valid tag disambiguates a `#` inside the
 *  path (yadm alt files: `conf.yaml##hostname.home`), matching the Rust
 *  tokenizer. Used by the plan-mode guard's `resolvePlanPath` and by callers
 *  (e.g. `write`) that make scheme/bridge-routing decisions before it runs. */
export function unwrapHashlineHeaderPath(targetPath: string): string {
	const trimmed = targetPath.trimEnd();
	if (
		trimmed.length < HL_FILE_PREFIX.length + HL_FILE_SUFFIX.length ||
		trimmed[0] !== HL_FILE_PREFIX ||
		trimmed[trimmed.length - 1] !== HL_FILE_SUFFIX
	) {
		return targetPath;
	}
	const inner = trimmed.slice(HL_FILE_PREFIX.length, trimmed.length - HL_FILE_SUFFIX.length);
	const tagMatch = HL_TRAILING_TAG_RE.exec(inner);
	const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner;
	// A valid header is exactly `PATH` or `PATH#XXXX`; reject any other shape
	// (selectors, non-hex tags, untagged `#`) so we never silently rewrite a
	// path the model did not author.
	if (pathPart.length === 0 || (!tagMatch && pathPart.includes(HL_FILE_HASH_SEP))) return targetPath;
	return pathPart;
}
