/**
 * Per-install rewrite of prompt text and tool descriptions.
 *
 * Every install picks one committed paraphrase per sentence or clause (see
 * `promptFragments`), keyed by the persisted install id, so requests from different installs do not share the
 * same prose while each install stays byte-stable (system-prompt `systemKey`
 * and provider prompt caches never churn between turns). The pool is authored
 * offline by `scripts/gen-prompt-perturbation.ts`. Its manual entry for the
 * system-prompt opener has an empty variant, so perturbed requests carry no
 * persona line.
 *
 * Off by default. A model opts in through the `prompt-perturbation` KDL axis
 * (see `packages/catalog/src/compat/rules/`); `OMP_PROMPT_PERTURBATION=1`
 * forces it on for every model and `OMP_PROMPT_PERTURBATION=0` forces it off.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { getInstallId } from "@oh-my-pi/pi-utils";
import type { Context, Tool } from "../types";
// A file asset rather than a text import, so the ~1 MiB pool stays off the JS heap until a request is first perturbed.
import poolPath from "./perturbation-pool.json.txt" with { type: "file" };

interface PerturbationEntry {
	source: string;
	variants: readonly string[];
	/** Hand-authored entry; regeneration leaves it alone. */
	manual?: boolean;
}

interface PerturbationPool {
	version: number;
	entries: readonly PerturbationEntry[];
}

interface Perturbation {
	/** Manual entries: literal text replaced wherever it occurs (the opener, dividers). */
	literal: RegExp | null;
	literals: ReadonlyMap<string, string>;
	/** Generated entries: one sentence or clause, matched as a whole fragment. */
	fragments: ReadonlyMap<string, string>;
	/** Rewritten text by input: system prompts and tool descriptions repeat on every request. */
	memo: Map<string, string>;
}

/** Distinct texts memoized before the memo resets; a session renders a few dozen. */
const MEMO_LIMIT = 512;

let built = false;
let perturbation: Perturbation | null = null;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A sentence or clause of prompt prose, as a half-open `[start, end)` range of the text. */
export interface PromptFragment {
	start: number;
	end: number;
}

/** Indentation plus a heading, list, quote, or table marker: structure, never paraphrased. */
const LINE_PREFIX = /^[ \t]*(?:(?:#{1,6}|[-*+]|>|\d+[.)])[ \t]+)*\|?[ \t]*/;

/** Left out of every fragment: it stays in the text, and paraphrases never have to reproduce it. */
const TRAILING_PUNCTUATION = new Set([".", "!", "?", ";", ":", ","]);

function isSpace(char: string | undefined): boolean {
	return char === " " || char === "\t";
}

/**
 * Split prose into sentences and clauses. Boundaries are line breaks, sentence
 * ends (`.`/`!`/`?` before a non-lowercase word), `;`, a spaced em dash, and
 * table pipes; backtick spans and brackets are never split, fenced code is never returned.
 * Trailing punctuation (`.`, `!`, `?`, `;`, `:`, `,`) stays outside the fragment.
 * The generator and the runtime share this, so a pooled fragment matches
 * wherever the same sentence renders, whatever line, indentation, or template
 * surrounds it.
 */
export function promptFragments(text: string): PromptFragment[] {
	const fragments: PromptFragment[] = [];
	const push = (start: number, end: number): void => {
		while (start < end && isSpace(text[start])) start++;
		while (end > start && (isSpace(text[end - 1]) || TRAILING_PUNCTUATION.has(text[end - 1] ?? ""))) end--;
		if (end > start) fragments.push({ start, end });
	};
	let fenced = false;
	let lineStart = 0;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = text.length;
		const line = text.slice(lineStart, lineEnd);
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;
		} else if (!fenced) {
			let start = lineStart + (LINE_PREFIX.exec(line)?.[0].length ?? 0);
			let code = false;
			let depth = 0;
			for (let i = start; i < lineEnd; i++) {
				const char = text[i];
				if (char === "`") {
					code = !code;
					continue;
				}
				if (code) continue;
				if (char === "(" || char === "[") depth++;
				else if ((char === ")" || char === "]") && depth > 0) depth--;
				if (depth > 0) continue;
				let cut = -1;
				let resume = -1;
				if ((char === "." || char === "!" || char === "?" || char === ";") && isSpace(text[i + 1])) {
					let next = i + 1;
					while (next < lineEnd && isSpace(text[next])) next++;
					// `e.g. foo` and `1.5 s` continue the sentence; only a non-lowercase word starts the next one.
					const lead = text[next] ?? "";
					if (char === ";" || lead === lead.toUpperCase()) {
						cut = i + 1;
						resume = next;
					}
				} else if (char === "\u2014" && isSpace(text[i - 1]) && isSpace(text[i + 1])) {
					cut = i;
					resume = i + 1;
				} else if (char === "|") {
					cut = i;
					resume = i + 1;
				}
				if (cut === -1) continue;
				push(start, cut);
				start = resume;
				i = resume - 1;
			}
			push(start, lineEnd);
		}
		lineStart = lineEnd + 1;
	}
	return fragments;
}

