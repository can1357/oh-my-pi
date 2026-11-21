/**
 * A judge-sized cut of the live session, built by code with no model call.
 *
 * The goal is the user's last {@link GOAL_PROMPTS} requests. The history holds
 * the user's messages, the harness's (nudges, reminders, summaries), the
 * assistant's replies without their reasoning, and each tool call with its
 * input and a short result note in place of the output: status, size, a test or
 * lint tally when one is detectable, and the output's first
 * {@link RESULT_HEAD_CHARS} characters. Ported from nace-ai/intern's
 * `session_cut.py` (Apache-2.0), where the notes raised System 1's answers to
 * session question probes from 84% to 95%.
 *
 * The cut is fitted to a token budget in stages, each tried only when the one
 * before is not enough: tool inputs cut to 1,000, 200, then 60 characters; long
 * texts abridged to head and tail, oldest first; old texts collapsed to an
 * omission note; old calls shortened to one line; then the oldest entries left
 * out behind one note. The first message and the newest {@link PINNED_ENTRIES}
 * are never collapsed, shortened, or left out.
 */
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertToLlm, isUserAuthoredMessage, textFromContent } from "./messages";

/** Newest history entries kept whole: about the last three turns the stuck judge compares. */
export const PINNED_ENTRIES = 6;
const GOAL_PROMPTS = 3;
const GOAL_CHARS = 500;
const INPUT_CHARS = [1000, 200, 60] as const;
const RESULT_HEAD_CHARS = 300;
const TALLY_CHARS = 120;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

/** A command that runs tests, a linter, or a type checker, whose output may end in a tally. */
const CHECK_COMMAND =
	/(?:^|[\s;&|()'"])(?:bun\s+(?:run\s+)?(?:test|check|lint)|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|pytest|jest|vitest|mocha|cargo\s+(?:test|nextest|clippy|check)|go\s+test|tsc|eslint|oxlint|biome|ruff|mypy|pyright|basedpyright)(?:\s|$)/;
/** Summary lines of common test runners, linters, and type checkers. */
const TALLY_LINE =
	/^(?:(?:=+ )?(?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?),? ?)+in [\d.]+s.*|\d+ (?:pass|fail)|Ran \d+ tests? across .*|Tests?:\s+.*\d+ (?:passed|failed|total).*|Tests\s+\d+ (?:passed|failed).*|test result: .*|Found \d+ (?:errors?|warnings?).*|\S \d+ problems? \(.*\)|All checks passed!|Success: no issues found.*|\d+ errors?, \d+ warnings?.*)$/;

/** One tool call as the cut shows it: input cut to fit and a note in place of the output. */
export type SessionCutCall = { id: string; tool: string; input: string; result: string };

/** One user, harness, or assistant message; `tool_calls` entries become one-line strings when shortened. */
export type SessionCutEntry = {
	i: number;
	role: "user" | "harness" | "assistant";
	text: string;
	tool_calls?: (SessionCutCall | string)[];
};

/** Where the oldest entries were left out to fit the budget. */
export type SessionCutOmission = { left_out: number };

/** The judge state: the user's latest requests and the fitted history, oldest first. */
export type SessionCut = { goal: string; history: (SessionCutEntry | SessionCutOmission)[] };

interface CutCall {
	id: string;
	tool: string;
	args: Record<string, unknown>;
	error: boolean;
	chars: number;
	outcome: string | undefined;
}

interface CutMessage {
	role: SessionCutEntry["role"];
	text: string;
	calls: CutCall[];
}

let tokenizer: Tokenizer | undefined;

function countTokens(text: string): number {
	tokenizer ??= new Tokenizer();
	return tokenizer.countTokens(text);
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string): string {
	if (text.length <= TEXT_HEAD + TEXT_TAIL + 40) return text;
	return `${text.slice(0, TEXT_HEAD)}\n[… ${text.length - TEXT_HEAD - TEXT_TAIL} chars omitted …]\n${text.slice(-TEXT_TAIL)}`;
}

/** A check's tally (tests, a linter, a type checker); undefined for anything that is not a check. */
export function checkTally(command: string | undefined, output: string): string | undefined {
	if (!command || !CHECK_COMMAND.test(command)) return undefined;
	const found: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim().replace(/^=+\s*|\s*=+$/g, "");
		if (TALLY_LINE.test(line)) found.push(line);
	}
	// Runners such as `bun test` split one tally over lines (`3 pass`, `1 fail`, `Ran 4 tests …`).
	return found.length > 0 ? truncate(found.slice(-3).join("; "), TALLY_CHARS) : undefined;
}

