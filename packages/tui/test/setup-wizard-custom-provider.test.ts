import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { CustomProviderTab } from "@oh-my-pi/pi-tui/setup/scenes/custom-provider";
import type { SetupSceneHost, SetupSceneResult } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

function createTab(addCustomProvider: SetupSceneHost["ctx"]["addCustomProvider"]) {
	const finished: SetupSceneResult[] = [];
	let focusTarget: Component | null = null;
	const host = {
		ctx: { addCustomProvider },
		requestRender() {},
		finish(result: SetupSceneResult) {
			finished.push(result);
		},
		setFocus(component: Component | null) {
			focusTarget = component;
		},
		restoreFocus() {
			focusTarget = null;
		},
	} as unknown as SetupSceneHost;
	return {
		tab: new CustomProviderTab(host),
		finished,
		get focusTarget() {
			return focusTarget;
		},
	};
}

function enter(tab: CustomProviderTab, value: string): void {
	for (const char of value) tab.handleInput(char);
	tab.handleInput("\n");
}

async function waitForSubmit(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("CustomProviderTab", () => {
	it("collects an OpenAI-compatible endpoint, masks its key, and advances after saving", async () => {
		const addCustomProvider = vi.fn(async () => {});
		const state = createTab(addCustomProvider);
		const { tab, finished } = state;
		tab.onActivate?.();
		enter(tab, "my-gateway");
		enter(tab, "https://gateway.example/v1/");
		for (const char of "top-secret") tab.handleInput(char);

		expect(state.focusTarget).toBeDefined();
		expect(Bun.stripANSI(tab.render(120).join("\n"))).not.toContain("top-secret");
		tab.handleInput("\n");
		await waitForSubmit();

		expect(addCustomProvider).toHaveBeenCalledWith({
			id: "my-gateway",
			baseUrl: "https://gateway.example/v1/",
			apiKey: "top-secret",
		});
		expect(finished).toEqual(["done"]);
	});

	it("explains how to continue when the provider ID is already configured", async () => {
		const addCustomProvider = vi.fn(async () => {
			throw new Error('Provider "my-gateway" is already configured.');
		});
		const { tab, finished } = createTab(addCustomProvider);
		tab.onActivate?.();
		enter(tab, "my-gateway");
		enter(tab, "https://gateway.example/v1");
		enter(tab, "top-secret");
		await waitForSubmit();

		const message = Bun.stripANSI(tab.render(120).join("\n"));
		expect(message).toContain("already configured");
		expect(message).toContain("Press Esc to continue to model selection");
		tab.handleInput("\x1b");
		expect(finished).toEqual(["skipped"]);
	});
});
