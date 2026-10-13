/**
 * Wire dialects of the native judgment APIs: how {@link NativeJudge} addresses,
 * encodes, and decodes one request for each API it serves. Internal to the
 * judgment module; `native.ts` maps every judgment API to its dialect.
 */
import type { JudgmentConfig } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Usage } from "../types";
import { type JudgmentRequest, type Questions, type WireQuestions, tokenUsage } from "./types";

/** Where one attempt posts and which bearer token it sends. */
export interface JudgmentTarget {
	url: string;
	token: string;
}

/** One decoded response. */
export interface DecodedJudgment {
	/** Model that answered, when the response names one. */
	model: string | undefined;
	/** Wire answers keyed by question id; {@link NativeJudge} checks each against its question's type. */
	answers: Readonly<Record<string, unknown>>;
	/** Question ids the model declined to answer. */
	refused: readonly string[];
	usage: Usage;
}

/** How one judgment API addresses, encodes, and decodes a request. */
export interface JudgmentWire {
	/**
	 * Target of one attempt made with credential `key` against `model`.
	 * Throws when the credential cannot address the endpoint (e.g. no account id).
	 */
	target(baseUrl: string, model: string, key: string): JudgmentTarget;
	/** Request body for `model`. */
	encode(request: JudgmentRequest<Questions | WireQuestions>, model: string): unknown;
	/** The response's answers and usage; `undefined` when the payload is not this API's response shape. */
	decode(payload: unknown, questions?: Questions): DecodedJudgment | undefined;
}

/** `value` when it is a finite number. */
export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const RESERVED_VALUE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_TYPE_FIELDS = new Set([
	"instructions",
	"criteria",
	"probabilities",
	"confidence",
	...RESERVED_VALUE_KEYS,
]);
const CANONICAL_ANSWER_KEYS = new Set(["choice", "noul", "score"]);

function isCanonicalAnswerKey(key: string): key is "choice" | "noul" | "score" {
	return CANONICAL_ANSWER_KEYS.has(key);
}

/**
 * Decorate a path-based System One wire (typesafe/openrouter-decisions)
 * with per-model {@link JudgmentConfig} overrides:
 * - `route` replaces the dialect's target URL path under `baseUrl`;
 *   workers-ai account-scoped URLs are not route-compatible (route would
 *   drop the account/model path).
 * - `typeField` and `typeMap` map question types on request encode.
 * - `valueMap` maps answer value keys back to canonical keys on decode (for each question's canonical type).
 * - `usageMap` maps response usage fields using {@link finiteNumber}.
 *
 * MUST NOT wrap translating wires (openai-decisions): encode maps
 * canonical types before inner.encode, which translators already consume.
 */
export function decorateJudgmentWire(inner: JudgmentWire, config: JudgmentConfig | undefined): JudgmentWire {
	if (!config) return inner;
	const route = config.route;
	const typeField = config.typeField ?? "type";
	const typeMap = config.typeMap;
	const valueMap = config.valueMap;
	const usageMap = config.usageMap;
	if (RESERVED_TYPE_FIELDS.has(typeField)) {
		throw new AIError.ConfigurationError(`judgment.typeField must not name reserved key "${typeField}"`);
	}
	if (valueMap !== undefined) {
		for (const [canonical, wireKey] of Object.entries(valueMap)) {
			// Choice/score answers require their metadata siblings: consuming
			// `probabilities`/`confidence` as the value source would delete a
			// required field (noul answers carry neither, so they stay allowed).
			const consumesMetadata =
				(canonical === "choice" || canonical === "score") &&
				(wireKey === "probabilities" || wireKey === "confidence");
			if (wireKey === typeField || RESERVED_VALUE_KEYS.has(wireKey) || consumesMetadata) {
				throw new AIError.ConfigurationError(
					`judgment.valueMap for "${canonical}" must not name reserved key "${wireKey}"`,
				);
			}
		}
	}
	if (isCanonicalAnswerKey(typeField) && !valueMap?.[typeField]) {
		throw new AIError.ConfigurationError(
			`judgment.typeField "${typeField}" requires a matching judgment.valueMap["${typeField}"] pairing`,
		);
	}
	if (route === undefined && typeField === "type" && !typeMap && !valueMap && !usageMap) {
		return inner;
	}

	return {
		target(baseUrl, model, key) {
			if (route !== undefined && !route.startsWith("/")) {
				throw new AIError.ConfigurationError(`judgment.route must start with "/": ${route}`);
			}
			const innerTarget = inner.target(baseUrl, model, key);
			if (route === undefined) return innerTarget;
			return {
				url: `${baseUrl}${route}`,
				token: innerTarget.token,
			};
		},
		encode(request: JudgmentRequest<Questions>, model) {
			if (typeMap === undefined && typeField === "type") {
				return inner.encode(request, model);
			}
			const wireQuestions: WireQuestions = Object.create(null);
			for (const id in request.questions) {
				if (!Object.hasOwn(request.questions, id)) continue;
				const question = request.questions[id];
				const wireQuestion: Record<string, unknown> = {
					...question,
					[typeField]: typeMap?.[question.type] ?? question.type,
				};
				if (typeField !== "type") delete wireQuestion.type;
				wireQuestions[id] = wireQuestion;
			}
			// Validated wire question envelope: wire-mapped discriminators replace canonical question types.
			return inner.encode({ state: request.state, questions: wireQuestions }, model);
		},
		decode(payload, questions) {
			const decoded = inner.decode(payload, questions);
			if (!decoded) return undefined;

			let usage = decoded.usage;
			if (usageMap !== undefined && isRecord(payload)) {
				const raw = isRecord(payload.result) ? payload.result : payload;
				const rawUsage = isRecord(raw.usage) ? raw.usage : {};
				usage = tokenUsage(
					finiteNumber(rawUsage[usageMap.input ?? "input_tokens"]),
					finiteNumber(rawUsage[usageMap.output ?? "output_tokens"]),
					finiteNumber(rawUsage.cost),
				);
			}

			if (typeMap === undefined && valueMap === undefined && typeField === "type") {
				return usageMap !== undefined ? { ...decoded, usage } : decoded;
			}

			const answers: Record<string, unknown> = Object.create(null);
			for (const id in decoded.answers) {
				if (!Object.hasOwn(decoded.answers, id)) continue;
				const raw: unknown = decoded.answers[id];
				if (!isRecord(raw)) {
					answers[id] = raw;
					continue;
				}
				const canonical = questions && Object.hasOwn(questions, id) ? questions[id]?.type : undefined;
				if (canonical === undefined) {
					answers[id] = raw;
					continue;
				}
				const expectedWire = typeMap?.[canonical] ?? canonical;
				const wireType: unknown = raw[typeField];

				if (wireType !== expectedWire) {
					answers[id] = raw;
					continue;
				}

				const normalized: Record<string, unknown> = { ...raw };
				if (typeField !== "type") {
					delete normalized[typeField];
				}
				if (valueMap !== undefined) {
					const wireKey = valueMap[canonical];
					if (wireKey !== undefined && wireKey !== canonical && normalized[wireKey] !== undefined) {
						normalized[canonical] ??= normalized[wireKey];
						delete normalized[wireKey];
					}
				}
				normalized.type = canonical;
				answers[id] = normalized;
			}

			return { ...decoded, answers, usage };
		},
	};
}
