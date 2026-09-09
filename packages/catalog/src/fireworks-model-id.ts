const FIREWORKS_WIRE_PREFIX = "accounts/fireworks/models/";
const FIREPASS_WIRE_PREFIX = "accounts/fireworks/routers/";
const VERSION_SEPARATOR_PATTERN = /(?<=\d)p(?=\d)/g;
const VERSION_DOT_PATTERN = /(?<=\d)\.(?=\d)/g;

export function toFireworksPublicModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREWORKS_WIRE_PREFIX) ? modelId.slice(FIREWORKS_WIRE_PREFIX.length) : modelId;
	return stripped.replace(VERSION_SEPARATOR_PATTERN, ".");
}

export function toFireworksWireModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREWORKS_WIRE_PREFIX) ? modelId.slice(FIREWORKS_WIRE_PREFIX.length) : modelId;
	return `${FIREWORKS_WIRE_PREFIX}${stripped.replace(VERSION_DOT_PATTERN, "p")}`;
}

/**
 * Fire Pass exposes its Kimi K2.6 Turbo subscription through a dedicated router
 * endpoint at `accounts/fireworks/routers/<id>` rather than the `models/` namespace.
 * We keep a friendly public id (e.g. `kimi-k2.6-turbo`) in the catalog and translate
 * to the wire form (`accounts/fireworks/routers/kimi-k2p6-turbo`) at request time.
 */
export function toFirepassPublicModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREPASS_WIRE_PREFIX) ? modelId.slice(FIREPASS_WIRE_PREFIX.length) : modelId;
	return stripped.replace(VERSION_SEPARATOR_PATTERN, ".");
}

export function toFirepassWireModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREPASS_WIRE_PREFIX) ? modelId.slice(FIREPASS_WIRE_PREFIX.length) : modelId;
	return `${FIREPASS_WIRE_PREFIX}${stripped.replace(VERSION_DOT_PATTERN, "p")}`;
}

/**
 * Public-id suffix marking a Fireworks "Fast" serving-path variant. Fast is a
 * higher-throughput route (100+ tok/s) exposed under a dedicated router id
 * (`accounts/fireworks/routers/<id>-fast`), not a separate model — same weights,
 * higher price, no Priority tier. We keep a friendly `<id>-fast` public id and
 * translate it to the router wire form at request time (compat
 * `wireModelIdMode: "firepass"`). See https://docs.fireworks.ai/serverless/serving-paths.
 */
export const FIREWORKS_FAST_SUFFIX = "-fast";

/** True for a Fireworks public model id that selects the Fast serving path. */
export function isFireworksFastModelId(modelId: string): boolean {
	return modelId.endsWith(FIREWORKS_FAST_SUFFIX);
}

/** Strip the Fast suffix to recover the base (Standard-tier) model id. */
export function toFireworksBaseModelId(modelId: string): string {
	return modelId.endsWith(FIREWORKS_FAST_SUFFIX) ? modelId.slice(0, -FIREWORKS_FAST_SUFFIX.length) : modelId;
}
