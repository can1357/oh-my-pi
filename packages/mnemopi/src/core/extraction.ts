import type { MemoryFactKind } from "./beam/types";
import { hasRetainableContent } from "./content-noise";
import memoryExtractionPrompt from "./memory-extraction.md" with { type: "text" };
import experienceExtractionPrompt from "./memory-experience-extraction.md" with { type: "text" };
import { getDiagnostics, safeForLog } from "./extraction/diagnostics";
import { callHostLlm, getHostLlmBackend } from "./llm-backends";
import {
	callConfiguredCompletion,
	callLocalLlm,
	callRemoteLlm,
	cleanOutput,
	configuredLlmWillHandleCall,
	llmAvailable,
	type RemoteLlmOptions,
} from "./local-llm";
import { getMnemopiRuntimeOptions } from "./runtime-options";

const TRUE_VALUES: Record<string, true> = { "1": true, true: true, yes: true, on: true };

function env(name: string): string {
	return process.env[name] ?? "";
}

function envBool(name: string, defaultValue: boolean): boolean {
	const value = env(name).trim().toLowerCase();
	return value === "" ? defaultValue : TRUE_VALUES[value] === true;
}

function envInt(name: string, defaultValue: number): number {
	const parsed = Number.parseInt(env(name), 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function llmEnabled(): boolean {
	return envBool("MNEMOPI_LLM_ENABLED", true);
}

function hostLlmEnabled(): boolean {
	return envBool("MNEMOPI_HOST_LLM_ENABLED", false);
}

function llmMaxTokens(): number {
	return envInt("MNEMOPI_LLM_MAX_TOKENS", 2048);
}

export const EXTRACTION_PROMPT_TEMPLATE = env("MNEMOPI_EXTRACTION_PROMPT") || memoryExtractionPrompt;

export interface FactExtractionOptions extends RemoteLlmOptions {
	/** Assistant content is accepted only as explicitly typed experience facts. */
	sourceKind?: "experience";
}

export function buildExtractionPrompt(text: string, detectedLang = "en", sourceKind?: "experience"): string {
	const template = sourceKind === "experience"
		? experienceExtractionPrompt
		: (getMnemopiRuntimeOptions()?.llm?.extractionPrompt ?? EXTRACTION_PROMPT_TEMPLATE);
	return template.split("{text}").join(text).split("{lang}").join(detectedLang);
}
function stripFence(raw: string): string {
	let s = raw.trim();
	if (!s.startsWith("```")) {
		return s;
	}
	s = s.replace(/^```(?:json)?\s*/i, "");
	s = s.replace(/\s*```$/i, "");
	return s.trim();
}

const FLAT_FACT_LIMIT = 5;
const STRUCTURED_CATEGORY_LIMIT = 5;
const STRING_CATEGORY_KEYS = ["facts", "instructions", "preferences", "timelines"] as const;
const FACT_TEXT_FIELD_KEYS = ["fact", "text", "content", "value", "statement"] as const;
const INSTRUCTION_TEXT_FIELD_KEYS = ["instruction", "rule", ...FACT_TEXT_FIELD_KEYS] as const;
const PREFERENCE_TEXT_FIELD_KEYS = ["preference", ...FACT_TEXT_FIELD_KEYS] as const;
const TIMELINE_TEXT_FIELD_KEYS = ["description", "event", "timeline", "date", ...FACT_TEXT_FIELD_KEYS] as const;

/** Parsed knowledge-graph edge emitted by the extractor LLM. */
export interface ExtractedKgTriple {
	subject: string;
	predicate: string;
	object: string;
}

/** Preserve each item's semantic provenance even when normalized texts coincide. */
export interface ExtractedMemoryFact {
	text: string;
	kind: MemoryFactKind;
}

/** Category-preserving extraction result used by background memory routing. */
export interface ExtractedFactCategories {
	facts: ExtractedMemoryFact[];
	instructions: ExtractedMemoryFact[];
	preferences: ExtractedMemoryFact[];
	timelines: ExtractedMemoryFact[];
	kg: ExtractedKgTriple[];
}

function emptyFactCategories(): ExtractedFactCategories {
	return { facts: [], instructions: [], preferences: [], timelines: [], kg: [] };
}

function normalizeFact(fact: string): string {
	const trimmed = fact.trim();
	// Remove trailing sentence punctuation (. ! ?) if present
	return trimmed.replace(/[.!?]+$/, "");
}

interface FactArrayOptions {
	fields: readonly string[];
	joinFields?: boolean;
}

function normalizeFactArray(items: unknown, options: FactArrayOptions): ExtractedMemoryFact[] {
	if (!Array.isArray(items)) {
		return [];
	}
	const out: ExtractedMemoryFact[] = [];
	for (const item of items) {
		let text: string | null = null;
		if (typeof item === "string") {
			text = item.trim();
		} else if (isRecord(item)) {
			const parts: string[] = [];
			for (const key of options.fields) {
				const candidate = item[key];
				if (typeof candidate === "string") {
					const trimmed = candidate.trim();
					if (trimmed !== "") {
						parts.push(trimmed);
						if (options.joinFields !== true) break;
					}
				}
			}
			text = parts.length > 0 ? parts.join(" ") : null;
		}
		if (text !== null && text !== "") {
			const normalized = normalizeFact(text);
			if (normalized !== "" && hasRetainableContent(normalized)) {
				out.push({ text: normalized, kind: isRecord(item) && item.kind === "experience" ? "experience" : "world" });
				if (out.length >= STRUCTURED_CATEGORY_LIMIT) break;
			}
		}
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function triplePart(value: unknown): string {
	return typeof value === "string" ? normalizeFact(value) : "";
}

function normalizeKgTriple(item: unknown): ExtractedKgTriple | null {
	let subject = "";
	let predicate = "";
	let object = "";
	if (isRecord(item)) {
		subject = triplePart(item.subject);
		predicate = triplePart(item.predicate);
		object = triplePart(item.object);
	} else if (Array.isArray(item)) {
		subject = triplePart(item[0]);
		predicate = triplePart(item[1]);
		object = triplePart(item[2]);
	}
	return subject !== "" && predicate !== "" && object !== "" ? { subject, predicate, object } : null;
}

function normalizeKgArray(items: unknown): ExtractedKgTriple[] {
	if (!Array.isArray(items)) {
		return [];
	}
	const out: ExtractedKgTriple[] = [];
	for (const item of items) {
		const triple = normalizeKgTriple(item);
		if (triple !== null) {
			out.push(triple);
			if (out.length >= STRUCTURED_CATEGORY_LIMIT) break;
		}
	}
	return out;
}

/** Flatten typed categories for flat-text fact callers. */
export function flattenExtractedFactCategories(extracted: ExtractedFactCategories): string[] {
	const out: string[] = [];
	for (const category of STRING_CATEGORY_KEYS) {
		for (const item of extracted[category]) {
			out.push(item.text);
		}
	}
	return out;
}

/** Count typed facts plus KG triples in a category-preserving extraction result. */
export function countExtractedFactCategories(extracted: ExtractedFactCategories): number {
	return (
		extracted.facts.length +
		extracted.instructions.length +
		extracted.preferences.length +
		extracted.timelines.length +
		extracted.kg.length
	);
}

/** Recover only complete category values from a JSON response truncated mid-item. */
function recoverCompleteJsonPrefix(raw: string): string | null {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	let completeEnd = 0;
	let closers = "";
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
				if (stack.length === 2 && stack[1] === "[") {
					completeEnd = index + 1;
					closers = "]}";
				}
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{" || char === "[") {
			stack.push(char);
		} else if (char === "}" || char === "]") {
			if (stack.pop() !== (char === "}" ? "{" : "[")) return null;
			if ((stack.length === 2 && stack[1] === "[") || stack.length === 1) {
				completeEnd = index + 1;
				closers = stack.length === 2 ? "]}" : "}";
			}
		}
	}
	if (completeEnd === 0) return null;
	return raw.slice(0, completeEnd) + closers;
}

/** Parse extractor output without discarding MEMORIA categories or KG triples. */
export function parseExtractedFactCategories(rawOutput: string | null | undefined): ExtractedFactCategories {
	if (rawOutput === null || rawOutput === undefined) {
		return emptyFactCategories();
	}
	const raw = rawOutput.trim();
	if (raw === "" || raw.toUpperCase() === "NO_FACTS") {
		return emptyFactCategories();
	}
	const rawClean = stripFence(raw);
	if (rawClean.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(rawClean);
			if (isRecord(parsed)) {
				return {
					facts: normalizeFactArray(parsed.facts, { fields: FACT_TEXT_FIELD_KEYS }),
					instructions: normalizeFactArray(parsed.instructions, { fields: INSTRUCTION_TEXT_FIELD_KEYS }),
					preferences: normalizeFactArray(parsed.preferences, { fields: PREFERENCE_TEXT_FIELD_KEYS }),
					timelines: normalizeFactArray(parsed.timelines, {
						fields: TIMELINE_TEXT_FIELD_KEYS,
						joinFields: true,
					}),
					kg: normalizeKgArray(parsed.kg),
				};
			}
		} catch {
			const completePrefix = recoverCompleteJsonPrefix(rawClean);
			if (completePrefix !== null) {
				try {
					JSON.parse(completePrefix);
					return parseExtractedFactCategories(completePrefix);
				} catch {
					// Invalid syntax is not truncated structured data; never quote-scrape it.
				}
			}
			return emptyFactCategories();
		}
	}
	const cleaned: ExtractedMemoryFact[] = [];
	for (const line of raw.split("\n")) {
		const numbered = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
		const fact = (numbered?.[1] ?? line).trim();
		if (/^(?:(?:there (?:are|is) )?no (?:durable |persistent |meaningful )?(?:facts|memories)(?: (?:found|to (?:extract|remember)))?|nothing to (?:extract|remember)|no_facts)[.!?]*$/i.test(fact)) continue;
		const declarativeText = fact.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/ı/g, "i");
		// Accept explicit list items or declarative legacy facts, never arbitrary long prose.
		const declarative =
			/\b(?:is|are|was|were|has|have|uses?|prefers?|dislikes?|loves?|hates?|works? at|lives? in|runs?|fixed|implemented)\b/i.test(fact) ||
			/\b(?:tercih (?:ediyor|eder|etti)|kullaniyor|kullanir|calisiyor|calisir|yasiyor|yasar|oturur|oturuyor|seviyor|sever|duzeltti|tamamladi|vardir|sahiptir|oldu|olacak)\b/i.test(declarativeText) ||
			/\b(?:toplanti|surum|yayin|son tarih|teslim|bulusma)\b.*(?:\b(?:yarin|bugun|saat)\b|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2})|\b[a-z]+(?:dir|dur|tir|tur)\b/i.test(declarativeText);
		if ((numbered || declarative) && hasRetainableContent(fact) && !/^(?:user|assistant|system):/i.test(fact)) {
			const normalized = normalizeFact(fact);
			if (normalized !== "") cleaned.push({ text: normalized, kind: "world" });
		}
		if (cleaned.length >= FLAT_FACT_LIMIT) break;
	}
	return { ...emptyFactCategories(), facts: cleaned };
}

/** Parse extractor output into the legacy flat string fact list. */
export function parseFacts(rawOutput: string | null | undefined): string[] {
	return flattenExtractedFactCategories(parseExtractedFactCategories(rawOutput)).slice(0, FLAT_FACT_LIMIT);
}
function sentenceCase(value: string): string {
	const trimmed = value.trim().replace(/[.!?]+$/, "");
	return trimmed === "" ? "" : `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}`;
}

function addUnique(out: string[], value: string): void {
	const fact = sentenceCase(value);
	if (fact.length > 10 && !out.includes(fact)) {
		out.push(fact);
	}
}

export function heuristicExtractFacts(text: string): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized === "" || !hasRetainableContent(normalized)) {
		return [];
	}
	const facts: string[] = [];
	const clauses = normalized.split(/(?:[.!?;]+|\s+and\s+|\s+but\s+)/i);
	for (const clause of clauses) {
		const c = clause.trim();
		let value = /\bmy name is\s+([^,.!?;]+)/i.exec(c)?.[1];
		if (value !== undefined) addUnique(facts, `The user's name is ${value}`);
		value = /\bi (?:am|work as)\s+(?:an?\s+)?([^,.!?;]+)/i.exec(c)?.[1];
		if (value !== undefined) addUnique(facts, `The user is ${value}`);
		value = /\bi work (?:at|for)\s+([^,.!?;]+)/i.exec(c)?.[1];
		if (value !== undefined) addUnique(facts, `The user works at ${value}`);
		value = /\bi (?:live in|am based in)\s+([^,.!?;]+)/i.exec(c)?.[1];
		if (value !== undefined) addUnique(facts, `The user lives in ${value}`);
		value = /\bi (?:use|uses|am using)\s+([^,.!?;]+)/i.exec(c)?.[1];
		if (value !== undefined) addUnique(facts, `The user uses ${value}`);
		value = /\bi (?:like|love|prefer|enjoy)\s+([^,.!?;]+)/i.exec(c)?.[1];
		if (value !== undefined) addUnique(facts, `The user prefers ${value}`);
		value = /\bi (?:hate|dislike|do not like|don't like)\s+([^,.!?;]+)/i.exec(c)?.[1];
		if (value !== undefined) addUnique(facts, `The user dislikes ${value}`);
		// Require an explicit `i` or `you` subject before `always|never`. The
		// other heuristics in this block all need an `i` subject (`i live in …`,
		// `i use …`) which keeps them from matching narrative prose; the
		// `Instruction:` pattern used to match any `always|never` token, so
		// assistant prose like "the panel never populates" became stored as a
		// user `Instruction:` memory (coding-agent issue #3372). Subject
		// constraint mirrors how the rest of the heuristics filter for first- /
		// second-person assertions and keeps narrative third-person prose out.
		const instruction = /\b(?:i|you)\s+(always|never)\s+([^,.!?;]+)/i.exec(c);
		if (instruction?.[1] !== undefined && instruction[2] !== undefined) {
			addUnique(facts, `Instruction: ${instruction[1].toLowerCase()} ${instruction[2]}`);
		}
	}
	return facts.slice(0, 5);
}

