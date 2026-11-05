import type { Model } from "../types";
import { isCatalogEndpointUrl } from "./catalog-endpoint";
import { resolveCatalogPolicy } from "./catalog-policy";

/** `Content-Encoding` values a host may accept on request bodies. */
export type RequestBodyEncoding = "zstd" | "gzip";

/** Request-body compression contract for one request. */
export interface RequestCompressionPolicy {
	/** Accepted encodings, most preferred first. */
	readonly encodings: readonly RequestBodyEncoding[];
	/**
	 * Pattern of a JSON 400/415 error body that rejects the encoding;
	 * `undefined` treats every JSON 400/415 as a possible rejection. A
	 * 400/403/415 whose body is not JSON (presumed a proxy's answer, not the
	 * host's) is a possible rejection either way.
	 */
	readonly rejection: RegExp | undefined;
}

const rejectionPatterns = new Map<string, RegExp>();

/**
 * Compression contract for a request from {@link model} to {@link url}, or
 * `undefined` when the body must go uncompressed. The `request-encodings` axis
 * applies only while the URL reaches the provider's own endpoint
 * ({@link isCatalogEndpointUrl}): a proxy, relay, or rerouted base URL never
 * receives bytes it cannot read.
 */
export function resolveRequestCompression(model: Model, url: string): RequestCompressionPolicy | undefined {
	const policy = resolveCatalogPolicy(model);
	// The rule compiler validates encodings against the axis vocabulary.
	const encodings = policy.requestEncodings as readonly RequestBodyEncoding[] | undefined;
	if (!encodings?.length || !isCatalogEndpointUrl(model, url)) return undefined;
	const source = policy.requestEncodingRejection;
	if (typeof source !== "string") return { encodings, rejection: undefined };
	let rejection = rejectionPatterns.get(source);
	if (!rejection) {
		rejection = new RegExp(source);
		rejectionPatterns.set(source, rejection);
	}
	return { encodings, rejection };
}
