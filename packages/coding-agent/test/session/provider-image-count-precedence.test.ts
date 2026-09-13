import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Context, ImageContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	applyProviderImagePipeline,
	PROVIDER_IMAGE_COUNT_DECODE_SLACK,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { providerImageBudget } from "@oh-my-pi/snapcompact";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

/**
 * Distinct payloads: `unreadableImageReason` memoizes on a content hash, so
 * repeating one image would collapse every decode into a single cache hit and
 * hide the very cost this ordering exists to avoid. `salt` keeps each test's
 * history disjoint from the others' — that cache is module-level and outlives
 * any single test, so a shared payload would be served from a sibling's entry.
 */
function historyOf(count: number, salt: string): Context {
	return {
		messages: Array.from({ length: count }, (_, index) => ({
			role: "user" as const,
			content: [{ type: "image" as const, data: `${salt}${"!".repeat(index + 1)}`, mimeType: "image/png" }],
			timestamp: index,
		})),
	};
}

// 1x1 red PNG seed. Bun.Image cannot take a raw pixel array, so every
// decodable fixture below is re-encoded from this.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** A genuinely decodable PNG; `edge` makes each fixture a distinct payload. */
async function makeRedPng(edge: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(edge, edge, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toBase64();
}

/**
 * Middle-elided PNG: signature, IHDR and IEND all survive, so it is valid
 * base64 whose declared mime matches its magic — only the full decode the
 * unreadable pass performs rejects it.
 */
async function makeCorruptPng(): Promise<string> {
	const whole = Buffer.from(await makeRedPng(24), "base64");
	return Buffer.concat([whole.subarray(0, 40), whole.subarray(200)]).toString("base64");
}

function userImage(data: string, timestamp: number) {
	return {
		role: "user" as const,
		content: [{ type: "image", data, mimeType: "image/png" } satisfies ImageContent],
		timestamp,
	};
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

/**
 * The production pipeline, with the real normalizer — NOT a local recomposition
 * of its stages. Both `sdk.ts` `transformProviderContext` callbacks call
 * `applyProviderImagePipeline`, so a callsite that later drops or reorders the
 * early count clamp reds these tests instead of leaving them passing against a
 * private copy of the desired order.
 */
function runPipeline(context: Context): Promise<Context> {
	return applyProviderImagePipeline(context, UMANS_MODEL, imageLoading.normalizeProviderContextImagesForModel);
}

afterEach(() => {
	// Namespace spy, restored per test so no other suite sees a patched decoder.
	spyOn(imageLoading, "imageDecodeFailureReason").mockRestore();
});

describe("count cap precedes the decode pass", () => {
	it("bounds decode work by the cap, never by the history length", async () => {
		// The unreadable pass fully decodes every inline image behind a
		// 512-entry cache. A history past the admissible window therefore paid a
		// decode for images it was about to discard, and a history past the cache
		// size re-paid it on every single request.
		const budget = providerImageBudget(UMANS_MODEL.provider);
		const admissible = budget * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const context = historyOf(admissible + 20, "survivors");
		const decode = spyOn(imageLoading, "imageDecodeFailureReason");

		// Through the production pipeline, so the decode ceiling is measured
		// against the order `sdk.ts` actually runs.
		await runPipeline(context);

		// Only the admissible window is decoded — never the 20 beyond it. The
		// window is a constant multiple of the cap, so this stays a fixed ceiling
		// however long the history grows.
		expect(decode).toHaveBeenCalledTimes(admissible);
	});
});

describe("valid-image quota survives an unreadable newer image", () => {
	it("keeps a full cap of valid images when the newest one is undecodable", async () => {
		// The reviewer's scenario: exactly `budget` valid images, then one corrupt
		// image that puts the context one over the cap. The corrupt image is about
		// to become text, so it must not cost the oldest VALID image its slot —
		// the final count-aware clamp would have kept all `budget` of them.
		const budget = providerImageBudget(UMANS_MODEL.provider);
		const valid = await Promise.all(Array.from({ length: budget }, (_, index) => makeRedPng(index + 2)));
		const context: Context = {
			messages: [...valid.map((data, index) => userImage(data, index)), userImage(await makeCorruptPng(), budget)],
		};

		const final = await runPipeline(context);

		expect(imageData(final)).toHaveLength(budget);
		expect(imageData(final)).toEqual(valid);
	});

	it("still evicts oldest-first once the valid images alone exceed the cap", async () => {
		// The quota is a floor, not a licence to overshoot: with more VALID images
		// than the cap the newest `budget` win and the rest are dropped.
		const budget = providerImageBudget(UMANS_MODEL.provider);
		const valid = await Promise.all(Array.from({ length: budget + 4 }, (_, index) => makeRedPng(index + 2)));
		const context: Context = { messages: valid.map((data, index) => userImage(data, index)) };

		const final = await runPipeline(context);

		expect(imageData(final)).toEqual(valid.slice(4));
	});
});
