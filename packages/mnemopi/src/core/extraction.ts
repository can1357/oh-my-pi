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

export const EXTRACTION_PROMPT_TEMPLATE =
	env("MNEMOPI_EXTRACTION_PROMPT") ||
	`You are an expert structured memory extractor for Mnemopi v3.0+ MEMORIA tables.
The user message below may be in English, German, Russian, or another language.
First detect the language, then extract ONLY high-signal, long-term relevant items.
Categories to extract (return valid JSON only, no extra text):
- facts: persistent user metrics, states, knowledge, or personal data
  (Examples: 'my name is X', 'I work at Y', 'server runs on port 8080')
- instructions: rules or commands directed at me the agent
  (Examples: 'always use tabs', 'never delete logs', 'call me boss')
- preferences: likes, dislikes, and their evolution
  (Examples: 'I like dark mode', 'I prefer Python over Go')
- timelines: real events with dates/times
  (Examples: 'release on 2024-12-01', 'meeting next Tuesday')
- kg: knowledge-graph triples in subject-predicate-object form

Rules:
- Only extract persistent, non-transient content. Ignore weather, one-off chat, system text.
- Use semantic understanding — do NOT rely on English keywords.
- Preserve original casing and language.
- If nothing qualifies, return empty arrays.

Return JSON in this exact format:
{"facts": [], "instructions": [], "preferences": [], "timelines": [], "kg": []}

User message: {text}

Extraction:`;