function outcomeOf(call: { name: string; arguments: Record<string, unknown> }, output: string): string | undefined {
	const command =
		call.name === "bash" && typeof call.arguments.command === "string" ? call.arguments.command : undefined;
	const parts: string[] = [];
	const tally = checkTally(command, output);
	if (tally) parts.push(tally);
	const folded = output.split(/\s+/).filter(Boolean).join(" ");
	if (folded) parts.push(`starts ${JSON.stringify(truncate(folded, RESULT_HEAD_CHARS))}`);
	return parts.length > 0 ? parts.join("; ") : undefined;
}

function callNote(call: CutCall): string {
	const note = `${call.error ? "error" : "ok"}, ${call.chars} chars (omitted)`;
	return call.outcome ? `${note}: ${call.outcome}` : note;
}

function callLine(call: CutCall): string {
	const args = Object.entries(call.args)
		.map(([key, value]) => {
			const shown = typeof value === "string" ? value : (JSON.stringify(value) ?? "").slice(0, 200);
			return `${key}=${shown.split(/\s+/).filter(Boolean).join(" ")}`;
		})
		.join(" ");
	const line = `${call.id} ${call.tool} ${truncate(args, INPUT_CHARS[2])} → ${call.error ? "error" : "ok"} ${call.chars}ch`;
	return call.outcome ? `${line}: ${call.outcome}` : line;
}

/** Text of a non-assistant message as the model reads it, through the session's own LLM conversion. */
function llmText(message: AgentMessage): string {
	return convertToLlm([message])
		.filter(converted => converted.role === "user" || converted.role === "developer")
		.map(converted => textFromContent(converted.content))
		.filter(Boolean)
		.join("\n\n");
}

function isOperatorMessage(message: AgentMessage): boolean {
	if (message.role === "user") return !message.synthetic && message.attribution !== "agent";
	return message.role === "custom" && isUserAuthoredMessage(message);
}

function sessionMessages(messages: readonly AgentMessage[]): CutMessage[] {
	// Queued per call id, so calls that share an id each take their own result in order.
	const results = new Map<string, ToolResultMessage[]>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const queue = results.get(message.toolCallId);
		if (queue) queue.push(message);
		else results.set(message.toolCallId, [message]);
	}
	const out: CutMessage[] = [];
	let count = 0;
	for (const message of messages) {
		if (message.role === "toolResult") continue;
		if (message.role === "assistant") {
			const calls: CutCall[] = [];
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const result = results.get(block.id)?.shift();
				// No result yet: nothing to say of it.
				if (!result) continue;
				const output = result.content.map(part => (part.type === "text" ? part.text : "[image]")).join("\n");
				calls.push({
					id: `t${++count}`,
					tool: block.name,
					args: block.arguments,
					error: result.isError,
					chars: output.length,
					outcome: outcomeOf(block, output),
				});
			}
			out.push({ role: "assistant", text: textFromContent(message.content), calls });
			continue;
		}
		const operator = isOperatorMessage(message);
		const text = operator && message.role === "user" ? textFromContent(message.content) : llmText(message);
		out.push({ role: operator ? "user" : "harness", text, calls: [] });
	}
	return out;
}

/** Fits the history to a token budget, tracking each entry's tokens. */
class Fit {
	readonly per: number[];

