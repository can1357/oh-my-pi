import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	availableCodeModels,
	resolveCodeModelLanguage,
	resolveCodeModelSelection,
	runCodeModelMenu,
	saveCodeModelSelection,
} from "../src/code-model/model-menu";
import type { Settings } from "../src/config/settings";
import type { ExtensionCommandContext, ExtensionContext } from "../src/extensibility/extensions/types";
import { AUTO_THINKING } from "../src/thinking";

function model(provider: string, id: string, options: { text?: boolean; tools?: boolean } = {}): Model {
	return {
		provider,
		id,
		name: id,
		input: options.text === false ? ["image"] : ["text"],
		supportsTools: options.tools,
		thinking: { mode: "openai", efforts: ["low", "high"] },
	} as unknown as Model;
}

function settingsStub(initial: string | undefined, scope: "global" | "project" = "global") {
	let value = initial;
	const writes: Array<{ scope: string; value: string }> = [];
	const settings = {
		get(key: string) {
			return key === "modelRoleStorage" ? scope : undefined;
		},
		getModelRole(role: string) {
			return role === "code" ? value : undefined;
		},
		setModelRole(_role: string, next: string) {
			value = next;
			writes.push({ scope: "global", value: next });
		},
		setProjectModelRole(_role: string, next: string) {
			value = next;
			writes.push({ scope: "project", value: next });
		},
		async flush() {},
	} as unknown as Settings;
	return {
		settings,
		writes,
		replace(next: string) {
			value = next;
		},
	};
}

describe("code-model menu configuration", () => {
	it("selects the menu language from the locale", () => {
		expect(resolveCodeModelLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
		expect(resolveCodeModelLanguage({ LANG: "en_GB.UTF-8" })).toBe("en");
	});

	it("lists authenticated text-and-tool-capable models once in stable order", () => {
		const models = [
			model("zeta", "b"),
			model("alpha", "a"),
			model("alpha", "a"),
			model("alpha", "image", { text: false }),
			model("alpha", "chat", { tools: false }),
		];
		const ctx = { models: { list: () => models } } as unknown as Pick<ExtensionContext, "models">;
		expect(availableCodeModels(ctx).map(item => `${item.provider}/${item.id}`)).toEqual(["alpha/a", "zeta/b"]);
	});

	it("resolves the native code role and its explicit effort", () => {
		const coding = model("provider", "coder");
		const { settings } = settingsStub("provider/coder:high");
		const selected = resolveCodeModelSelection(settings, [coding]);
		expect(selected?.model).toBe(coding);
		expect(selected?.effort).toBe(ThinkingLevel.High);
	});

	it("uses auto when the role has no explicit effort", () => {
		const coding = model("provider", "coder");
		const { settings } = settingsStub("provider/coder");
		expect(resolveCodeModelSelection(settings, [coding])?.effort).toBe(AUTO_THINKING);
	});

	it("persists the combined model selector in the configured scope", async () => {
		const coding = model("provider", "coder");
		const { settings, writes } = settingsStub(undefined, "project");
		await saveCodeModelSelection(settings, { model: coding, effort: ThinkingLevel.High }, undefined);
		expect(writes).toEqual([{ scope: "project", value: "provider/coder:high" }]);
	});

	it("detects a same-role concurrent edit before saving", async () => {
		const coding = model("provider", "coder");
		const state = settingsStub("provider/old:low");
		state.replace("provider/new:high");
		await expect(
			saveCodeModelSelection(state.settings, { model: coding, effort: ThinkingLevel.High }, "provider/old:low"),
		).rejects.toThrow("CODE_MODEL_CONFIG_CONFLICT");
		expect(state.writes).toEqual([]);
	});
	it("persists the scripted Provider, Model, Effort and Save flow", async () => {
		const coding = model("provider", "coder");
		const state = settingsStub(undefined);
		const choices: Array<string | undefined> = [
			"Provider",
			"provider",
			"Model",
			"provider/coder",
			"Effort",
			"high",
			"Save and Apply",
		];
		const previousLanguage = process.env.CODE_MODEL_LANG;
		process.env.CODE_MODEL_LANG = "en";
		try {
			const ctx = {
				hasUI: true,
				models: { list: () => [coding] },
				ui: {
					async select() {
						const choice = choices.shift();
						if (choice === "Save and Apply") expect(state.writes).toEqual([]);
						return choice;
					},
					notify() {},
				},
			} as unknown as ExtensionCommandContext;
			await runCodeModelMenu("", ctx, state.settings);
		} finally {
			if (previousLanguage === undefined) delete process.env.CODE_MODEL_LANG;
			else process.env.CODE_MODEL_LANG = previousLanguage;
		}
		expect(choices).toEqual([]);
		expect(state.writes).toEqual([{ scope: "global", value: "provider/coder:high" }]);
	});

	it("leaves storage unchanged when Escape closes a staged menu", async () => {
		const coding = model("provider", "coder");
		const state = settingsStub(undefined);
		const choices: Array<string | undefined> = ["Provider", "provider", undefined];
		const previousLanguage = process.env.CODE_MODEL_LANG;
		process.env.CODE_MODEL_LANG = "en";
		try {
			const ctx = {
				hasUI: true,
				models: { list: () => [coding] },
				ui: {
					async select() {
						return choices.shift();
					},
					notify() {},
				},
			} as unknown as ExtensionCommandContext;
			await runCodeModelMenu("", ctx, state.settings);
		} finally {
			if (previousLanguage === undefined) delete process.env.CODE_MODEL_LANG;
			else process.env.CODE_MODEL_LANG = previousLanguage;
		}
		expect(state.writes).toEqual([]);
	});
});
