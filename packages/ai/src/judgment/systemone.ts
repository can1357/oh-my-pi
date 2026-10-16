/**
 * TypeSafe and OpenRouter use the `{ model, state, questions }` body. Images
 * join `state` without replacing it (see {@link stateWithImages}): TypeSafe as
 * references to a top-level `assets` map, OpenRouter as `image_url` data URL
 * parts. Cloudflare optionally accepts image data URLs in its envelope.
 *
 * - `typesafe`: `POST {baseUrl}/v1/systemone` — TypeSafe and every System One
 *   server (OpenJEV, Kev, self-hosted Clef, OpenCode Zen, Command Code).
 * - `openrouter-decisions`: `POST {baseUrl}/decisions` under OpenRouter's
 *   `/api/alpha`; usage adds the billed `cost` in USD.
 * - `workers-ai-systemone`: Cloudflare Workers AI's `POST {baseUrl}/{model}`
 *   (`/client/v4/accounts/<account>/ai/run/@cf/cloudflare/clef`). The body
 *   names the model by its last path segment (`clef`), adds a top-level array
 *   of base64 data URLs when images are supplied, and returns Cloudflare's
 *   `{ result, success, errors }` envelope. The credential is a Cloudflare
 *   API token plus the account id the URL needs.
 */
import { parseCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { $env, isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { embeddedImageDataUrl } from "../images/shared";
import type { ImageContent } from "../types";
import { type JsonValue, type JudgmentRequest, tokenUsage } from "./types";
import {
	type DecodedJudgment,
	finiteNumber,
	JEV_IMAGE_INPUT,
	type JudgmentImageAssets,
	type JudgmentWire,
} from "./wire";

function decodeSystemOne(payload: unknown): DecodedJudgment | undefined {
	if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
	const usage = isRecord(payload.usage) ? payload.usage : {};
	return {
		model: typeof payload.model === "string" ? payload.model : undefined,
		answers: payload.answers,
		refused: [],
		usage: tokenUsage(finiteNumber(usage.input_tokens), finiteNumber(usage.output_tokens), finiteNumber(usage.cost)),
	};
}

/**
 * `state` with `items` added and every original value kept: arrays gain them at the end, objects
 * under the first free `__omp_judgment_images[_N]` key, and a string root becomes `[state, ...items]`.
 */
function stateWithImages(state: JudgmentRequest["state"], items: readonly JsonValue[]): JudgmentRequest["state"] {
	if (Array.isArray(state)) return [...state, ...items];
	if (!isRecord(state)) return [state, ...items];
	const baseKey = "__omp_judgment_images";
	let key = baseKey;
	for (let suffix = 1; Object.hasOwn(state, key); suffix++) key = `${baseKey}_${suffix}`;
	return { ...state, [key]: items };
}

function* jsonStrings(value: unknown): Generator<string> {
	if (typeof value === "string") yield value;
	else if (Array.isArray(value)) for (const item of value) yield* jsonStrings(item);
	else if (isRecord(value)) for (const key in value) yield* jsonStrings(value[key]);
}

/**
 * The subset of `assets` that `request` references. TypeSafe substitutes a reference wherever it
 * occurs as text in a string of `state`, a question's `instructions`, or its `criteria` (never in
 * object keys) and rejects a request carrying an unreferenced asset.
 */
export function referencedImageAssets(request: JudgmentRequest, assets: JudgmentImageAssets): JudgmentImageAssets {
	const pending = new Set(Object.keys(assets));
	const visit = (value: unknown): void => {
		for (const text of jsonStrings(value)) {
			if (pending.size === 0) return;
			for (const reference of pending) if (text.includes(reference)) pending.delete(reference);
		}
	};
	visit(request.state);
	for (const id in request.questions) {
		const question = request.questions[id];
		visit(question.instructions);
		visit(question.criteria);
	}
	// `fromEntries` defines own properties, so a `__proto__` reference stays an ordinary key.
	return Object.fromEntries(Object.entries(assets).filter(([reference]) => !pending.has(reference)));
}

interface SystemOneImageAsset {
	type: "image";
	format: "png" | "jpeg";
	data_base64: string;
}

function encodeSystemOneImage(image: ImageContent): SystemOneImageAsset {
	const mimeType = image.mimeType.toLowerCase();
	return {
		type: "image",
		format: mimeType === "image/png" ? "png" : "jpeg",
		data_base64: Buffer.from(image.data, "base64").toString("base64"),
	};
}

/** A System One dialect posting the verbatim request to `path` under the base URL with the key as bearer. */
function systemOneWire(path: string): JudgmentWire {
	return {
		target: (baseUrl, _model, key) => ({ url: `${baseUrl}${path}`, token: key }),
		encode: (request, model) => ({ state: request.state, model, questions: request.questions }),
		decode: decodeSystemOne,
	};
}

/** TypeSafe's own route, shared by every System One server. */
export const typesafeWire: JudgmentWire = {
	...systemOneWire("/v1/systemone"),
	images: JEV_IMAGE_INPUT,
	supportsImageAssets: true,
	imagesRequireOptIn: true,
	imageHeaders: { "TypeSafe-Danger-Zone-Images": "true" },
	encode(request, model, imageAssets) {
		const suppliedAssets = Object.entries(imageAssets ?? {});
		const images = request.images ?? [];
		if (suppliedAssets.length === 0 && images.length === 0) {
			return { state: request.state, model, questions: request.questions };
		}

		const assets: Record<string, SystemOneImageAsset> = Object.fromEntries(
			suppliedAssets.map(([reference, image]) => [reference, encodeSystemOneImage(image)]),
		);
		const references: string[] = [];
		for (const image of images) {
			let reference = crypto.randomUUID();
			while (Object.hasOwn(assets, reference)) reference = crypto.randomUUID();
			assets[reference] = encodeSystemOneImage(image);
			references.push(reference);
		}

		return {
			state: references.length ? stateWithImages(request.state, references) : request.state,
			model,
			questions: request.questions,
			assets,
		};
	},
};

/** OpenRouter Decisions: System One body under `/api/alpha`, with image parts preserved in state. */
export const openrouterDecisionsWire: JudgmentWire = {
	...systemOneWire("/decisions"),
	images: JEV_IMAGE_INPUT,
	imagesRequireOptIn: true,
	encode(request, model) {
		const imageParts: JsonValue[] = (request.images ?? []).map(image => ({
			type: "image_url",
			image_url: {
				url: embeddedImageDataUrl(image),
				...(image.detail !== undefined ? { detail: image.detail === "original" ? "auto" : image.detail } : {}),
			},
		}));
		return {
			state: imageParts.length ? stateWithImages(request.state, imageParts) : request.state,
			model,
			questions: request.questions,
		};
	},
};

/** Cloudflare Workers AI decision models (Clef) through the account-scoped `ai/run` route. */
export const workersAiWire: JudgmentWire = {
	// Clef's `images` extension: https://developers.cloudflare.com/workers-ai/models/clef/
	images: {
		mimeTypes: ["image/png", "image/jpeg", "image/webp"],
		maxCount: 4,
		maxBytes: 4 * 1024 * 1024,
		maxTotalBytes: 8 * 1024 * 1024,
		maxPixels: 16_000_000,
	},
	target(baseUrl, model, key) {
		const credential = parseCloudflareCredential(key);
		const accountId = credential?.accountId ?? $env.CLOUDFLARE_ACCOUNT_ID?.trim();
		if (!accountId) {
			throw new AIError.ConfigurationError(
				"Cloudflare account ID is required: log in to Cloudflare Workers AI again or set CLOUDFLARE_ACCOUNT_ID",
			);
		}
		return { url: `${baseUrl.replace("<account>", accountId)}/${model}`, token: credential?.token ?? key };
	},
	encode: (request, model) => ({
		state: request.state,
		model: model.slice(model.lastIndexOf("/") + 1),
		questions: request.questions,
		...(request.images?.length ? { images: request.images.map(embeddedImageDataUrl) } : {}),
	}),
	decode: payload => (isRecord(payload) ? decodeSystemOne(payload.result) : undefined),
};
