/**
 * Wire dialects of the native judgment APIs: how {@link NativeJudge} addresses,
 * encodes, and decodes one request for each API it serves. Internal to the
 * judgment module; `native.ts` maps every judgment API to its dialect.
 */
import type { Usage } from "../types";
import type { JudgmentRequest } from "./types";

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
	encode(request: JudgmentRequest, model: string): unknown;
	/** The response's answers and usage; `undefined` when the payload is not this API's response shape. */
	decode(payload: unknown): DecodedJudgment | undefined;
}

/** `value` when it is a finite number. */
export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
