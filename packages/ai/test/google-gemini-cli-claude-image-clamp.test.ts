import { describe, expect, it } from "bun:test";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, ImageContent, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Vertex Anthropic's per-image cap behind Antigravity, as declared in KDL. */
const ANTIGRAVITY_CLAUDE_IMAGE_PAYLOAD_BYTES = 5 * 1024 * 1024;

function makeModel(id: string): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const claude = makeModel("claude-sonnet-4-6");
const gemini = makeModel("gemini-3-flash");

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toString("base64");
}

/**
 * A PNG inside every pixel cap whose base64 passes 5 MiB. Trailing bytes
 * after IEND stand in for a dense screenshot so the test does not spend
 * seconds encoding noise.
 */
async function makeHeavyPng(): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const canvas = await new Bun.Image(seed).resize(1200, 900, { filter: "nearest" }).png().bytes();
	return Buffer.concat([Buffer.from(canvas), Buffer.alloc(4 * 1024 * 1024, 7)]).toString("base64");
}

function userImages(images: ImageContent[]): Context {
	return {
		messages: [{ role: "user", content: [{ type: "text", text: "Describe these." }, ...images], timestamp: 1 }],
	};
}

interface InlineData {
	mimeType: string;
	data: string;
}

function collectInlineData(value: unknown, out: InlineData[] = []): InlineData[] {
	if (Array.isArray(value)) {
		for (const item of value) collectInlineData(item, out);
	} else if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const inline = record.inlineData as InlineData | undefined;
		if (inline && typeof inline.data === "string") out.push(inline);
		for (const child of Object.values(record)) collectInlineData(child, out);
	}
	return out;
}

/** Build the Cloud Code Assist request through the stream path and stop before any network call. */
function captureImages(model: Model<"google-gemini-cli">, context: Context): Promise<InlineData[]> {
	const { promise, resolve } = Promise.withResolvers<InlineData[]>();
	const controller = new AbortController();
	void streamGoogleGeminiCli(model, context, {
		apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
		signal: controller.signal,
		fetch: async () => {
			throw new Error("network disabled in test");
		},
		onPayload: payload => {
			controller.abort();
			resolve(collectInlineData(payload));
			return undefined;
		},
	});
	return promise;
}

async function dimensions(data: string): Promise<{ width: number; height: number }> {
	const { width, height } = await new Bun.Image(Buffer.from(data, "base64")).metadata();
	return { width, height };
}

describe("Antigravity Claude image clamp", () => {
	it("resolves Antigravity's Claude image contract from KDL, and none for Gemini", () => {
		expect(claude.compat.maxImagePayloadBytes).toBe(ANTIGRAVITY_CLAUDE_IMAGE_PAYLOAD_BYTES);
		expect(claude.compat.maxImageDimension).toBe(8000);
		expect(gemini.compat.maxImagePayloadBytes).toBeUndefined();
		expect(gemini.compat.maxImageDimension).toBeUndefined();
	});

	it("re-encodes a Claude image past the 5 MiB base64 cap", async () => {
		// Reproduces Antigravity's 400 "image exceeds 5 MB maximum" for one
		// image whose base64 is longer than 5,242,880 characters.
		const heavyData = await makeHeavyPng();
		expect(heavyData.length).toBeGreaterThan(ANTIGRAVITY_CLAUDE_IMAGE_PAYLOAD_BYTES);
		const heavy: ImageContent = { type: "image", data: heavyData, mimeType: "image/png" };

		const images = await captureImages(claude, userImages([heavy]));

		expect(images).toHaveLength(1);
		expect(images[0].data.length).toBeLessThanOrEqual(ANTIGRAVITY_CLAUDE_IMAGE_PAYLOAD_BYTES);
		expect(await dimensions(images[0].data)).toEqual({ width: 1200, height: 900 });
		expect(heavy.data).toBe(heavyData);
	});

	it("clamps a Claude image past 8000px", async () => {
		const tallData = await makeRedPng(240, 8570);
		const source = await dimensions(tallData);
		expect(source.height).toBeGreaterThan(8000);
		expect(tallData.length).toBeLessThanOrEqual(Math.floor(ANTIGRAVITY_CLAUDE_IMAGE_PAYLOAD_BYTES * 0.9));
		const tall: ImageContent = { type: "image", data: tallData, mimeType: "image/png" };
		const images = await captureImages(claude, userImages([tall]));

		expect(images).toHaveLength(1);
		expect(tall.data).toBe(tallData);
		expect(await dimensions(images[0].data)).toEqual({ width: 224, height: 8000 });
	});

	it("applies the many-image cap to Claude past 20 images", async () => {
		const largeData = await makeRedPng(2400, 1200);
		const small: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = userImages([
			{ type: "image", data: largeData, mimeType: "image/png" },
			...Array.from({ length: 20 }, () => small),
		]);

		const images = await captureImages(claude, context);

		expect(images).toHaveLength(21);
		const { width, height } = await dimensions(images[0].data);
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
		expect(images[1].data).toBe(RED_1X1_PNG_BASE64);
	});

	it("sends Gemini images on the same gateway as they are", async () => {
		const heavyData = await makeHeavyPng();
		const tallData = await makeRedPng(240, 8570);
		expect((await dimensions(tallData)).height).toBeGreaterThan(8000);
		const images = await captureImages(
			gemini,
			userImages([
				{ type: "image", data: heavyData, mimeType: "image/png" },
				{ type: "image", data: tallData, mimeType: "image/png" },
			]),
		);

		expect(images.map(image => image.data)).toEqual([heavyData, tallData]);
	});
});
