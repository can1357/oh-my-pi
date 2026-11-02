/**
 * Wire dialects of the native judgment APIs: how {@link NativeJudge} addresses,
 * encodes, and decodes one request for each API it serves. Internal to the
 * judgment module; `native.ts` maps every judgment API to its dialect.
 */
import type { ImageContent, Usage } from "../types";
import type { JudgmentImageInput } from "@oh-my-pi/pi-catalog/compat/judgment-images";
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

/** Image assets kept separately from judgment state for asset-aware native wires. */
export type JudgmentImageAssets = Readonly<Record<string, ImageContent>>;

/** How one judgment API addresses, encodes, and decodes a request. */
export interface JudgmentWire {
	/**
	 * Target of one attempt made with credential `key` against `model`.
	 * Throws when the credential cannot address the endpoint (e.g. no account id).
	 */
	target(baseUrl: string, model: string, key: string): JudgmentTarget;
	/** Request body for `model`, with optional asset context for dialects that preserve references. */
	encode(request: JudgmentRequest, model: string, imageAssets?: JudgmentImageAssets): unknown;
	/** Headers this dialect adds to requests that carry images. */
	imageHeaders?: Readonly<Record<string, string>>;
	/** Image input this dialect accepts; absent means text-only. */
	images?: JudgmentImageInput;
	/** Whether raw asset maps can be transported without loss by this dialect. */
	supportsImageAssets?: boolean;
	/** Whether image support must be enabled explicitly for direct NativeJudge construction. */
	imagesRequireOptIn?: boolean;
	/** Whether this wire drops per-image detail metadata. */
	ignoresImageDetail?: boolean;
	/** Whether this dialect forwards `box` questions; others reject them before sending. */
	boxes?: boolean;
	/** The response's answers and usage; `undefined` when the payload is not this API's response shape. */
	decode(payload: unknown): DecodedJudgment | undefined;
}

/** `value` when it is a finite number. */
export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
