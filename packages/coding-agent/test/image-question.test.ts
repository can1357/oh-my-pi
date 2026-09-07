import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type AssistantMessage, type completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ServiceTierOverrides } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { LoadedImageInput } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { askImageQuestion, resolveImageQuestionModel } from "@oh-my-pi/pi-coding-agent/utils/image-question";
import {
	type DescribeAttachedImagesDeps,
	describeAttachedImagesForTextModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const IMAGE_INPUT: LoadedImageInput = {
	resolvedPath: "screen.png",
	mimeType: "image/png",
	data: TINY_PNG_BASE64,
	textNote: "Read image file [image/png]",
	bytes: Buffer.byteLength(TINY_PNG_BASE64, "base64"),
};

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-5-vision",
	name: "GPT-5 Vision",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128_000,
	maxTokens: 4096,
});

const maxVisionModel: Model<"openai-responses"> = {
	...visionModel,
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
};

const fireworksVisionModel: Model<"openai-completions"> = buildModel({
	id: "kimi-vision",
	name: "Kimi Vision",
	api: "openai-completions",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
});

const textModel: Model<"openai-responses"> = { ...visionModel, id: "gpt-4.1-mini", input: ["text"] };

/** The wire options a vision one-shot actually sends to the provider. */
interface VisionRequestOptions {
	reasoning?: string;
	serviceTier?: string;
}

function createCompleteStub(text: string): { calls: VisionRequestOptions[]; fn: typeof completeSimple } {
	const calls: VisionRequestOptions[] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args[2] as VisionRequestOptions);
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

interface SessionOptions {
	availableModels?: Model[];
	liveServiceTierOverrides?: ServiceTierOverrides;
}

