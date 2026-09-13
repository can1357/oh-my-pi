import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { renderProviderModels } from "@oh-my-pi/pi-coding-agent/cli/models-cli";

afterEach(() => {
	vi.restoreAllMocks();
});

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeModel(spec: {
	id: string;
	api: Api;
	compat?: ModelSpec["compat"];
	input?: readonly ("text" | "image")[];
	transport?: ModelSpec["transport"];
}) {
	return buildModel({
		id: spec.id,
		name: spec.id,
		api: spec.api,
		provider: "myproxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input: (spec.input ?? ["text", "image"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat: spec.compat,
		transport: spec.transport,
	} as ModelSpec);
}

/** Render one model through `omp models ls` and return its `images` cell. */
function imagesCell(model: Model<Api>): string {
	const output: string[] = [];
	spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	renderProviderModels({ getAvailable: () => [model], getError: () => undefined }, "ls", undefined, false);
	vi.restoreAllMocks();

	const row = stripAnsi(output.join(""))
		.split("\n")
		.find(line => line.includes(model.id));
	if (!row) throw new Error(`no listing row rendered for ${model.id}`);
	const cells = row
		.split("│")
		.map(cell => cell.trim())
		.filter(cell => cell.length > 0);
	return cells.at(-1) ?? "";
}

describe("omp models image support column", () => {
	it("reports wire truth for a DeepSeek-class id served by a proxy that accepts images", () => {
		// The catalog strips images for the DeepSeek class on any provider, so the
		// listing must not advertise the declared `input: [text, image]`.
		expect(imagesCell(makeModel({ id: "deepseek-v4-flash", api: "openai-completions" }))).toBe("no");
	});

	it("reports images once the model opts out with compat.stripImageInput", () => {
		expect(
			imagesCell(
				makeModel({
					id: "deepseek-v4-flash",
					api: "openai-completions",
					compat: { stripImageInput: false },
				}),
			),
		).toBe("yes");
	});

	it("keeps the declared modalities on APIs without the text-only guard", () => {
		expect(imagesCell(makeModel({ id: "claude-sonnet-4-6", api: "anthropic-messages" }))).toBe("yes");
	});

	it("keeps declared text-only models at no", () => {
		expect(imagesCell(makeModel({ id: "text-only-model", api: "openai-completions", input: ["text"] }))).toBe("no");
	});

	it("strips images on the OpenRouter chat fallback", () => {
		// PI_OPENROUTER_RESPONSES=0 dispatches openrouter models through
		// streamOpenAICompletions, so the Chat Completions guard applies.
		const previous = Bun.env.PI_OPENROUTER_RESPONSES;
		Bun.env.PI_OPENROUTER_RESPONSES = "0";
		try {
			expect(imagesCell(makeModel({ id: "deepseek-v4-flash", api: "openrouter" }))).toBe("no");
		} finally {
			if (previous === undefined) delete Bun.env.PI_OPENROUTER_RESPONSES;
			else Bun.env.PI_OPENROUTER_RESPONSES = previous;
		}
	});

	it("honours the strip opt-out on the OpenRouter chat fallback", () => {
		const previous = Bun.env.PI_OPENROUTER_RESPONSES;
		Bun.env.PI_OPENROUTER_RESPONSES = "0";
		try {
			expect(
				imagesCell(
					makeModel({
						id: "deepseek-v4-flash",
						api: "openrouter",
						compat: { stripImageInput: false },
					}),
				),
			).toBe("yes");
		} finally {
			if (previous === undefined) delete Bun.env.PI_OPENROUTER_RESPONSES;
			else Bun.env.PI_OPENROUTER_RESPONSES = previous;
		}
	});

	it("reports declared input on the OpenRouter Responses path", () => {
		// The default Responses transport ignores stripImageInput (openai-shared
		// derives supportsImages from the declared input), so the column must too.
		const previous = Bun.env.PI_OPENROUTER_RESPONSES;
		delete Bun.env.PI_OPENROUTER_RESPONSES;
		try {
			expect(imagesCell(makeModel({ id: "deepseek-v4-flash", api: "openrouter" }))).toBe("yes");
		} finally {
			if (previous === undefined) delete Bun.env.PI_OPENROUTER_RESPONSES;
			else Bun.env.PI_OPENROUTER_RESPONSES = previous;
		}
	});
	it("forwards declared images on the pi-native transport despite the strip rule", () => {
		// pi-native short-circuits to streamPiNative before the Chat Completions
		// encoder, so compat.stripImageInput never runs client-side.
		expect(
			imagesCell(makeModel({ id: "deepseek-v4-flash", api: "openai-completions", transport: "pi-native" })),
		).toBe("yes");
	});

	it("keeps declared text-only pi-native models at no", () => {
		expect(
			imagesCell(
				makeModel({ id: "text-only-model", api: "openai-completions", input: ["text"], transport: "pi-native" }),
			),
		).toBe("no");
	});
});
