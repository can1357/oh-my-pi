/**
 * Consent-gated, read-only comparison of local resources (skills, extensions).
 *
 * `snapshotResource` captures a bounded, contained, non-executing view of a resource root plus an
 * explicit account of everything left out. `analyzeResources` sends only those snapshots to a
 * tool-free one-shot model call (no conversation, no session system prompt, no credentials) and
 * validates the untrusted reply against the snapshots. Nothing here writes state: persisting a
 * decision is the caller's job and is bound to `ResourceSnapshot.fingerprint`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Api, completeSimple, Effort, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import { isRecord, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	getModelMatchPreferences,
	resolveModelRoleValue,
	resolveProviderModelReference,
} from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import requestTemplate from "../prompts/resource-analysis/request.md" with { type: "text" };
import systemTemplate from "../prompts/resource-analysis/system.md" with { type: "text" };
import { MAX_FILES, type ResourceSnapshot } from "./resource-snapshot";

export interface ResourceAnalysis {
	relationship: "copies" | "adaptation" | "overlap" | "complementary" | "unrelated" | "uncertain";
	evidence: { candidateId: string; file: string; quote: string; explanation: string }[];
	differences: string[];
	recommendation: { action: "keep-all" | "prefer"; preferredId?: string; reason: string };
	limitations: string[];
}

/** Most candidates one analysis request accepts. Callers filter larger groups before asking. */
export const MAX_RESOURCE_ANALYSIS_CANDIDATES = 8;

const MIN_CANDIDATES = 2;
/** Most bytes of file text, paths and omission notes one analysis request accepts. */
export const MAX_RESOURCE_ANALYSIS_PROMPT_BYTES = 400 * 1024;
const MAX_RESPONSE_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 120_000;

const MAX_EVIDENCE = 24;
const MAX_DIFFERENCES = 12;
const MAX_LIMITATIONS = 8;
const MIN_QUOTE_CHARS = 8;
const MAX_QUOTE_CHARS = 600;

const RELATIONSHIPS = ["copies", "adaptation", "overlap", "complementary", "unrelated", "uncertain"] as const;
const ACTIONS = ["keep-all", "prefer"] as const;
/** Relationships under which hiding all but one candidate is even a coherent suggestion. */
const PREFERABLE: Record<ResourceAnalysis["relationship"], boolean> = {
	copies: true,
	adaptation: true,
	overlap: true,
	complementary: false,
	unrelated: false,
	uncertain: false,
};

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------------------------

function findExactModel(ref: string, available: Model<Api>[]): Model<Api> | undefined {
	const slash = ref.indexOf("/");
	if (slash > 0) {
		// Only the authenticated list is searched; a result that is not one of its entries (a re-labelled clone) is no match.
		const found = resolveProviderModelReference(ref.slice(0, slash), ref.slice(slash + 1), available);
		const hit = found && available.find(model => model.provider === found.provider && model.id === found.id);
		if (hit) return hit;
	}
	// Flat ids (including aggregator ids that contain a slash) must be unambiguous.
	const lower = ref.toLowerCase();
	const flat = available.filter(model => model.id.toLowerCase() === lower);
	if (flat.length > 1) {
		throw new Error(
			`Model "${ref}" is ambiguous: ${flat.map(model => `${model.provider}/${model.id}`).join(", ")}. Use provider/model.`,
		);
	}
	return flat[0];
}

/**
 * The model that will read the resources. Default: the `smol` role through the same resolver every
 * other role uses. An explicit selector must name one authenticated model exactly (`provider/id`, or
 * an unambiguous id, with an optional `:thinking` suffix) — no fuzzy matching, no role substitution,
 * no fallback to another model.
 */