function pickVariant(installId: string, entry: PerturbationEntry): string | undefined {
	const digest = createHash("sha256").update(`prompt-perturbation\u0000${installId}\u0000${entry.source}`).digest();
	return entry.variants[digest.readUInt32BE(0) % entry.variants.length];
}

/** Choose this install's variant of every pooled source. */
function buildPerturbation(): Perturbation | null {
	// Absolute in a source checkout or a compiled binary (`$bunfs`); relative to the bundle in the npm `dist/cli.js`.
	const poolFile =
		path.isAbsolute(poolPath) || path.win32.isAbsolute(poolPath) ? poolPath : new URL(poolPath, import.meta.url);
	const pool = JSON.parse(readFileSync(poolFile, "utf8")) as PerturbationPool;
	const installId = getInstallId();
	const literals = new Map<string, string>();
	const fragments = new Map<string, string>();
	for (const entry of pool.entries) {
		if (entry.source.length === 0 || entry.variants.length === 0) continue;
		const variant = pickVariant(installId, entry);
		if (variant === undefined) continue;
		(entry.manual ? literals : fragments).set(entry.source, variant);
	}
	if (literals.size === 0 && fragments.size === 0) return null;
	// Longest first so a literal that contains another literal is matched whole.
	const alternatives = [...literals.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
	const literal = alternatives.length > 0 ? new RegExp(alternatives.join("|"), "g") : null;
	return { literal, literals, fragments, memo: new Map() };
}

/** Rewrite every pooled source in `text` with this install's variant. */
export function perturbPromptText(text: string): string {
	if (text.length === 0) return text;
	if (!built) {
		perturbation = buildPerturbation();
		built = true;
	}
	if (perturbation === null) return text;
	const { memo } = perturbation;
	let rewritten = memo.get(text);
	if (rewritten === undefined) {
		rewritten = rewrite(perturbation, text);
		if (memo.size >= MEMO_LIMIT) memo.clear();
		memo.set(text, rewritten);
	}
	return rewritten;
}

function rewrite({ literal, literals, fragments }: Perturbation, text: string): string {
	if (literal) text = text.replace(literal, match => literals.get(match) ?? match);
	let out = "";
	let cursor = 0;
	for (const { start, end } of promptFragments(text)) {
		const variant = fragments.get(text.slice(start, end));
		if (variant === undefined) continue;
		out += text.slice(cursor, start) + variant;
		cursor = end;
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}

function perturbTools(tools: Tool[] | undefined): Tool[] | undefined {
	if (tools === undefined) return undefined;
	let changed = false;
	const next = tools.map(tool => {
		const description = perturbPromptText(tool.description);
		if (description === tool.description) return tool;
		changed = true;
		return { ...tool, description };
	});
	return changed ? next : tools;
}

/** Whether requests to `model` are perturbed: `OMP_PROMPT_PERTURBATION` (`0`/`1`) wins over the KDL axis. */
export function isPromptPerturbationEnabled(model: Model): boolean {
	const env = process.env.OMP_PROMPT_PERTURBATION;
	if (env === "0") return false;
	if (env === "1") return true;
	return resolveCatalogPolicy(model).promptPerturbation === true;
}

/**
 * Rewrite the model-visible prose of a request to `model` when perturbation is
 * enabled for it: system-prompt blocks and every tool description, including
 * tools Anthropic may activate later.
 */
export function perturbContext(model: Model, context: Context): Context {
	if (!isPromptPerturbationEnabled(model)) return context;
	const systemPrompt = context.systemPrompt?.map(perturbPromptText);
	const tools = perturbTools(context.tools);
	const inactiveTools = perturbTools(context.inactiveTools);
	if (systemPrompt === context.systemPrompt && tools === context.tools && inactiveTools === context.inactiveTools) {
		return context;
	}
	return {
		...context,
		...(systemPrompt !== context.systemPrompt && { systemPrompt }),
		...(tools !== context.tools && { tools }),
		...(inactiveTools !== context.inactiveTools && { inactiveTools }),
	};
}

/** Drop the memoized choices; tests and long-lived processes that adopt a new install id call this. */
export function resetPromptPerturbation(): void {
	built = false;
	perturbation = null;
}
