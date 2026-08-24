import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { salvageOutputMeta } from "@oh-my-pi/pi-coding-agent/presentation/schemas/output-meta";
import { formatOutputNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

function stringField(value: object, key: string): string | undefined {
	if (!(key in value)) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Every string a producer recorded structurally for a renderer to surface,
 * shared by `test/acp-producer-wire.test.ts`'s matrix and
 * `test/acp-event-mapper.test.ts`'s `mapUpdates()` wrapper (mechanism 2).
 *
 * `details.notices`/`details.notice`/`details.meta`'s rendered notice cover a
 * legacy/external producer's declared facts; a migrated producer on the
 * presentation protocol (bash/eval's ordinary routes) never populates
 * `details` with any of these any more — its facts are real `ToolFact`s on
 * `presentationEvents`, read here too when the caller has them. The
 * top-level `errorMessage`/`message`/`text` framework note (mirroring the
 * mapper's own `extractDirectText`) is the axis that had none — the eval
 * image fallback dropped it in `terminalMetaCapable` mode with no test
 * anywhere asking whether it survived.
 */
function artifactIds(text: string): string[] {
	return [...text.matchAll(/artifact:\/\/(\w+)/g)].map(m => m[1] as string);
}

export function producerFacts(
	result: AgentToolResult<unknown> | Record<string, unknown>,
	presentationEvents?: readonly ToolPresentationEvent[],
): string[] {
	const facts: string[] = [];
	if (typeof result === "object" && result !== null) {
		const directText =
			stringField(result, "text") ?? stringField(result, "errorMessage") ?? stringField(result, "message");
		if (directText) facts.push(directText);
		const details = "details" in result ? (result as { details?: unknown }).details : undefined;
		if (typeof details === "object" && details !== null) {
			const noticeLines: string[] = [];
			if ("notices" in details) {
				const notices = (details as { notices?: unknown }).notices;
				if (Array.isArray(notices)) {
					for (const notice of notices) if (typeof notice === "string") noticeLines.push(notice);
				}
			}
			const single = stringField(details, "notice");
			if (single) noticeLines.push(single);
			facts.push(...noticeLines);
			if ("meta" in details) {
				// Mirrors the mapper's own `salvageOutputMeta` read path: a
				// producer's `meta` isn't guaranteed well-formed (an extension/MCP
				// tool, a corrupted replay record), and formatting it unsalvaged
				// would either throw on a malformed sibling or restate a fact the
				// mapper itself would have dropped.
				const metaNotice = formatOutputNotice(salvageOutputMeta((details as { meta?: unknown }).meta));
				if (metaNotice) {
					// A spilled result can carry the same recovery pointer from two
					// independent subsystems — a legacy producer's own
					// `[raw output: artifact://N]` push (`details.notices`) and
					// `OutputSink`'s elision summary (`details.meta.truncation`) — in
					// different wording. A real producer never sets both for the
					// *same* spill, so requiring the meta wording verbatim on top of
					// the notices wording would demand two representations of one
					// fact; the mapper's own `extractTerminalNotices` already dedupes
					// on shared artifact ids, and this check only needs the underlying
					// fact (the artifact id) to survive once, not both phrasings.
					const coveredIds = new Set(artifactIds(noticeLines.join("\n")));
					const metaIds = artifactIds(metaNotice);
					const alreadyCovered = metaIds.length > 0 && metaIds.every(id => coveredIds.has(id));
					if (!alreadyCovered) facts.push(metaNotice);
				}
			}
		}
	}
	for (const event of presentationEvents ?? []) {
		if (event.type !== "fact") continue;
		const text = "text" in event.fact ? event.fact.text : undefined;
		if (typeof text === "string" && text.length > 0) facts.push(text);
	}
	return facts.flatMap(fact =>
		fact
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0),
	);
}

/** Every text channel the client can actually render for this frame. */
export function frameTexts(update: Record<string, unknown>): string[] {
	const texts: string[] = [];
	if ("_meta" in update) {
		const meta = (update as { _meta?: { terminal_output?: { data?: unknown } } })._meta;
		if (typeof meta?.terminal_output?.data === "string") texts.push(meta.terminal_output.data);
	}
	const content = update.content;
	if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item !== "object" || item === null) continue;
			if ("type" in item && item.type === "content" && "content" in item) {
				const block = (item as { content?: { type?: unknown; text?: unknown } }).content;
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
			}
			if ("type" in item && item.type === "diff") {
				const newText = (item as { newText?: unknown }).newText;
				texts.push(typeof newText === "string" ? newText : "");
			}
		}
	}
	return texts;
}

/**
 * The tool's own authoritative final body text — `content[].text` blocks
 * joined, the same text a plain-content fallback client would render
 * verbatim. This is deliberately NOT `producerFacts` (which only reads
 * structurally-declared fields like `details.notices`): a producer can
 * compose a synthesized note directly into this text (an executor's
 * `dump(notice)` annotation, `eval`'s synthesized `Command exited with code
 * N` suffix) without ever declaring it as a separate structural fact, so a
 * check confined to `producerFacts` is vacuous on exactly that class of bug —
 * a producer whose `details` simply has no `notices` field at all, so
 * nothing is "missing" from a check that only compares against what got
 * declared.
 */
export function producerFinalBodyText(result: AgentToolResult<unknown> | Record<string, unknown>): string {
	if (typeof result !== "object" || result === null) return "";
	const content = "content" in result ? (result as { content?: unknown }).content : undefined;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		if ("text" in item && typeof (item as { text?: unknown }).text === "string") {
			texts.push((item as { text: string }).text);
		}
	}
	return texts.join("\n");
}

/**
 * Every non-blank line of `finalBodyText` that appears nowhere in
 * `deliveredTexts` (every `_meta.terminal_output.data` chunk plus every
 * rendered `content` text, across the *whole* replayed frame sequence, not
 * just the last frame — a line legitimately delivered on an earlier
 * `tool_execution_update` and never repeated on the final frame is not
 * missing). The general form of the class this PR kept re-finding one
 * instance at a time: a fact synthesized straight into the model-facing text
 * (never declared structurally) that the terminal-rendering path — which
 * reads only structured facts — silently drops. Unlike `producerFacts`,
 * this needs no axis to be declared first: it reads the same authoritative
 * text a plain-content client would show, so an omission fails regardless of
 * which structural field (if any) the producer used to carry it.
 *
 * A short-line-prefix match (first 40 chars) additionally tolerates
 * legitimate per-line column truncation (`tools.maxColumn`) without
 * requiring the caller to enumerate every normalization a producer might
 * apply — the same "structural, not enumerated" approach mechanism 2 takes for
 * re-render classification.
 */
export function missingFinalBodyLines(finalBodyText: string, deliveredTexts: readonly string[]): string[] {
	const delivered = deliveredTexts.join("\n");
	// Exact-line lookup is O(1) amortized via the Set, so a long streamed body
	// (thousands of lines) stays linear; only the rare line with no exact match
	// (e.g. one a client-side column truncation shortened) pays the O(delivered
	// length) substring scan below, bounded by how many such lines exist.
	const deliveredLines = new Set(delivered.split("\n"));
	return finalBodyText
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.filter(line => {
			if (deliveredLines.has(line) || delivered.includes(line)) return false;
			const prefix = line.slice(0, 40);
			return prefix.length < 8 ? true : !delivered.includes(prefix);
		});
}