export function resolveResourceAnalysisModel(
	registry: ModelRegistry,
	settings: Settings,
	modelSelector?: string,
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } {
	const available = registry.getAvailable();
	if (modelSelector === undefined) {
		const resolved = resolveModelRoleValue(formatModelRoleAlias("smol"), available, {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		if (!resolved.model) {
			throw new Error(
				"No smol model with configured credentials is available. Configure the smol role or pass a model.",
			);
		}
		return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
	}
	const selector = modelSelector.trim();
	if (!selector) throw new Error("Model selector is empty.");
	let model = findExactModel(selector, available);
	let thinkingLevel: ConfiguredThinkingLevel | undefined;
	if (!model) {
		const split = splitThinkingSuffix(selector, -1, MAX_THINKING_SUFFIX_OPTIONS);
		if (split.level) {
			model = findExactModel(split.base, available);
			thinkingLevel = split.level;
		}
	}
	if (!model) {
		throw new Error(
			`Model "${selector}" was not found among models with configured credentials. Use an exact provider/model id.`,
		);
	}
	return thinkingLevel === undefined ? { model } : { model, thinkingLevel };
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = prompt.render(systemTemplate);
// `compile`, not `render`: render's formatter would trim and merge whitespace inside file contents, and
// the model is asked to quote those files verbatim.
const renderRequest = prompt.compile(requestTemplate);

function buildPrompt(snapshots: readonly ResourceSnapshot[]): string {
	const body = snapshots.flatMap(snapshot => snapshot.files.map(file => file.content)).join("\n");
	let nonce: string;
	do nonce = crypto.randomUUID().replaceAll("-", "");
	while (body.includes(nonce));
	return renderRequest({
		count: snapshots.length,
		kind: snapshots[0]!.candidate.kind,
		nonce,
		resources: JSON.stringify(
			snapshots.map(snapshot => ({
				candidateId: snapshot.candidate.id,
				complete: snapshot.complete,
				files: snapshot.files.map(file => file.path),
				omissions: snapshot.omissions,
			})),
			null,
			1,
		),
		files: snapshots.flatMap(snapshot =>
			snapshot.files.map(file => ({
				nonce,
				header: JSON.stringify({ candidateId: snapshot.candidate.id, path: file.path }),
				content: file.content,
			})),
		),
	});
}

function assertDistinctRoots(snapshots: readonly ResourceSnapshot[], roots: readonly string[]): void {
	const seen = new Set<string>();
	for (const [index, root] of roots.entries()) {
		if (seen.has(root)) throw new Error(`Duplicate resource root for "${snapshots[index]!.candidate.id}".`);
		seen.add(root);
	}
}

function assertSnapshots(snapshots: readonly ResourceSnapshot[]): number {
	if (!Array.isArray(snapshots) || snapshots.length < MIN_CANDIDATES) {
		throw new Error(`Resource analysis needs at least ${MIN_CANDIDATES} resources.`);
	}
	if (snapshots.length > MAX_RESOURCE_ANALYSIS_CANDIDATES) {
		throw new Error(
			`Resource analysis accepts at most ${MAX_RESOURCE_ANALYSIS_CANDIDATES} resources per request (got ${snapshots.length}).`,
		);
	}
	const ids = new Set<string>();
	const kinds = new Set<string>();
	let bytes = 0;
	for (const snapshot of snapshots) {
		const candidate = snapshot?.candidate;
		if (
			!candidate ||
			typeof candidate.id !== "string" ||
			candidate.id === "" ||
			typeof candidate.root !== "string" ||
			(candidate.kind !== "skill" && candidate.kind !== "extension")
		) {
			throw new Error("Invalid resource snapshot.");
		}
		if (
			!Array.isArray(snapshot.files) ||
			!Array.isArray(snapshot.omissions) ||
			typeof snapshot.complete !== "boolean" ||
			typeof snapshot.fingerprint !== "string" ||
			!/^[0-9a-f]{64}$/.test(snapshot.fingerprint) ||
			snapshot.files.length > MAX_FILES
		) {
			throw new Error(`Invalid resource snapshot for "${candidate.id}".`);
		}
		if (ids.has(candidate.id)) throw new Error(`Duplicate resource id "${candidate.id}".`);
		ids.add(candidate.id);
		kinds.add(candidate.kind);
		const paths = new Set<string>();
		for (const file of snapshot.files) {
			if (typeof file?.path !== "string" || typeof file.content !== "string" || paths.has(file.path)) {
				throw new Error(`Invalid file list for "${candidate.id}".`);
			}
			paths.add(file.path);
			bytes += Buffer.byteLength(file.content) + Buffer.byteLength(file.path);
		}
		for (const omission of snapshot.omissions) {
			if (typeof omission !== "string") throw new Error(`Invalid omissions for "${candidate.id}".`);
			bytes += Buffer.byteLength(omission);
		}
	}
	assertDistinctRoots(
		snapshots,
		snapshots.map(snapshot => path.resolve(snapshot.candidate.root)),
	);
	if (kinds.size !== 1) throw new Error("Cannot compare resources of different kinds.");
	if (bytes > MAX_RESOURCE_ANALYSIS_PROMPT_BYTES) {
		throw new Error(
			`Resources hold ${bytes} bytes of content, over the ${MAX_RESOURCE_ANALYSIS_PROMPT_BYTES}-byte limit for one analysis. Analyze fewer or smaller resources.`,
		);
	}
	return bytes;
}

/**
 * The checks {@link analyzeResources} runs before touching a model, without a model, credentials or
 * I/O: candidate count, one kind, distinct ids and roots, and the byte cap. Returns the bytes of file
 * text, paths and omission notes the request would carry. Callers use it to refuse (or to size a
 * consent prompt) before asking anyone to approve a request that would be rejected anyway.
 */
export function preflightResourceAnalysis(snapshots: readonly ResourceSnapshot[]): { bytes: number } {
	return { bytes: assertSnapshots(snapshots) };
}

/**
 * Ask a model how the snapshots relate. One tool-free completion carrying only the snapshots; the
 * reply is validated by {@link parseResourceAnalysis}. Rejects bad input before any model call.
 */
export async function analyzeResources(
	snapshots: readonly ResourceSnapshot[],
	registry: ModelRegistry,
	settings: Settings,
	options?: { modelSelector?: string; signal?: AbortSignal },
): Promise<ResourceAnalysis> {
	assertSnapshots(snapshots);
	// Two roots that are one directory behind a symlink are still one resource.
	assertDistinctRoots(
		snapshots,
		await Promise.all(
			snapshots.map(snapshot =>
				fs.realpath(snapshot.candidate.root).catch(() => path.resolve(snapshot.candidate.root)),
			),
		),
	);

	const { model, thinkingLevel } = resolveResourceAnalysisModel(registry, settings, options?.modelSelector);
	const signal = options?.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const apiKey = await registry.getApiKey(model, undefined, { signal });
	if (!apiKey) throw new Error(`No credentials configured for ${model.provider}/${model.id}.`);
	const level = concreteThinkingLevel(thinkingLevel);
	// Clamp to what the chosen model supports (as other one-shot callers do); never switches models.
	const reasoning = clampThinkingLevelForModel(model, toReasoningEffort(level) ?? Effort.Low);
	const request = buildPrompt(snapshots);

	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{ systemPrompt: [SYSTEM_PROMPT], messages: [{ role: "user", content: request, timestamp: Date.now() }] },
				{
					apiKey: registry.resolver(model),
					maxTokens: model.maxTokens ? Math.min(MAX_RESPONSE_TOKENS, model.maxTokens) : MAX_RESPONSE_TOKENS,
					temperature: 0,
					signal,
					...(shouldDisableReasoning(level) ? { disableReasoning: true } : { reasoning }),
				},
			),
		{ signal, provider: model.provider },
	);
	if (response.stopReason === "aborted") throw new Error("Resource analysis was cancelled or timed out.");
	if (response.stopReason === "error") {
		throw new Error(`Analysis model failed: ${sanitizeText(response.errorMessage ?? "unknown error")}`);
	}
	if (response.stopReason === "length") throw new Error("Analysis model response was truncated.");
	const text = response.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	return parseResourceAnalysis(text, snapshots);
}

// ---------------------------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------------------------

function fail(message: string): never {
	throw new Error(`Invalid analysis response: ${message}`);
}

function extractJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	const body = fenced?.[1] ?? trimmed;
	for (const candidate of [body, body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)]) {
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next extraction.
		}
	}
	return fail("not valid JSON");
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	return fail(`${name} must be one of ${allowed.join(", ")}`);
}

