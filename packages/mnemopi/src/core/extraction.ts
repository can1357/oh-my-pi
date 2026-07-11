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

function normalizeFact(fact: string): string {
	const trimmed = fact.trim();
	// Remove trailing sentence punctuation (. ! ?) if present
	return trimmed.replace(/[.!?]+$/, "");
}
export function parseFacts(rawOutput: string | null | undefined): string[] {
	if (rawOutput === null || rawOutput === undefined) {
		return [];
	}
	const raw = rawOutput.trim();
	if (raw === "" || raw.toUpperCase() === "NO_FACTS") {
		return [];
	}
	const rawClean = stripFence(raw);
	if (rawClean.startsWith("{")) {
		try {
			const parsed = JSON.parse(rawClean) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				const obj = parsed as Record<string, unknown>;
				const out: string[] = [];
				for (const category of ["facts", "instructions", "preferences", "timelines"] as const) {
					const items = obj[category];
					if (Array.isArray(items)) {
						for (const item of items) {
							if (item !== null && item !== undefined && String(item).trim() !== "") {
								const normalized = normalizeFact(String(item));
								if (normalized !== "") {
									out.push(normalized);
								}
							}
						}
					}
				}
				if (out.length > 0) {
					return out.slice(0, 5);
				}
			}
		} catch {
			const matches = [...raw.matchAll(/"([^"]{10,})"/g)].map(m => m[1]).filter((v): v is string => v !== undefined);
			if (matches.length > 0) {
				return matches
					.map(normalizeFact)
					.filter(f => f !== "")
					.slice(0, 5);
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
	}
	return cleaned.slice(0, 5);
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

async function localFallback(prompt: string, sourceText: string, diag = getDiagnostics()): Promise<string[]> {
	diag.recordAttempt("local");
	try {
		const raw = await callLocalLlm(prompt);
		if (raw !== null) {
			const facts = parseFacts(cleanOutput(raw));
			if (facts.length > 0) {
				diag.recordSuccess("local", facts.length);
				diag.recordCall({ succeeded: true });
				return facts;
			}
			diag.recordNoOutput("local");
		}
	} catch (exc) {
		diag.recordFailure("local", exc, "local_llm_raised");
		diag.recordCall({ succeeded: false });
		return [];
	}
	diag.recordFailure("local", undefined, "model_not_loaded");
	const heuristic = heuristicExtractFacts(sourceText);
	if (heuristic.length > 0) {
		diag.recordSuccess("local", heuristic.length);
		diag.recordCall({ succeeded: true });
		return heuristic;
	}
	diag.recordCall({ succeeded: false, allEmpty: true });
	return [];
}

export async function extractFacts(text: string | null | undefined, options: RemoteLlmOptions = {}): Promise<string[]> {
	const diag = getDiagnostics();
	if (typeof text !== "string" || text.trim() === "") {
		return [];
	}
	const prompt = buildExtractionPrompt(text);

	// Configured completion (host-injected runtime LLM, e.g. the coding-agent's smol
	// or a local on-device model). Mirrors consolidation's precedence: when a
	// complete() fn is wired, it is the chosen path. Extraction is deterministic
	// (temperature 0) so re-ingesting the same content does not create near-dupes.
	if (configuredLlmWillHandleCall()) {
		diag.recordAttempt("host");
		try {
			const raw = await callConfiguredCompletion(prompt, 0, { maxTokens: llmMaxTokens() });
			if (typeof raw === "string" && raw.trim() !== "") {
				const facts = parseFacts(raw);
				if (facts.length > 0) {
					diag.recordSuccess("host", facts.length);
					diag.recordCall({ succeeded: true });
					return facts;
				}
			}
			diag.recordNoOutput("host");
		} catch (exc) {
			diag.recordFailure("host", exc, "configured_completion_raised");
			diag.recordCall({ succeeded: false });
			console.warn(`extractFacts: configured completion raised: ${safeForLog(exc)}`);
			return [];
		}
		return localFallback(prompt, text, diag);
	}

	try {
		const [attempted, hostText] = await tryHostExtraction(prompt);
		if (attempted) {
			diag.recordAttempt("host");
			if (hostText !== null) {
				const facts = parseFacts(hostText);
				if (facts.length > 0) {
					diag.recordSuccess("host", facts.length);
					diag.recordCall({ succeeded: true });
					return facts;
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
		return [];
	}

	if (!llmAvailable()) {
		diag.recordAttempt("local");
		const heuristic = heuristicExtractFacts(text);
		if (heuristic.length > 0) {
			diag.recordSuccess("local", heuristic.length);
			diag.recordCall({ succeeded: true });
			return heuristic;
		}
		diag.recordFailure("local", undefined, "llm_unavailable_at_call_site");
		diag.recordCall({ succeeded: false });
		return [];
	}

	diag.recordAttempt("remote");
	try {
		const raw = await callRemoteLlm(prompt, 0, options);
		if (raw !== null) {
			const facts = parseFacts(cleanOutput(raw));
			if (facts.length > 0) {
				diag.recordSuccess("remote", facts.length);
				diag.recordCall({ succeeded: true });
				return facts;
			}
		}
		diag.recordNoOutput("remote");
	} catch (exc) {
		diag.recordFailure("remote", exc, "remote_call_raised");
		console.warn(`extractFacts: remote LLM raised: ${safeForLog(exc)}`);
	}

	return localFallback(prompt, text, diag);
}

export async function extractFactsSafe(text: string | null | undefined): Promise<string[]> {
	try {
		return await extractFacts(text);
	} catch (exc) {
		const diag = getDiagnostics();
		diag.recordFailure("wrapper", exc, "outer_wrapper_caught");
		diag.recordCall({ succeeded: false });
		console.warn(`extractFactsSafe: extractFacts() raised: ${safeForLog(exc)}`);
		return [];
	}
}