async function tryHostExtraction(prompt: string): Promise<[boolean, string | null]> {
	if (!llmEnabled() || !hostLlmEnabled() || getHostLlmBackend() === null) {
		return [false, null];
	}
	const raw = await callHostLlm(prompt, {
		maxTokens: llmMaxTokens(),
		temperature: 0,
		timeout: 15,
		provider: env("MNEMOPI_HOST_LLM_PROVIDER").trim() || null,
		model: env("MNEMOPI_HOST_LLM_MODEL").trim() || null,
	});
	const text = typeof raw === "string" ? raw.trim() : "";
	return [true, text === "" ? null : text];
}

async function localFallback(
	prompt: string,
	sourceText: string,
	diag = getDiagnostics(),
	sourceKind?: "experience",
): Promise<ExtractedFactCategories> {
	diag.recordAttempt("local");
	try {
		const raw = await callLocalLlm(prompt);
		if (raw !== null) {
			const extracted = parseExtractedFactCategories(cleanOutput(raw));
			const count = countExtractedFactCategories(extracted);
			if (count > 0) {
				diag.recordSuccess("local", count);
				diag.recordCall({ succeeded: true });
				return extracted;
			}
			diag.recordNoOutput("local");
		}
	} catch (exc) {
		diag.recordFailure("local", exc, "local_llm_raised");
		diag.recordCall({ succeeded: false });
		return emptyFactCategories();
	}
	diag.recordFailure("local", undefined, "model_not_loaded");
	const heuristic = sourceKind === "experience" ? [] : heuristicExtractFacts(sourceText);
	if (heuristic.length > 0) {
		diag.recordSuccess("local", heuristic.length);
		diag.recordCall({ succeeded: true });
		return { ...emptyFactCategories(), facts: heuristic.map<ExtractedMemoryFact>(text => ({ text, kind: "world" })) };
	}
	diag.recordCall({ succeeded: false, allEmpty: true });
	return emptyFactCategories();
}