function clampText(value: unknown, name: string, max: number, required: boolean): string {
	if (value === undefined || value === null) {
		if (required) fail(`${name} is required`);
		return "";
	}
	if (typeof value !== "string") return fail(`${name} must be a string`);
	const text = sanitizeText(value).trim();
	if (required && text === "") fail(`${name} must not be empty`);
	return text.length > max ? `${text.slice(0, max - 1).toWellFormed()}…` : text;
}

function textList(value: unknown, name: string, maxItems: number, maxChars: number): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return fail(`${name} must be an array`);
	return value
		.slice(0, maxItems)
		.map((item, index) => clampText(item, `${name}[${index}]`, maxChars, false))
		.filter(item => item !== "");
}

/**
 * Validate an untrusted model reply against the snapshots it was asked about.
 *
 * Malformed JSON, unknown enum values, unknown candidate ids, cited files that are not in that
 * candidate's snapshot, quotes that do not occur in the cited file, and a preferred id that is not a
 * candidate all reject the whole reply. A well-formed reply is then only as strong as the evidence
 * allows: claims of equivalence and any `prefer` are downgraded when coverage is incomplete or the
 * evidence does not span every candidate.
 */
export function parseResourceAnalysis(text: string, snapshots: readonly ResourceSnapshot[]): ResourceAnalysis {
	assertSnapshots(snapshots);
	const raw = extractJson(text);
	if (!isRecord(raw)) return fail("expected a JSON object");
	const byId = new Map(snapshots.map(snapshot => [snapshot.candidate.id, snapshot]));

	let relationship = oneOf(raw.relationship, RELATIONSHIPS, "relationship");

	const evidence: ResourceAnalysis["evidence"] = [];
	if (raw.evidence !== undefined && raw.evidence !== null) {
		if (!Array.isArray(raw.evidence)) return fail("evidence must be an array");
		if (raw.evidence.length > MAX_EVIDENCE) return fail(`evidence has more than ${MAX_EVIDENCE} items`);
		for (const [index, item] of raw.evidence.entries()) {
			if (!isRecord(item)) return fail(`evidence[${index}] must be an object`);
			const { candidateId, file } = item;
			const snapshot = typeof candidateId === "string" ? byId.get(candidateId) : undefined;
			if (typeof candidateId !== "string" || !snapshot) return fail(`evidence[${index}] names an unknown candidate`);
			if (typeof file !== "string") return fail(`evidence[${index}].file must be a string`);
			// Accept the snapshot's own relative path, tolerating ./ and backslash spellings; keep the canonical key.
			const normalizedFile = path.posix.normalize(file.replaceAll("\\", "/"));
			const source = snapshot.files.find(
				candidateFile => candidateFile.path === file || candidateFile.path === normalizedFile,
			);
			if (!source) return fail(`evidence[${index}] cites a file that is not in the snapshot of ${candidateId}`);
			if (typeof item.quote !== "string") return fail(`evidence[${index}].quote must be a string`);
			// Exact substring of the captured text (only surrounding whitespace is ignored); no paraphrase.
			const quote = item.quote.trim();
			if (quote === "" || quote.length > MAX_QUOTE_CHARS) {
				return fail(`evidence[${index}].quote must be 1-${MAX_QUOTE_CHARS} characters`);
			}
			if (!source.content.includes(quote) || (quote.length < MIN_QUOTE_CHARS && quote !== source.content.trim())) {
				return fail(`evidence[${index}].quote does not occur in ${source.path} of ${candidateId}`);
			}
			evidence.push({
				candidateId,
				file: source.path,
				quote,
				explanation: clampText(item.explanation, `evidence[${index}].explanation`, 400, false),
			});
		}
	}

	const differences = textList(raw.differences, "differences", MAX_DIFFERENCES, 400);
	const modelLimitations = textList(raw.limitations, "limitations", MAX_LIMITATIONS, 400);

	const recommendation = raw.recommendation;
	if (!isRecord(recommendation)) return fail("recommendation must be an object");
	const action = oneOf(recommendation.action, ACTIONS, "recommendation.action");
	const reason = clampText(recommendation.reason, "recommendation.reason", 500, true);
	let preferredId: string | undefined;
	if (action === "prefer") {
		if (typeof recommendation.preferredId !== "string" || !byId.has(recommendation.preferredId)) {
			return fail("recommendation.preferredId must be one of the candidate ids");
		}
		preferredId = recommendation.preferredId;
	}

	// Own judgement from here on: the reply is at most a proposal.
	const notes: string[] = [];
	const incomplete = snapshots.filter(snapshot => !snapshot.complete);
	for (const snapshot of incomplete) {
		notes.push(
			`${sanitizeText(snapshot.candidate.label || snapshot.candidate.id)}: coverage incomplete (${snapshot.omissions.length} omission(s)); equivalence and preference cannot be established.`,
		);
	}
	if (evidence.length === 0 && relationship !== "uncertain") {
		notes.push(`No verifiable evidence was cited; "${relationship}" is treated as uncertain.`);
		relationship = "uncertain";
	}
	if (incomplete.length > 0 && (relationship === "copies" || relationship === "adaptation")) {
		notes.push(`The reply said "${relationship}", which incomplete coverage cannot support; treated as uncertain.`);
		relationship = "uncertain";
	}
	// "copies" is a checkable claim: the same captured files with the same text, in any order, and the same
	// fingerprint. The fingerprint also covers file modes, which the model never sees (and is never sent).
	if (relationship === "copies") {
		const sameText =
			new Set(
				snapshots.map(snapshot =>
					JSON.stringify(
						snapshot.files.map(file => [file.path, file.content]).sort((a, b) => byCodeUnit(a[0]!, b[0]!)),
					),
				),
			).size === 1;
		if (!sameText) {
			notes.push('The reply said "copies", but the captured files differ; treated as adaptation.');
			relationship = "adaptation";
		} else if (new Set(snapshots.map(snapshot => snapshot.fingerprint)).size > 1) {
			notes.push(
				'The reply said "copies", but the file text is identical while file modes or other metadata differ; treated as uncertain.',
			);
			relationship = "uncertain";
		}
	}

	const result: ResourceAnalysis["recommendation"] = { action: "keep-all", reason };
	if (action === "prefer" && preferredId !== undefined) {
		const blockers: string[] = [];
		if (incomplete.length > 0) blockers.push("coverage of at least one resource is incomplete");
		if (!PREFERABLE[relationship]) blockers.push(`relationship is ${relationship}`);
		const cited = new Set(evidence.map(item => item.candidateId));
		if (snapshots.some(snapshot => !cited.has(snapshot.candidate.id))) {
			blockers.push("evidence does not cover every resource");
		}
		if (relationship !== "copies" && differences.length === 0) blockers.push("no differences were listed");
		if (blockers.length === 0) {
			result.action = "prefer";
			result.preferredId = preferredId;
		} else {
			result.reason = `Keep all: ${blockers.join("; ")}.`;
			notes.push(
				`The reply suggested preferring ${sanitizeText(byId.get(preferredId)?.candidate.label || preferredId)} ("${reason}"); not accepted.`,
			);
		}
	}

	return {
		relationship,
		evidence,
		differences,
		recommendation: result,
		limitations: [...notes, ...modelLimitations],
	};
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** One terminal-safe line: no escape sequences, controls, bidi/zero-width characters or newlines. */
function clean(value: unknown, max: number): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	const flat = sanitizeText(text).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
	return (flat.length > max ? `${flat.slice(0, max - 1)}…` : flat).toWellFormed();
}

