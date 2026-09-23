import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { CustomProviderForm } from "@oh-my-pi/pi-tui/setup/scenes/custom-provider";
import { providersSetupScene } from "@oh-my-pi/pi-tui/setup/scenes/providers";
import type { SetupSceneHost, SetupSceneResult, SetupSceneController } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

function createForm(addCustomProvider: SetupSceneHost["ctx"]["addCustomProvider"]) {
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
		form: new CustomProviderForm(host, addCustomProvider!),
		finished,
		get focusTarget() {
			return focusTarget;
		},
	};
}

function enter(form: CustomProviderForm, value: string): void {
	for (const char of value) form.handleInput(char);
	form.handleInput("\n");
}

async function waitForSubmit(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("CustomProviderForm", () => {
	it("collects an OpenAI-compatible endpoint, masks its key, and advances after saving", async () => {
		const addCustomProvider = vi.fn(async () => {});
		const state = createForm(addCustomProvider);
		const { form, finished } = state;
		form.onActivate?.();
		enter(form, "my-gateway");
		enter(form, "https://gateway.example/v1/");
		for (const char of "top-secret") form.handleInput(char);

		expect(state.focusTarget).toBeNull();
		expect(Bun.stripANSI(form.render(120).join("\n"))).not.toContain("top-secret");
		form.handleInput("\n");
		await waitForSubmit();

		expect(addCustomProvider).toHaveBeenCalledWith({
			id: "my-gateway",
			baseUrl: "https://gateway.example/v1/",
			apiKey: "top-secret",
		});
		expect(finished).toEqual(["done"]);
	});

	it("shows custom endpoint in the sign-in provider list and keeps tabs reachable from its form", () => {
		const authStorage = {
			credentials: { has: () => false },
			keys: { source: () => undefined },
			oauth: { login: async () => {} },
		};
		const host = {
			ctx: {
				authStorage,
				disabledProviders: [],
				webSearchOrder: ["auto"],
				isSearchProviderAvailable: async () => true,
				addCustomProvider: async () => {},
			},
			requestRender() {},
			finish() {},
			setFocus() {},
			restoreFocus() {},
		} as unknown as SetupSceneHost;
		const scene = providersSetupScene.mount(host) as SetupSceneController;
		const send = (data: string) => scene.handleInput?.(data);
		try {
			scene.onMount?.();
			for (let i = 0; i < getOAuthProviders().length; i++) send("\x1b[B");
			send("\n");
			expect(Bun.stripANSI(scene.render(120).join("\n"))).toContain("Provider ID");
			send("\x1b[D");
			send("\x1b[C");
			expect(Bun.stripANSI(scene.render(120).join("\n"))).toContain("Provider ID");

			send("\t");
			expect(Bun.stripANSI(scene.render(120).join("\n"))).toContain(
				"Choose the provider the web_search tool should prefer.",
			);
			send("\x1b[Z");
			expect(Bun.stripANSI(scene.render(120).join("\n"))).toContain("Provider ID");
			send("\x1b");
			expect(Bun.stripANSI(scene.render(120).join("\n"))).toContain("Select provider to login");
		} finally {
			scene.dispose?.();
		}
	});

	it("hides the custom endpoint action when the host does not support it", () => {
		const host = {
			ctx: {
				authStorage: { credentials: { has: () => false }, keys: { source: () => undefined } },
				disabledProviders: [],
				webSearchOrder: ["auto"],
			},
			requestRender() {},
			finish() {},
			setFocus() {},
			restoreFocus() {},
		} as unknown as SetupSceneHost;
		const scene = providersSetupScene.mount(host);
		try {
			expect(Bun.stripANSI(scene.render(120).join("\n"))).not.toContain("Custom endpoint…");
		} finally {
			scene.dispose?.();
		}
	});

	it("explains how to continue when the provider ID is already configured", async () => {
		const addCustomProvider = vi.fn(async () => {
			throw new Error('Provider "my-gateway" is already configured.');
		});
		const { form, finished } = createForm(addCustomProvider);
		form.onActivate?.();
		enter(form, "my-gateway");
		enter(form, "https://gateway.example/v1");
		enter(form, "top-secret");
		await waitForSubmit();

		const message = Bun.stripANSI(form.render(120).join("\n"));
		expect(message).toContain("already configured");
		expect(message).toContain("Press Esc to return to the provider list");
		form.handleInput("\x1b");
		expect(finished).toEqual(["skipped"]);
	});
});