	constructor(
		readonly base: number,
		readonly history: SessionCutEntry[],
		readonly limit: number,
	) {
		this.per = history.map(entryTokens);
	}

	get tokens(): number {
		let total = this.base;
		for (const tokens of this.per) total += tokens;
		return total;
	}

	fits(): boolean {
		return this.tokens <= this.limit;
	}

	shrink(index: number, change: (entry: SessionCutEntry) => void): void {
		change(this.history[index]!);
		this.per[index] = entryTokens(this.history[index]!);
	}
}

function entryTokens(entry: SessionCutEntry | SessionCutOmission): number {
	return countTokens(JSON.stringify(entry)) + 1;
}

/**
 * The session as the stuck judge's state, within `maxTokens`. The first
 * message and the newest {@link PINNED_ENTRIES} history entries are never
 * collapsed, shortened, or left out; their texts are abridged only after every
 * older text was.
 */
export function buildSessionCut(messages: readonly AgentMessage[], maxTokens: number): SessionCut {
	const session = sessionMessages(messages);
	const requests = session.filter(message => message.role === "user" && message.text.trim()).map(m => m.text);
	const goal = requests
		.slice(-GOAL_PROMPTS)
		.map(text => truncate(text, GOAL_CHARS))
		.join("\n");

	const entriesOf = (inputChars: number): SessionCutEntry[] => {
		const history: SessionCutEntry[] = [];
		for (const [i, message] of session.entries()) {
			if (!message.text.trim() && message.calls.length === 0) continue;
			const entry: SessionCutEntry = { i, role: message.role, text: message.text };
			if (message.calls.length > 0) {
				entry.tool_calls = message.calls.map(call => ({
					id: call.id,
					tool: call.tool,
					input: truncate(JSON.stringify(call.args) ?? "", inputChars),
					result: callNote(call),
				}));
			}
			history.push(entry);
		}
		return history;
	};

	const base = countTokens(JSON.stringify({ goal, history: [] }));
	let fit = new Fit(base, [], maxTokens);
	for (const inputChars of INPUT_CHARS) {
		fit = new Fit(base, entriesOf(inputChars), maxTokens);
		if (fit.fits()) return { goal, history: fit.history };
	}

	const history = fit.history;
	const firstPinned = Math.max(0, history.length - PINNED_ENTRIES);
	const pinned = (k: number): boolean => k === 0 || k >= firstPinned;
	const order = [...history.keys()].sort((a, b) => Number(pinned(a)) - Number(pinned(b)) || a - b);

	for (const k of order) {
		if (history[k]!.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
		fit.shrink(k, entry => {
			entry.text = abridge(entry.text);
		});
		if (fit.fits()) return { goal, history };
	}
	for (const k of order) {
		if (pinned(k) || !history[k]!.text) continue;
		const chars = session[history[k]!.i]!.text.length;
		fit.shrink(k, entry => {
			entry.text = `[… ${chars} chars omitted …]`;
		});
		if (fit.fits()) return { goal, history };
	}
	for (const k of order) {
		const calls = session[history[k]!.i]!.calls;
		if (pinned(k) || calls.length === 0) continue;
		fit.shrink(k, entry => {
			entry.tool_calls = calls.map(callLine);
		});
		if (fit.fits()) return { goal, history };
	}

	// Past the last shrinking stage: the oldest unpinned entries are left out, a note in their place.
	let tokens = fit.tokens + entryTokens({ left_out: history.length });
	const kept: (SessionCutEntry | SessionCutOmission)[] = [];
	let gone = 0;
	for (const [k, entry] of history.entries()) {
		if (!pinned(k) && tokens > maxTokens) {
			tokens -= fit.per[k]!;
			gone++;
			continue;
		}
		if (gone > 0 && kept.length === 1) kept.push({ left_out: gone });
		kept.push(entry);
	}
	return { goal, history: kept };
}
