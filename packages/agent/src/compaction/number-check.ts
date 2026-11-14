/**
 * Numeric faithfulness for generated summaries.
 *
 * A compaction summary or handoff document is all the agent keeps of the turns
 * it replaces, so a number in it that the summarizer never saw (a miscopy, or
 * the writer's own sum) becomes a fact the agent cannot check. The check
 * extracts every number the summary writes, compares it with the numbers in
 * the input the summarizer was sent, names the unseen ones back to the writer
 * once in the same request fork, and blanks any still unseen to `?`.
 *
 * Ported from nace-ai/intern (Apache-2.0), `context.py`.
 */
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import summaryNumberFixPrompt from "./prompts/summary-number-fix.md" with { type: "text" };

/** What one or more summary checks found: numbers the input never showed, and those still there after the fix. */
export interface NumberCheckReport {
	/** Numbers the summary wrote that appear nowhere in its input, as the summary wrote them. */
	unseenNumbers: string[];
	/** The subset still present after the writer's fix round, replaced by `?`. */
	blanked: string[];
}

/** A number as written: `1,234,567.8` or `1234.5`. A comma only groups thousands, so `538791,481979` is two numbers. */
const NUMBER_SOURCE = String.raw`\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?`;
const NUMBER = new RegExp(NUMBER_SOURCE, "g");
/** A list of numbers as written (`120, 126, 131`); packed into a summary it may read `120,126`. */
const NUMBER_LIST = /\d+(?:\.\d+)?(?:,\s+\d+(?:\.\d+)?)+/g;
/**
 * Structure, not values: a list item's own number at the start of a line (`2. report`) and a
 * heading's section number (`## 3. Next`, `### 1.2 Scope`). Without this a plan's `2.` would be
 * blanked to `?.` whenever no `2` stood alone in the input.
 */
const LIST_MARK = String.raw`^[ \t]*\d{1,3}[.)](?=[ \t])`;
const HEADING_MARK = String.raw`^[ \t]*#{1,6}[ \t]+\d{1,3}(?:\.\d{1,3})*[.)]?(?=[ \t])`;
const MARK_OR_NUMBER = new RegExp(`(?<mark>${HEADING_MARK}|${LIST_MARK})|${NUMBER_SOURCE}`, "gm");

const FIX_OLD = /^\s*OLD:[ \t]?(.*)$/;
const FIX_NEW = /^\s*NEW:[ \t]?(.*)$/;

/** `1,234.50` and `1234.5` are one number. */
function numberValue(number: string): string {
	let plain = number.replaceAll(",", "");
	if (plain.includes(".")) plain = plain.replace(/0+$/, "").replace(/\.$/, "");
	return plain.replace(/^0+/, "") || "0";
}

/** The numbers an input shows, and its lists of numbers, to tell whether a number in a summary was shown. */
export class SeenNumbers {
	readonly #values = new Set<string>();
	readonly #lists: Set<string>[] = [];

	add(text: string): void {
		for (const match of text.matchAll(NUMBER)) this.#values.add(numberValue(match[0]));
		for (const match of text.matchAll(NUMBER_LIST)) {
			this.#lists.push(new Set(match[0].split(",").map(item => numberValue(item.trim()))));
		}
	}

	has(number: string): boolean {
		if (this.#values.has(numberValue(number))) return true;
		if (!number.includes(",")) return false;
		// `120,126` is a list packed together when every item is in ONE list the input showed;
		// items scattered over the input do not count, or a made-up `125,135` would pass.
		const items = number.split(",").map(numberValue);
		return this.#lists.some(list => items.every(item => list.has(item)));
	}
}

/** Every number in `texts`. */
export function numbersSeenIn(texts: Iterable<string>): SeenNumbers {
	const seen = new SeenNumbers();
	for (const text of texts) seen.add(text);
	return seen;
}

function* messageTexts(message: Message): Generator<string> {
	if (typeof message.content === "string") {
		yield message.content;
		return;
	}
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				yield block.text;
				break;
			case "thinking":
				yield block.thinking;
				break;
			case "toolCall":
				yield JSON.stringify(block.arguments);
				break;
		}
	}
}

