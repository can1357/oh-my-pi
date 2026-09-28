import { describe, expect, it } from "bun:test";
import { activateRelayTab, createRelayTab } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/tab-ops";

/**
 * Records what the extension would ask Chrome to do. The relay extension runs
 * these two helpers against `chrome.tabs`, and nothing in a unit test can
 * observe Chrome itself, so the call the extension makes IS the contract: it
 * is what decides whether the user keeps the tab and window they were in.
 */
class FakeTabs {
	readonly created: Array<{ url?: string; active?: boolean }> = [];
	readonly updated: Array<{ tabId: number; active?: boolean }> = [];
	async create(createProperties: { url?: string; active?: boolean }): Promise<{ id: number }> {
		this.created.push(createProperties);
		return { id: 7 };
	}
	async update(tabId: number, updateProperties: { active?: boolean }): Promise<unknown> {
		this.updated.push({ tabId, ...updateProperties });
		return undefined;
	}
}

describe("relay tab policy", () => {
	it("creates a driven tab in the background instead of foregrounding it", async () => {
		const tabs = new FakeTabs();

		const created = await createRelayTab(tabs, "https://example.com/");

		expect(created).toEqual({ id: 7 });
		// `chrome.tabs.create` defaults to `active: true`, which pulls the user
		// off whatever they were reading; the policy must pass it explicitly.
		expect(tabs.created).toEqual([{ url: "https://example.com/", active: false }]);
	});

	it("activates a tab without raising its window", async () => {
		const tabs = new FakeTabs();

		await activateRelayTab(tabs, 42);

		// Exactly one mutation, and it is the one that does not move OS focus:
		// `chrome.tabs.update({ active: true })` cannot focus a window, while
		// the `chrome.windows.update({ focused: true })` this replaced takes
		// keyboard focus away from whatever application the user is typing in.
		expect(tabs.updated).toEqual([{ tabId: 42, active: true }]);
		expect(tabs.created).toEqual([]);
	});
});
