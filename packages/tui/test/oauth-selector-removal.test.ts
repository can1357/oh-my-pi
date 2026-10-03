import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import * as oauthRegistry from "@oh-my-pi/pi-ai/oauth";
import { OAuthSelectorComponent, type OAuthSelectorAuthSource } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../src/native/node";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function provider(id?: string) {
	const found =
		getOAuthProviders().find(candidate => candidate.id === id) ??
		(id === undefined ? getOAuthProviders().find(candidate => candidate.available) : undefined);
	if (!found) throw new Error(`OAuth provider fixture not found: ${id ?? "available provider"}`);
	return found;
}

function authSource(
	options: {
		saved?: readonly string[];
		source?: (providerId: string) => { kind: string; envVar?: string } | undefined;
	} = {},
): OAuthSelectorAuthSource {
	const saved = new Set(options.saved ?? []);
	return {
		credentials: { has: (providerId: string) => saved.has(providerId) },
		keys: {
			source: (providerId: string) =>
				options.source
					? options.source(providerId)
					: saved.has(providerId)
						? { kind: "api_key", concrete: true }
						: undefined,
		},
	} as unknown as OAuthSelectorAuthSource;
}

function makeSelector(
	storage: OAuthSelectorAuthSource,
	onRemove?: (providerId: string) => Promise<void>,
	onSelect: (providerId: string) => void = () => {},
	onCancel: () => void = () => {},
	validateAuth?: (providerId: string) => Promise<boolean>,
): OAuthSelectorComponent {
	return new OAuthSelectorComponent("login", storage, onSelect, onCancel, { onRemove, validateAuth });
}

function search(selector: OAuthSelectorComponent, query: string): void {
	for (const character of query) selector.handleInput(character);
}

function rendered(selector: OAuthSelectorComponent): string {
	return selector
		.render(100)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function findPicker(children: readonly NativeChild[] | undefined): NativeNode | undefined {
	for (const child of children ?? []) {
		if (!("k" in child)) continue;
		if (child.k === "picker") return child;
		const nested = findPicker(child.c);
		if (nested) return nested;
	}
	return undefined;
}

const pickerContext: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "picker",
	feature: () => true,
};

function pickerActionEvent(act: string): NativeUiEvent {
	return { type: "action", key: "picker", act, mods: [] };
}

