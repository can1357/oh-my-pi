import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import {
	CustomProviderForm,
	type CustomProviderFormOptions,
	type CustomProviderFormValues,
} from "@oh-my-pi/pi-tui/setup/scenes/custom-provider";
import { providersSetupScene } from "@oh-my-pi/pi-tui/setup/scenes/sign-in";
import type { SetupSceneHost, SetupSceneResult, SetupSceneController } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

function createForm(
	addCustomProvider: SetupSceneHost["ctx"]["addCustomProvider"],
	options?: CustomProviderFormOptions,
) {
	const finished: SetupSceneResult[] = [];
	let focusTarget: Component | null = null;
	let restoreFocusCalls = 0;
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
			restoreFocusCalls++;
		},
	} as unknown as SetupSceneHost;
	return {
		form: new CustomProviderForm(host, addCustomProvider!, undefined, options),
		finished,
		get focusTarget() {
			return focusTarget;
		},
		get restoreFocusCalls() {
			return restoreFocusCalls;
		},
	};
}

function enter(form: CustomProviderForm, value: string): void {
	for (const char of value) form.handleInput(char);
	form.handleInput("\n");
}

/** Drain the submit's promise chain by yielding one macrotask, instead of counting microtask turns. */
async function waitForSubmit(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
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

	it("opens the custom endpoint form from the sign-in provider list and returns on Esc", () => {
		const authStorage = {
			credentials: { has: () => false },
			keys: { source: () => undefined },
			oauth: { login: async () => {} },
		};
		const host = {
			ctx: {
				authStorage,
				disabledProviders: [],
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

	describe("edit mode", () => {
		const edit = { id: "my-gw", baseUrl: "https://gateway.example/v1", hasKey: true };

		it("prefills the URL and never exposes the ID input", async () => {
			const submit = vi.fn(async () => {});
			const { form, finished } = createForm(submit, { edit: { ...edit, hasKey: false } });
			form.onActivate?.();

			const shown = Bun.stripANSI(form.render(120).join("\n"));
			expect(shown).toContain("Edit provider my-gw");
			expect(shown).toContain("https://gateway.example/v1");
			expect(shown).not.toContain("Provider ID");

			for (const char of "/x") form.handleInput(char);
			form.handleInput("\n");
			form.handleInput("\n");
			await waitForSubmit();

			expect(submit).toHaveBeenCalledWith({ id: "my-gw", baseUrl: "https://gateway.example/v1/x", apiKey: "" });
			expect(finished).toEqual(["done"]);
		});

		it("says a blank key keeps the current key", () => {
			const { form } = createForm(async () => {}, { edit });
			form.onActivate?.();
			form.handleInput("\n");
			expect(Bun.stripANSI(form.render(120).join("\n"))).toContain("API key (blank keeps current key)");
		});

		it("ctrl+x on the key field clears the stored key on save", async () => {
			const submit = vi.fn(async () => {});
			const { form } = createForm(submit, { edit });
			form.onActivate?.();
			form.handleInput("\n");
			form.handleInput("\x18");

			const shown = Bun.stripANSI(form.render(120).join("\n"));
			expect(shown).toContain("Stored key will be cleared on save.");
			expect(shown).toContain("Ctrl+X clear key");

			form.handleInput("\n");
			await waitForSubmit();
			expect(submit).toHaveBeenCalledWith({
				id: "my-gw",
				baseUrl: "https://gateway.example/v1",
				apiKey: "",
				clearApiKey: true,
			});
		});

		it("typing a new key cancels a pending clear", async () => {
			const submit = vi.fn(async () => {});
			const { form } = createForm(submit, { edit });
			form.onActivate?.();
			form.handleInput("\n");
			form.handleInput("\x18");
			for (const char of "new-key") form.handleInput(char);

			expect(Bun.stripANSI(form.render(120).join("\n"))).not.toContain("Stored key will be cleared");
			form.handleInput("\n");
			await waitForSubmit();
			expect(submit).toHaveBeenCalledWith({ id: "my-gw", baseUrl: "https://gateway.example/v1", apiKey: "new-key" });
		});

		it("offers no key clearing when no key is stored", () => {
			const { form } = createForm(async () => {}, { edit: { ...edit, hasKey: false } });
			form.onActivate?.();
			form.handleInput("\n");
			form.handleInput("\x18");
			const shown = Bun.stripANSI(form.render(120).join("\n"));
			expect(shown).not.toContain("Ctrl+X");
			expect(shown).not.toContain("Stored key will be cleared");
		});

		it("returns to the URL step, not the fixed ID, when a save fails", async () => {
			const submit = vi.fn(async () => {
				throw new Error("No chat models were discovered.");
			});
			const { form } = createForm(submit, { edit });
			form.onActivate?.();
			form.handleInput("\n"); // URL → key
			form.handleInput("\n"); // submit
			await waitForSubmit();

			const shown = Bun.stripANSI(form.render(120).join("\n"));
			expect(shown).toContain("No chat models were discovered.");
			expect(shown).toContain("Endpoint URL");
			expect(shown).not.toContain("Provider ID");
		});

		it("does not clear the stored key on a retry after a failed save that had queued the clear", async () => {
			const submit = vi
				.fn<(values: CustomProviderFormValues) => Promise<void>>()
				.mockRejectedValueOnce(new Error("endpoint unreachable"))
				.mockResolvedValue(undefined);
			const { form } = createForm(submit, { edit });
			form.onActivate?.();
			form.handleInput("\n");
			form.handleInput("\x18"); // queue the clear
			form.handleInput("\n"); // submit; it fails
			await waitForSubmit();
			expect(Bun.stripANSI(form.render(120).join("\n"))).toContain("endpoint unreachable");

			form.handleInput("\n"); // URL → key; the queued clear is no longer announced
			expect(Bun.stripANSI(form.render(120).join("\n"))).not.toContain("Stored key will be cleared");
			form.handleInput("\n"); // retry with a blank key
			await waitForSubmit();
			expect(submit).toHaveBeenCalledTimes(2);
			expect(submit).toHaveBeenLastCalledWith({ id: "my-gw", baseUrl: "https://gateway.example/v1", apiKey: "" });
		});

		it.each([
			["resolves", (gate: PromiseWithResolvers<void>) => gate.resolve()],
			["rejects", (gate: PromiseWithResolvers<void>) => gate.reject(new Error("late failure"))],
		])(
			"Esc during a save leaves the form once, and a save that later %s reports nothing back",
			async (_settled, finishSave) => {
				const gate = Promise.withResolvers<void>();
				const { form, finished } = createForm(() => gate.promise, { edit });
				form.onActivate?.();
				form.handleInput("\n");
				form.handleInput("\n"); // submit
				expect(form.modal).toBe(true);

				form.handleInput("\x1b");
				form.handleInput("\x1b");
				expect(finished).toEqual(["skipped"]);

				finishSave(gate);
				await waitForSubmit();
				expect(finished).toEqual(["skipped"]);
				expect(form.modal).toBe(false);
			},
		);

		it("a save that fails after Esc does not take focus back from whatever replaced the form", async () => {
			const gate = Promise.withResolvers<void>();
			const state = createForm(() => gate.promise, { edit });
			state.form.onActivate?.();
			state.form.handleInput("\n");
			state.form.handleInput("\n"); // submit
			state.form.handleInput("\x1b");
			const focusRestoresBefore = state.restoreFocusCalls;

			gate.reject(new Error("late failure"));
			await waitForSubmit();
			expect(state.restoreFocusCalls).toBe(focusRestoresBefore);
		});
	});
});
