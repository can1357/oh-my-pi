import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function makeModel(id: string, metadata: Partial<Pick<Model, "kind" | "webSearch">> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider: "fixture",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
		...metadata,
	});
}

const chat = makeModel("chat");
const explicitChat = makeModel("explicit-chat", { kind: "chat" });
const groundedChat = makeModel("grounded-chat", { webSearch: "gemini" });
const tiny = makeModel("tiny", { kind: "tiny" });
const image = makeModel("image", { kind: "image" });
const search = makeModel("search", { kind: "search" });
const speech = makeModel("speech", { kind: "tts" });
const dictation = makeModel("dictation", { kind: "stt" });
const judge = makeModel("judge", { kind: "judge" });
const fixtures = [chat, explicitChat, groundedChat, tiny, image, search, speech, dictation, judge];

function acceptedIds(role: string, settings: Settings): string[] {
	return fixtures.filter(getRoleInfo(role, settings).accepts).map(model => model.id);
}

describe("getRoleInfo", () => {
	test("built-in roles accept models by capability", () => {
		const settings = Settings.isolated({});

		expect(acceptedIds("default", settings)).toEqual(["chat", "explicit-chat", "grounded-chat"]);
		expect(acceptedIds("tiny", settings)).toEqual(["chat", "explicit-chat", "grounded-chat", "tiny"]);
		expect(acceptedIds("memory", settings)).toEqual(["chat", "explicit-chat", "grounded-chat", "tiny"]);
		expect(acceptedIds("image", settings)).toEqual(["image"]);
		expect(acceptedIds("web", settings)).toEqual(["grounded-chat", "search"]);
		expect(acceptedIds("speech", settings)).toEqual(["speech"]);
		expect(acceptedIds("dictation", settings)).toEqual(["dictation"]);
		expect(acceptedIds("judge", settings)).toEqual(["chat", "explicit-chat", "grounded-chat", "tiny", "judge"]);
	});

	test("custom metadata overrides presentation without widening model acceptance", () => {
		const settings = Settings.isolated({
			modelTags: {
				smol: { name: "My Smol", color: "success", hidden: true },
				custom: { name: "My Custom Tag", color: "error", hidden: true },
			},
		});

		const smol = getRoleInfo("smol", settings);
		expect(smol).toMatchObject({ name: "My Smol", color: "success", hidden: true, section: "chat" });
		expect(fixtures.filter(smol.accepts)).toEqual([chat, explicitChat, groundedChat]);

		const custom = getRoleInfo("custom", settings);
		expect(custom).toMatchObject({ name: "My Custom Tag", color: "error", hidden: true, section: "chat" });
		expect(fixtures.filter(custom.accepts)).toEqual([chat, explicitChat, groundedChat]);
	});

	test("kind roles remain in the kind section when their presentation is overridden", () => {
		const settings = Settings.isolated({
			modelTags: {
				image: { name: "Pictures", color: "warning" },
			},
		});

		const info = getRoleInfo("image", settings);
		expect(info).toMatchObject({ name: "Pictures", color: "warning", section: "kind" });
		expect(fixtures.filter(info.accepts)).toEqual([image]);
	});
});