describe("OAuthSelectorComponent saved-credential removal", () => {
	it("requires confirmation before removing all saved credentials instead of signing in", async () => {
		const target = provider();
		const removed: string[] = [];
		const selected: string[] = [];
		const selector = makeSelector(
			authSource({ saved: [target.id] }),
			async providerId => {
				removed.push(providerId);
			},
			providerId => selected.push(providerId),
		);
		search(selector, target.id);

		selector.handleInput("\x12");
		expect(rendered(selector)).toContain("Remove all saved credentials");
		expect(rendered(selector)).toContain("every saved account and API key");
		expect(removed).toEqual([]);
		expect(selected).toEqual([]);

		selector.handleInput("\n");
		await Promise.resolve();
		expect(removed).toEqual([target.storeCredentialsAs ?? target.id]);
		expect(selected).toEqual([]);
	});

	it("cancels the confirmation without closing the provider list", () => {
		const target = provider();
		const removed: string[] = [];
		const selected: string[] = [];
		let cancelled = 0;
		const selector = makeSelector(
			authSource({ saved: [target.id] }),
			async providerId => {
				removed.push(providerId);
			},
			providerId => selected.push(providerId),
			() => cancelled++,
		);
		search(selector, target.id);
		selector.handleInput("\x12");
		selector.handleInput("\x1b");

		expect(rendered(selector)).not.toContain("Remove all saved credentials");
		expect(removed).toEqual([]);
		expect(cancelled).toBe(0);

		selector.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});

	it("filters to the provider before capturing its deletion target", async () => {
		const target = provider("opencode-go");
		const removed: string[] = [];
		const selector = makeSelector(authSource({ saved: [target.id] }), async id => void removed.push(id));
		search(selector, target.id);
		selector.handleInput("\x12");
		selector.handleInput("\n");
		await Promise.resolve();

		expect(removed).toEqual(["opencode-go"]);
	});

	it("removes credentials from the canonical provider for an alias login", async () => {
		const alias = getOAuthProviders().find(candidate => candidate.storeCredentialsAs !== undefined);
		if (!alias?.storeCredentialsAs) throw new Error("OAuth alias fixture not found");
		const removed: string[] = [];
		const selector = makeSelector(
			authSource({ saved: [alias.storeCredentialsAs] }),
			async id => void removed.push(id),
		);
		search(selector, alias.id);
		selector.handleInput("\x12");

		expect(rendered(selector)).toContain(alias.storeCredentialsAs);
		selector.handleInput("\n");
		await Promise.resolve();
		expect(removed).toEqual([alias.storeCredentialsAs]);
	});

	it("allows removing saved credentials when the provider cannot currently sign in", async () => {
		const unavailable = { ...provider("opencode-go"), available: false };
		vi.spyOn(oauthRegistry, "getOAuthProviders").mockReturnValue([unavailable]);
		const removed: string[] = [];
		const selector = makeSelector(authSource({ saved: [unavailable.id] }), async id => void removed.push(id));

		expect(rendered(selector)).toContain(unavailable.name);
		expect(rendered(selector)).toContain("remove saved credentials");
		selector.handleInput("\x12");
		selector.handleInput("\n");
		await Promise.resolve();

		expect(removed).toEqual(["opencode-go"]);
	});

	it("does not offer removal for an environment-only provider", () => {
		let removals = 0;
		const selector = makeSelector(
			authSource({
				source: id => (id === "opencode-go" ? { kind: "env", envVar: "OPENCODE_GO_API_KEY" } : undefined),
			}),
			async () => {
				removals++;
			},
		);
		search(selector, "opencode-go");
		expect(rendered(selector)).not.toContain("remove saved credentials");
		selector.handleInput("\x12");

		expect(rendered(selector)).not.toContain("No saved credentials");
		expect(rendered(selector)).not.toContain("Remove all saved credentials");
		expect(removals).toBe(0);
	});

	it("shows the shortcut and native action only when the highlighted provider has stored credentials", () => {
		const target = provider("opencode-go");
		const first = getOAuthProviders()[0];
		if (!first) throw new Error("OAuth provider fixture is empty");
		expect(first.id).not.toBe(target.id);
		const selector = makeSelector(authSource({ saved: [target.id] }), async () => {});

		expect(rendered(selector)).not.toContain("remove saved credentials");
		const unconfigured = findPicker([selector.describe(pickerContext)])?.p as TspPickerProps | undefined;
		expect(unconfigured?.actions?.some(action => action.id === "remove")).toBe(false);

		search(selector, target.id);
		expect(rendered(selector)).toContain("remove saved credentials");
		const configured = findPicker([selector.describe(pickerContext)])?.p as TspPickerProps | undefined;
		const remove = configured?.actions?.find(action => action.id === "remove");
		expect(remove?.danger).toBe(true);
		expect(remove?.disabled).toBeUndefined();
	});

	it("does not remove a provider when the search has no matching rows", () => {
		let removals = 0;
		const selector = makeSelector(authSource({ saved: ["opencode-go"] }), async () => {
			removals++;
		});
		search(selector, "no-provider-matches-this");
		selector.handleInput("\x12");

		expect(rendered(selector)).toContain("No matching providers");
		expect(removals).toBe(0);
	});

	it("keeps the captured provider fixed and ignores duplicate confirmation while removal awaits", async () => {
		const first = provider("opencode-go");
		const second = provider("opencode-zen");
		const gate = Promise.withResolvers<void>();
		const removed: string[] = [];
		const selector = makeSelector(authSource({ saved: [first.id, second.id] }), async id => {
			removed.push(id);
			await gate.promise;
		});
		search(selector, first.id);
		selector.handleInput("\x12");
		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\x12");

		expect(removed).toEqual(["opencode-go"]);
		expect(rendered(selector)).toContain("removal continues");
		gate.resolve();
		await gate.promise;
		await Promise.resolve();
	});

	it("exposes dangerous native removal and routes its confirm and cancel actions", async () => {
		const target = provider("opencode-go");
		const removed: string[] = [];
		const selector = makeSelector(authSource({ saved: [target.id] }), async id => void removed.push(id));
		search(selector, target.id);
		const idle = findPicker([selector.describe(pickerContext)])?.p as TspPickerProps | undefined;
		const removalAction = idle?.actions?.find(action => action.id === "remove");
		expect(removalAction?.danger).toBe(true);
		selector.handleNativeEvent(pickerActionEvent("remove"));
		const confirming = findPicker([selector.describe(pickerContext)])?.p as TspPickerProps | undefined;
		expect(confirming?.confirm?.text).toContain("opencode-go");
		expect(confirming?.confirm?.text).toContain("every saved account and API key");

		selector.handleNativeEvent({ type: "activate", key: "picker", item: "opencode-zen" });
		expect(removed).toEqual([]);
		selector.handleNativeEvent(pickerActionEvent("cancel-remove"));
		const cancelled = findPicker([selector.describe(pickerContext)])?.p as TspPickerProps | undefined;
		expect(cancelled?.confirm).toBeNull();
		expect(removed).toEqual([]);

		selector.handleNativeEvent(pickerActionEvent("remove"));
		selector.handleNativeEvent({ type: "select", key: "picker", item: "opencode-zen" });
		selector.handleNativeEvent(pickerActionEvent("confirm-remove"));
		await Promise.resolve();
		expect(removed).toEqual(["opencode-go"]);
	});

	it("reports a failed removal and allows a later retry", async () => {
		const target = provider("opencode-go");
		let attempts = 0;
		const selector = makeSelector(authSource({ saved: [target.id] }), async () => {
			attempts++;
			if (attempts === 1) throw new Error("credential store unavailable");
		});
		search(selector, target.id);
		selector.handleInput("\x12");
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(attempts).toBe(1);
		expect(rendered(selector)).toContain("Could not remove saved credentials");
		selector.handleInput("\x12");
		selector.handleInput("\n");
		await Bun.sleep(0);
		expect(attempts).toBe(2);
		expect(rendered(selector)).not.toContain("Removing saved credentials");
	});

	it("ignores a late auth validation result after the credential has been removed", async () => {
		const target = provider("opencode-go");
		let saved = true;
		const validation = Promise.withResolvers<boolean>();
		const removed = Promise.withResolvers<void>();
		const selector = makeSelector(
			authSource({
				saved: [target.id],
				source: id => (id === target.id && saved ? { kind: "api_key" } : undefined),
			}),
			async () => {
				saved = false;
				removed.resolve();
			},
			() => {},
			() => {},
			async id => (id === target.id ? validation.promise : false),
		);
		search(selector, target.id);
		selector.handleInput("\x12");
		selector.handleInput("\n");
		await removed.promise;
		validation.resolve(true);
		await validation.promise;
		await Bun.sleep(0);

		expect(rendered(selector)).not.toContain("logged in");
	});

	it("preserves ordinary selection when removal is not configured", () => {
		const target = provider();
		const selected: string[] = [];
		const selector = makeSelector(authSource({ saved: [target.id] }), undefined, id => selected.push(id));
		search(selector, target.id);
		expect(rendered(selector)).not.toContain("Ctrl+R");
		selector.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});

	it("allows removal after a selected provider's login flow returns to the same selector", () => {
		const target = provider("opencode-go");
		const selected: string[] = [];
		const selector = makeSelector(
			authSource({ saved: [target.id] }),
			async () => {},
			providerId => selected.push(providerId),
		);
		search(selector, target.id);
		selector.handleInput("\n");
		expect(selected).toEqual([target.id]);

		// Selection stops auth validation while the scene runs login. A failed
		// login keeps the same selector mounted, so its removal shortcut stays usable.
		selector.handleInput("\x12");
		expect(rendered(selector)).toContain("Remove all saved credentials");
	});
});