export function buildExtractionPrompt(text: string, detectedLang = "en"): string {
	const template = getMnemopiRuntimeOptions()?.llm?.extractionPrompt ?? EXTRACTION_PROMPT_TEMPLATE;
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

/** Category-preserving extraction result used by background memory routing. */
export interface ExtractedFactCategories {
	facts: string[];
	instructions: string[];
	preferences: string[];
	timelines: string[];
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

function normalizeFactArray(items: unknown, options: FactArrayOptions): string[] {
	if (!Array.isArray(items)) {
		return [];
	}
	const out: string[] = [];
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
			if (normalized !== "") {
				out.push(normalized);
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

/** Flatten extracted string categories for legacy fact callers. */
export function flattenExtractedFactCategories(extracted: ExtractedFactCategories): string[] {
	const out: string[] = [];
	for (const category of STRING_CATEGORY_KEYS) {
		for (const item of extracted[category]) {
			out.push(item);
		}
	}
	return out;
}

/** Count string facts plus KG triples in a category-preserving extraction result. */
export function countExtractedFactCategories(extracted: ExtractedFactCategories): number {
	return (
		extracted.facts.length +
		extracted.instructions.length +
		extracted.preferences.length +
		extracted.timelines.length +
		extracted.kg.length
	);
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
					timelines: normalizeFactArray(parsed.timelines, { fields: TIMELINE_TEXT_FIELD_KEYS, joinFields: true }),
					kg: normalizeKgArray(parsed.kg),
				};
			}
		} catch {
			const matches = [...raw.matchAll(/"([^"]{10,})"/g)].map(m => m[1]).filter((v): v is string => v !== undefined);
			if (matches.length > 0) {
				return {
					...emptyFactCategories(),
					facts: matches
						.map(normalizeFact)
						.filter(f => f !== "")
						.slice(0, FLAT_FACT_LIMIT),
				};
			}
		}
	}
	const cleaned: string[] = [];
	for (const line of raw.split("\n")) {
		const fact = line.replace(/^[\s\d.\-*]+/, "").trim();
		if (fact.length > 10) {
			const normalized = normalizeFact(fact);
			if (normalized !== "") {
				cleaned.push(normalized);
			}
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
	if (normalized === "") {
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

/**
 * Bounded repeat counts (`{0,4}` per proper-noun phrase, `{1,40}` for the role
 * word span) keep this immune to catastrophic backtracking on adversarial
 * input while still spanning realistic multi-word names/roles/orgs.
 */
const ROLE_OF_PATTERN =
	/\b([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,4})\s+is\s+(?:the\s+|an?\s+)?([a-zA-Z][a-zA-Z\s-]{1,40}?)\s+of\s+([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,4})\b/;

function addUniqueTriple(out: ExtractedKgTriple[], subject: string, predicate: string, object: string): void {
	const triple = { subject: normalizeFact(subject), predicate, object: normalizeFact(object) };
	const isDuplicate = out.some(
		t => t.subject === triple.subject && t.predicate === triple.predicate && t.object === triple.object,
	);
	if (triple.subject.length > 1 && triple.object.length > 1 && !isDuplicate) {
		out.push(triple);
	}
}

/**
 * Deterministic, no-LLM knowledge-graph extraction. An "<X> is the <role> of
 * <Y>" clause (e.g. "Priya Natarajan is the CEO of Vindral") is an
 * unambiguous subject-predicate-object relation regardless of which words
 * fill X/role/Y, so it is safe to promote it to a real `kg` triple
 * (predicate `is_<role>_of`) instead of letting it degrade into a flat fact
 * string. Mirrors heuristicExtractFacts's clause splitting so both
 * heuristics agree on sentence boundaries; this is a general grammatical
 * rule, not a fixed list of role names.
 */
export function heuristicExtractKg(text: string): ExtractedKgTriple[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized === "") {
		return [];
	}
	const triples: ExtractedKgTriple[] = [];
	const clauses = normalized.split(/(?:[.!?;]+|\s+and\s+|\s+but\s+)/i);
	for (const clause of clauses) {
		const match = ROLE_OF_PATTERN.exec(clause.trim());
		const subject = match?.[1];
		const role = match?.[2];
		const object = match?.[3];
		if (subject !== undefined && role !== undefined && object !== undefined) {
			const slug = role
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "");
			if (slug !== "") {
				addUniqueTriple(triples, subject, `is_${slug}_of`, object);
			}
		}
		if (triples.length >= STRUCTURED_CATEGORY_LIMIT) break;
	}
	return triples;
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
	const heuristic = heuristicExtractFacts(sourceText);
	const kg = heuristicExtractKg(sourceText);
	if (heuristic.length > 0 || kg.length > 0) {
		diag.recordSuccess("local", heuristic.length + kg.length);
		diag.recordCall({ succeeded: true });
		return { ...emptyFactCategories(), facts: heuristic, kg };
	}
	diag.recordCall({ succeeded: false, allEmpty: true });
	return emptyFactCategories();
}

/** Extract fact categories from text using configured, host, local, or remote LLMs. */
export async function extractFactCategories(
	text: string | null | undefined,
	options: RemoteLlmOptions = {},
): Promise<ExtractedFactCategories> {
	const diag = getDiagnostics();
	if (typeof text !== "string" || text.trim() === "") {
		return emptyFactCategories();
	}
	const prompt = buildExtractionPrompt(text);

	// Configured completion (host-injected runtime LLM, e.g. the coding-agent's smol
	// or a local on-device model). Mirrors consolidation's precedence: when a
	// complete() fn is wired, it is the chosen path. Extraction is deterministic
	// (temperature 0) so re-ingesting the same content does not create near-dupes.
	if (configuredLlmWillHandleCall()) {
		diag.recordAttempt("host");
		try {
			const raw = await callConfiguredCompletion(prompt, 0, {
				maxTokens: llmMaxTokens(),
				task: { kind: "memory-extraction", input: text },
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
		return localFallback(prompt, text, diag);
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
			return localFallback(prompt, text, diag);
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
		const heuristic = heuristicExtractFacts(text);
		const kg = heuristicExtractKg(text);
		if (heuristic.length > 0 || kg.length > 0) {
			diag.recordSuccess("local", heuristic.length + kg.length);
			diag.recordCall({ succeeded: true });
			return { ...emptyFactCategories(), facts: heuristic, kg };
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

	return localFallback(prompt, text, diag);
}

/** Extract legacy flat fact strings from text. */
export async function extractFacts(text: string | null | undefined, options: RemoteLlmOptions = {}): Promise<string[]> {
	const extracted = await extractFactCategories(text, options);
	return flattenExtractedFactCategories(extracted).slice(0, FLAT_FACT_LIMIT);
}

/** Safely extract category-preserving facts, swallowing best-effort failures. */
export async function extractFactCategoriesSafe(text: string | null | undefined): Promise<ExtractedFactCategories> {
	try {
		return await extractFactCategories(text);
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