/** Human-readable report. Every model- or file-derived string is stripped of terminal control sequences. */
export function formatResourceAnalysis(snapshots: readonly ResourceSnapshot[], analysis: ResourceAnalysis): string {
	const names = new Map(
		snapshots.map(snapshot => [
			snapshot.candidate.id,
			clean(snapshot.candidate.label, 80) || clean(snapshot.candidate.id, 80),
		]),
	);
	const name = (id: string): string => names.get(id) ?? clean(id, 80);
	const { recommendation } = analysis;
	const lines = [
		`Relationship: ${clean(analysis.relationship, 20)}`,
		recommendation.action === "prefer" && recommendation.preferredId !== undefined
			? `Recommendation: prefer ${name(recommendation.preferredId)} (the others could be hidden; nothing changes until you confirm)`
			: "Recommendation: keep all",
		`Reason: ${clean(recommendation.reason, 500)}`,
		"",
		"Inspected:",
	];
	for (const snapshot of snapshots) {
		lines.push(
			`  - ${name(snapshot.candidate.id)}: ${snapshot.files.length} file(s), coverage ${snapshot.complete ? "complete" : "INCOMPLETE"}, fingerprint ${clean(snapshot.fingerprint, 12)}`,
		);
		for (const omission of snapshot.omissions.slice(0, 6)) lines.push(`      not inspected: ${clean(omission, 160)}`);
		if (snapshot.omissions.length > 6) lines.push(`      … ${snapshot.omissions.length - 6} more not inspected`);
	}
	const section = (title: string, items: readonly string[]): void => {
		if (items.length === 0) return;
		lines.push("", `${title}:`, ...items.map(item => `  - ${item}`));
	};
	section(
		"Evidence",
		analysis.evidence.map(
			item =>
				`${name(item.candidateId)} ${clean(item.file, 80)}: "${clean(item.quote, 200)}"${item.explanation ? ` — ${clean(item.explanation, 300)}` : ""}`,
		),
	);
	section(
		"Differences",
		analysis.differences.map(item => clean(item, 400)),
	);
	section(
		"Limitations",
		analysis.limitations.map(item => clean(item, 400)),
	);
	lines.push(
		"",
		"This analysis is advisory and model-generated; it changed nothing. It compares file content only, not authorship, origin or trust.",
	);
	return lines.join("\n");
}
