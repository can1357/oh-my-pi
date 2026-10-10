/**
 * The model catalog the auth gateway routes, shared by `omp auth-gateway
 * serve` (`auth-gateway-cli.ts`) and `omp auth-gateway stdio`
 * (`auth-gateway-stdio.ts`).
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { ModelRegistry } from "../config/model-registry";

/**
 * Catalog kinds the gateway has a route for: chat (`/v1/chat/completions`,
 * `/v1/messages`, `/v1/responses`, `/v1/pi/stream`), judge (`/v1/systemone`),
 * image (`/v1/images/*`), tts (`/v1/audio/speech`), stt
 * (`/v1/audio/transcriptions`), embedding (`/v1/embeddings`), rerank
 * (`/v1/rerank`), video (`/v1/videos/*`). Other kinds (tiny, search) have no
 * wire and stay off the served catalog so `/v1/models` never advertises them.
 */
const GATEWAY_MODEL_KINDS: readonly ModelKind[] = [
	"chat",
	"judge",
	"image",
	"tts",
	"stt",
	"embedding",
	"rerank",
	"video",
];

/** Registry lookups spanning every kind the gateway routes, kinds in {@link GATEWAY_MODEL_KINDS} order. */
export interface GatewayModels {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
}

/**
 * `registry`'s lookups widened from their chat-only default to every kind the
 * gateway routes, so a judge, image, or speech model resolves and lists
 * alongside chat models.
 */
export function gatewayModels(registry: Pick<ModelRegistry, "getAll" | "getAvailable">): GatewayModels {
	return {
		getAll: () => GATEWAY_MODEL_KINDS.flatMap(kind => registry.getAll(kind)),
		getAvailable: () => GATEWAY_MODEL_KINDS.flatMap(kind => registry.getAvailable(kind)),
	};
}