function* contextTexts(context: Context): Generator<string> {
	if (context.systemPrompt) yield* context.systemPrompt;
	for (const tool of context.tools ?? []) yield tool.description;
	for (const message of context.messages) yield* messageTexts(message);
}

/** Every number a provider request shows: system prompt, tool descriptions, text, reasoning, tool arguments and results. */
export function numbersSeenInContext(context: Context): SeenNumbers {
	return numbersSeenIn(contextTexts(context));
}

/** The numbers in `text` that `seen` lacks, as `text` writes them, sorted and unique; list and heading numbering aside. */
export function unseenNumbers(text: string, seen: SeenNumbers): string[] {
	const unseen = new Set<string>();
	for (const match of text.matchAll(MARK_OR_NUMBER)) {
		if (match.groups?.mark === undefined && !seen.has(match[0])) unseen.add(match[0]);
	}
	return [...unseen].sort();
}

/** `text` with every number `seen` lacks replaced by `?`; list and heading numbering stay. */
export function blankUnseenNumbers(text: string, seen: SeenNumbers): string {
	return text.replace(MARK_OR_NUMBER, (match, mark: string | undefined) =>
		mark !== undefined || seen.has(match) ? match : "?",
	);
}

/**
 * Apply the writer's `OLD:`/`NEW:` line fixes to `text`. A fix applies only when its OLD line
 * matches exactly one line of `text` (ignoring surrounding whitespace) and that line holds a
 * number `seen` lacks, so the fix round cannot rewrite anything else. An empty NEW drops the line.
 */
export function applyNumberFixes(text: string, reply: string, seen: SeenNumbers): string {
	const lines: (string | null)[] = text.split("\n");
	const replyLines = reply.split("\n");
	for (let i = 0; i < replyLines.length - 1; i++) {
		const oldMatch = FIX_OLD.exec(replyLines[i]);
		const newMatch = oldMatch ? FIX_NEW.exec(replyLines[i + 1]) : null;
		if (!oldMatch || !newMatch) continue;
		i++;
		const target = oldMatch[1].trim();
		if (!target) continue;
		const at = lines.flatMap((line, index) => (line?.trim() === target ? [index] : []));
		if (at.length !== 1) continue;
		const line = lines[at[0]] as string;
		if (unseenNumbers(line, seen).length === 0) continue;
		const replacement = newMatch[1].trim();
		lines[at[0]] = replacement ? (/^\s*/.exec(line)?.[0] ?? "") + replacement : null;
	}
	return lines.filter(line => line !== null).join("\n");
}

/**
 * Checks summaries and accumulates what it found across every summary of one
 * compaction (folded windows, split-turn prefix). Passing one to a summary
 * call enables the check.
 */
export class SummaryNumberCheck {
	readonly #unseen = new Set<string>();
	readonly #blanked = new Set<string>();

	/** What the checks found, or `undefined` when every number was seen. */
	get report(): NumberCheckReport | undefined {
		if (this.#unseen.size === 0) return undefined;
		return { unseenNumbers: [...this.#unseen].sort(), blanked: [...this.#blanked].sort() };
	}

	/**
	 * `summary` with numbers its input never showed fixed by one `requestFix` round, and those
	 * still unseen blanked. `requestFix` sends the fix prompt in the summary request's own fork
	 * and returns the reply text; a failed or empty reply skips straight to blanking.
	 */
	async verify(
		summary: string,
		seen: SeenNumbers,
		requestFix: (fixPrompt: string) => Promise<string | undefined>,
		signal?: AbortSignal,
	): Promise<string> {
		const flagged = unseenNumbers(summary, seen);
		if (flagged.length === 0) return summary;
		let text = summary;
		try {
			const reply = await requestFix(prompt.render(summaryNumberFixPrompt, { numbers: flagged.join(", ") }));
			if (reply) text = applyNumberFixes(text, reply, seen);
		} catch (error) {
			if (signal?.aborted) throw error;
			logger.warn("Summary number fix request failed; blanking unseen numbers", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		signal?.throwIfAborted();
		const left = unseenNumbers(text, seen);
		// A fix line may itself write a number the input never showed; it is unseen and blanked too.
		for (const number of [...flagged, ...left]) this.#unseen.add(number);
		for (const number of left) this.#blanked.add(number);
		return blankUnseenNumbers(text, seen);
	}
}