/** Extract fact categories from text using configured, host, local, or remote LLMs. */
async function runFactExtraction(
	text: string | null | undefined,
	options: FactExtractionOptions = {},
): Promise<ExtractedFactCategories> {
	const diag = getDiagnostics();
	if (typeof text !== "string" || text.trim() === "" || !hasRetainableContent(text)) {
		return emptyFactCategories();
	}
	const prompt = buildExtractionPrompt(text, "en", options.sourceKind);

	// Configured completion (host-injected runtime LLM, e.g. the coding-agent's smol
	// or a local on-device model). Mirrors consolidation's precedence: when a
	// complete() fn is wired, it is the chosen path. Extraction is deterministic
	// (temperature 0) so re-ingesting the same content does not create near-dupes.
	if (configuredLlmWillHandleCall()) {
		diag.recordAttempt("host");
		try {
			const raw = await callConfiguredCompletion(prompt, 0, {
				maxTokens: llmMaxTokens(),
				task: {
					kind: "memory-extraction",
					input: text,
					...(options.sourceKind === "experience" ? { sourceKind: "experience" as const } : {}),
				},
			});
			if (typeof raw === "string" && raw.trim() !== "") {
				const extracted = parseExtractedFactCategories(raw);
				const count = countExtractedFactCategories(extracted);
				if (count > 0) {
					diag.recordSuccess("host", count);
					diag.recordCall({ succeeded: true });
					return extracted;
				}
			}
			diag.recordNoOutput("host");
		} catch (exc) {
			diag.recordFailure("host", exc, "configured_completion_raised");
			diag.recordCall({ succeeded: false });
			console.warn(`extractFacts: configured completion raised: ${safeForLog(exc)}`);
			return emptyFactCategories();
		}
		return localFallback(prompt, text, diag, options.sourceKind);
	}

	try {
		const [attempted, hostText] = await tryHostExtraction(prompt);
		if (attempted) {
			diag.recordAttempt("host");
			if (hostText !== null) {
				const extracted = parseExtractedFactCategories(hostText);
				const count = countExtractedFactCategories(extracted);
				if (count > 0) {
					diag.recordSuccess("host", count);
					diag.recordCall({ succeeded: true });
					return extracted;
				}
			}
			diag.recordNoOutput("host");
			return localFallback(prompt, text, diag, options.sourceKind);
		}
	} catch (exc) {
		diag.recordAttempt("host");
		diag.recordFailure("host", exc, "host_adapter_raised");
		diag.recordCall({ succeeded: false });
		console.warn(`extractFacts: host LLM adapter raised: ${safeForLog(exc)}`);
		return emptyFactCategories();
	}

	if (!llmAvailable()) {
		diag.recordAttempt("local");
		const heuristic = options.sourceKind === "experience" ? [] : heuristicExtractFacts(text);
		if (heuristic.length > 0) {
			diag.recordSuccess("local", heuristic.length);
			diag.recordCall({ succeeded: true });
			return { ...emptyFactCategories(), facts: heuristic.map<ExtractedMemoryFact>(text => ({ text, kind: "world" })) };
		}
		diag.recordFailure("local", undefined, "llm_unavailable_at_call_site");
		diag.recordCall({ succeeded: false });
		return emptyFactCategories();
	}

	diag.recordAttempt("remote");
	try {
		const raw = await callRemoteLlm(prompt, 0, options);
		if (raw !== null) {
			const extracted = parseExtractedFactCategories(cleanOutput(raw));
			const count = countExtractedFactCategories(extracted);
			if (count > 0) {
				diag.recordSuccess("remote", count);
				diag.recordCall({ succeeded: true });
				return extracted;
			}
		}
		diag.recordNoOutput("remote");
	} catch (exc) {
		diag.recordFailure("remote", exc, "remote_call_raised");
		console.warn(`extractFacts: remote LLM raised: ${safeForLog(exc)}`);
	}

	return localFallback(prompt, text, diag, options.sourceKind);
}