function createSession(settings: Settings, options: SessionOptions = {}): ToolSession {
	const availableModels = options.availableModels ?? [];
	const session: ToolSession = {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		modelRegistry: {
			getAvailable: () => availableModels,
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	};
	if (options.liveServiceTierOverrides) {
		session.getServiceTierOverrides = () => options.liveServiceTierOverrides;
	}
	return session;
}

function settingsWith(overrides: Record<string, string>, visionRole?: string): Settings {
	const settings = Settings.isolated();
	if (visionRole) settings.setModelRole("vision", visionRole);
	if (Object.keys(overrides).length > 0) settings.set("tier.modelOverrides", overrides);
	return settings;
}

async function askVision(settings: Settings, options: SessionOptions = {}): Promise<VisionRequestOptions[]> {
	const stub = createCompleteStub("answer");
	const session = createSession(settings, options);
	const resolved = resolveImageQuestionModel(session);
	await askImageQuestion(session, resolved, IMAGE_INPUT, "What is shown?", undefined, stub.fn);
	return stub.calls;
}

describe("askImageQuestion tier.modelOverrides", () => {
	it("tiers the request with the exact-effort rule when the vision role suffix sends max", async () => {
		const settings = settingsWith({ "openai/gpt-5-vision:max": "priority" }, "openai/gpt-5-vision:max");
		const calls = await askVision(settings, { availableModels: [maxVisionModel] });

		expect(calls).toHaveLength(1);
		// The rule matched the effort this request actually sends, not a hypothetical one.
		expect(calls[0]?.reasoning).toBe("max");
		expect(calls[0]?.serviceTier).toBe("priority");
	});

	it("keeps effort-keyed rules unmatched when the vision role sends no reasoning of its own", async () => {
		const settings = settingsWith({ "openai/gpt-5-vision:max": "priority" }, "openai/gpt-5-vision");
		const calls = await askVision(settings, { availableModels: [visionModel] });

		expect(calls).toHaveLength(1);
		// No own reasoning means no invented max: the request stays untiered instead
		// of borrowing the parent session's effort to activate the rule.
		expect(calls[0]?.reasoning).toBeUndefined();
		expect(calls[0]?.serviceTier).toBeUndefined();
	});

	it("tiers a suffixless request from the base-key rule", async () => {
		const settings = settingsWith({ "openai/gpt-5-vision": "flex" }, "openai/gpt-5-vision");
		const calls = await askVision(settings, { availableModels: [visionModel] });

		expect(calls[0]?.serviceTier).toBe("flex");
	});

	it("prefers the exact-effort entry over the base entry when max is sent", async () => {
		const settings = settingsWith(
			{ "openai/gpt-5-vision": "flex", "openai/gpt-5-vision:max": "priority" },
			"openai/gpt-5-vision:max",
		);
		const calls = await askVision(settings, { availableModels: [maxVisionModel] });

		expect(calls[0]?.reasoning).toBe("max");
		expect(calls[0]?.serviceTier).toBe("priority");
	});

	it("keeps rules naming other providers unmatched", async () => {
		const settings = settingsWith({ "anthropic/claude-opus-4-6": "priority" }, "openai/gpt-5-vision");
		const calls = await askVision(settings, { availableModels: [visionModel] });

		expect(calls[0]?.serviceTier).toBeUndefined();
	});

	it("realizes a matched none as an explicit off", async () => {
		const settings = settingsWith({ "openai/gpt-5-vision": "none" }, "openai/gpt-5-vision");
		const calls = await askVision(settings, { availableModels: [visionModel] });

		expect(calls[0]?.serviceTier).toBeUndefined();
	});

	it("lets a live explicit off from the ToolSession shadow the configured rule", async () => {
		const settings = settingsWith({ "openai/gpt-5-vision": "flex" }, "openai/gpt-5-vision");
		const calls = await askVision(settings, {
			availableModels: [visionModel],
			liveServiceTierOverrides: { openai: null },
		});

		expect(calls[0]?.serviceTier).toBeUndefined();
	});

	it("lets a live override from the ToolSession beat the configured rule", async () => {
		const settings = settingsWith({ "openai/gpt-5-vision": "none" }, "openai/gpt-5-vision");
		const calls = await askVision(settings, {
			availableModels: [visionModel],
			liveServiceTierOverrides: { openai: "priority" },
		});

		expect(calls[0]?.serviceTier).toBe("priority");
	});

	it("leaves family-less providers untiered", async () => {
		const settings = settingsWith({ "fireworks/kimi-vision": "priority" }, "fireworks/kimi-vision");
		const calls = await askVision(settings, { availableModels: [fireworksVisionModel] });

		expect(calls[0]?.serviceTier).toBeUndefined();
	});
});

describe("describeAttachedImagesForTextModel tier.modelOverrides", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-question-tier-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	function makeDeps(
		completeImpl: typeof completeSimple,
		options: { tierOverrides?: Record<string, string>; liveOverrides?: ServiceTierOverrides } = {},
	): DescribeAttachedImagesDeps {
		const settings = Settings.isolated();
		if (options.tierOverrides) settings.set("tier.modelOverrides", options.tierOverrides);
		return {
			activeModel: textModel,
			modelRegistry: {
				getAvailable: () => [textModel, visionModel],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			} as unknown as DescribeAttachedImagesDeps["modelRegistry"],
			settings,
			localProtocolOptions: { getArtifactsDir: () => testDir, getSessionId: () => "test-session" },
			activeModelString: `${textModel.provider}/${textModel.id}`,
			serviceTierOverrides: options.liveOverrides,
			completeImpl,
		};
	}

	it("tiers the describe request from the base-key rule", async () => {
		const stub = createCompleteStub("A red balloon.");
		await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(stub.fn, { tierOverrides: { "openai/gpt-5-vision": "flex" } }),
		);

		expect(stub.calls).toHaveLength(1);
		// Describe requests never send a reasoning option; the tier still applies.
		expect(stub.calls[0]?.reasoning).toBeUndefined();
		expect(stub.calls[0]?.serviceTier).toBe("flex");
	});

	it("keeps effort-keyed rules unmatched while no reasoning is sent", async () => {
		const stub = createCompleteStub("A red balloon.");
		await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(stub.fn, { tierOverrides: { "openai/gpt-5-vision:max": "priority" } }),
		);

		expect(stub.calls[0]?.serviceTier).toBeUndefined();
	});

	it("honors the live override threaded from the source host", async () => {
		const stub = createCompleteStub("A red balloon.");
		await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(stub.fn, {
				tierOverrides: { "openai/gpt-5-vision": "none" },
				liveOverrides: { openai: "priority" },
			}),
		);

		expect(stub.calls[0]?.serviceTier).toBe("priority");
	});
});
