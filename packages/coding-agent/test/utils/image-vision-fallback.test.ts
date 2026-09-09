import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, completeSimple, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type DescribeAttachedImagesDeps,
	describeAttachedImagesForTextModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const textModel: Model<"openai-responses"> = { ...visionModel, id: "gpt-4.1-mini", input: ["text"] };

function makeCompleteStub(text: string): { calls: unknown[][]; fn: typeof completeSimple } {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text }],
		} satisfies AssistantMessage;
	}) as typeof completeSimple;
	return { calls, fn };
}

function makeDeps(
	artifactsDir: string,
	available: Model<"openai-responses">[],
	completeImpl: typeof completeSimple,
	apiKey: string | undefined = "test-key",
): DescribeAttachedImagesDeps {
	return {
		activeModel: textModel,
		modelRegistry: {
			getAvailable: () => available,
			getApiKey: async () => apiKey,
			resolver: () => async () => apiKey,
		} as unknown as DescribeAttachedImagesDeps["modelRegistry"],
		settings: Settings.isolated(),
		localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "test-session" },
		activeModelString: `${textModel.provider}/${textModel.id}`,
		completeImpl,
	};
}

describe("describeAttachedImagesForTextModel", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-fallback-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("saves the image under local:// and injects a vision description block", async () => {
		const stub = makeCompleteStub("A man holding a red balloon.");
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel, visionModel], stub.fn),
		);

		expect(blocks).toHaveLength(1);
		const text = blocks[0]!.text;
		// Block wraps the local:// path and the description.
		const match = text.match(/^<image path="(local:\/\/[^"]+\.png)">\n([\s\S]*)\n<\/image>$/);
		expect(match).not.toBeNull();
		expect(match![2]).toBe("A man holding a red balloon.");

		// The vision model was actually consulted.
		expect(stub.calls).toHaveLength(1);

		// The image was persisted under <artifactsDir>/local and round-trips.
		const fileName = match![1].slice("local://".length);
		const saved = await fs.readFile(path.join(testDir, "local", fileName));
		expect(saved.toString("base64")).toBe(TINY_PNG_BASE64);
	});

	it("saves the image but emits a no-vision note when no vision model is available", async () => {
		const stub = makeCompleteStub("should not be used");
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel], stub.fn),
		);

		expect(blocks).toHaveLength(1);
		// No vision-capable model -> no model call, but a note + saved artifact.
		expect(stub.calls).toHaveLength(0);
		expect(blocks[0]!.text).toContain("No vision-capable model");

		const match = blocks[0]!.text.match(/path="local:\/\/([^"]+)"/);
		expect(match).not.toBeNull();
		const saved = await fs.readFile(path.join(testDir, "local", match![1]));
		expect(saved.toString("base64")).toBe(TINY_PNG_BASE64);
	});

	it("falls back to a note when the vision model returns no text", async () => {
		const stub = makeCompleteStub("   ");
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel, visionModel], stub.fn),
		);

		expect(stub.calls).toHaveLength(1);
		expect(blocks[0]!.text).toContain("Image description unavailable");
	});

	it("is content-addressed: identical images reuse one saved file path", async () => {
		const image = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" } as const;
		const stub = makeCompleteStub("desc");
		const blocks = await describeAttachedImagesForTextModel(
			[image, image],
			makeDeps(testDir, [textModel, visionModel], stub.fn),
		);

		const paths = blocks.map(b => b.text.match(/path="(local:\/\/[^"]+)"/)![1]);
		expect(paths[0]).toBe(paths[1]);
	});
});