/** Keep assistant-source extraction isolated from user facts and heuristics. */
export async function extractFactCategories(
	text: string | null | undefined,
	options: FactExtractionOptions = {},
): Promise<ExtractedFactCategories> {
	const extracted = await runFactExtraction(text, options);
	if (options.sourceKind !== "experience") return extracted;
	return {
		facts: extracted.facts.filter(fact => fact.kind === "experience"),
		timelines: extracted.timelines.filter(fact => fact.kind === "experience"),
		instructions: [],
		preferences: [],
		kg: [],
	};
}

/** Extract legacy flat fact strings from text. */
export async function extractFacts(text: string | null | undefined, options: RemoteLlmOptions = {}): Promise<string[]> {
	const extracted = await extractFactCategories(text, options);
	return flattenExtractedFactCategories(extracted).slice(0, FLAT_FACT_LIMIT);
}

/** Safely extract category-preserving facts, swallowing best-effort failures. */
export async function extractFactCategoriesSafe(
	text: string | null | undefined,
	options: FactExtractionOptions = {},
): Promise<ExtractedFactCategories> {
	try {
		return await extractFactCategories(text, options);
	} catch (exc) {
		const diag = getDiagnostics();
		diag.recordFailure("wrapper", exc, "outer_wrapper_caught");
		diag.recordCall({ succeeded: false });
		console.warn(`extractFactsSafe: extractFacts() raised: ${safeForLog(exc)}`);
		return emptyFactCategories();
	}
}

/** Safely extract legacy flat fact strings, swallowing best-effort failures. */
export async function extractFactsSafe(text: string | null | undefined): Promise<string[]> {
	const extracted = await extractFactCategoriesSafe(text);
	return flattenExtractedFactCategories(extracted).slice(0, FLAT_FACT_LIMIT);
}
