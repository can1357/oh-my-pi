import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { groupRelayTabs } from "../extension/worker/groups";
import { removeTab } from "../extension/worker/tabs";

const NONE = -1;

interface FakeTab {
	id: number;
	windowId: number;
	groupId: number;
	pinned: boolean;
}

interface FakeGroup {
	id: number;
	windowId: number;
	title: string;
	color: string;
}

/**
 * Chrome with saved tab groups: every group is saved on creation. Closing a group's last tab closes the group but
 * keeps it saved; ungrouping its last tab deletes the saved group.
 */
class SavingChrome {
	tabs = new Map<number, FakeTab>();
	/** Groups shown in the tab strip; a closed group leaves here but stays in {@link saved}. */
	open = new Map<number, FakeGroup>();
	saved = new Map<number, FakeGroup>();
	#nextGroup = 100;

	addTab(id: number, windowId = 1): void {
		this.tabs.set(id, { id, windowId, groupId: NONE, pinned: false });
	}

	createGroup(windowId: number, title: string): number {
		const group = { id: this.#nextGroup++, windowId, title, color: "grey" };
		this.open.set(group.id, group);
		this.saved.set(group.id, group);
		return group.id;
	}

	savedTitles(): string[] {
		return [...this.saved.values()].map(group => group.title);
	}

	#move(tab: FakeTab, groupId: number): void {
		const prev = tab.groupId;
		tab.groupId = groupId;
		if (prev !== NONE && !this.#hasTabs(prev)) {
			this.open.delete(prev);
			this.saved.delete(prev);
		}
	}

	#hasTabs(groupId: number): boolean {
		return [...this.tabs.values()].some(tab => tab.groupId === groupId);
	}

	#tab(id: number): FakeTab {
		const tab = this.tabs.get(id);
		if (!tab) throw new Error(`No tab with id: ${id}.`);
		return tab;
	}

	api() {
		return {
			storage: { session: { get: async (defaults: object) => defaults, set: async () => {} } },
			tabs: {
				get: async (id: number) => ({ ...this.#tab(id) }),
				query: async ({ groupId }: { groupId: number }) =>
					[...this.tabs.values()].filter(tab => tab.groupId === groupId),
				group: async (options: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }) => {
					const groupId = options.groupId ?? this.createGroup(options.createProperties?.windowId ?? 1, "");
					for (const id of options.tabIds) this.#move(this.#tab(id), groupId);
					return groupId;
				},
				ungroup: async (ids: number | number[]) => {
					for (const id of [ids].flat()) this.#move(this.#tab(id), NONE);
				},
				remove: async (id: number) => {
					const tab = this.#tab(id);
					this.tabs.delete(id);
					if (tab.groupId !== NONE && !this.#hasTabs(tab.groupId)) this.open.delete(tab.groupId);
				},
			},
			tabGroups: {
				TAB_GROUP_ID_NONE: NONE,
				query: async ({ title, windowId }: { title?: string; windowId?: number }) =>
					[...this.open.values()].filter(
						group =>
							(title === undefined || group.title === title) &&
							(windowId === undefined || group.windowId === windowId),
					),
				get: async (id: number) => {
					const group = this.open.get(id);
					if (!group) throw new Error(`No group with id: ${id}.`);
					return { ...group };
				},
				update: async (id: number, props: { title?: string; color?: string }) => {
					const group = this.open.get(id);
					if (group) Object.assign(group, props);
					return group;
				},
			},
		};
	}
}

describe("relay tab groups under Chrome's saved groups", () => {
	let chromeBefore: PropertyDescriptor | undefined;
	let browser: SavingChrome;

	beforeEach(() => {
		chromeBefore = Object.getOwnPropertyDescriptor(globalThis, "chrome");
		browser = new SavingChrome();
		Reflect.set(globalThis, "chrome", browser.api());
	});

	afterEach(() => {
		if (chromeBefore) Object.defineProperty(globalThis, "chrome", chromeBefore);
		else Reflect.deleteProperty(globalThis, "chrome");
	});

	it("leaves no saved omp group behind after the relay closes its tabs, session after session", async () => {
		for (const tabId of [1, 2, 3]) {
			browser.addTab(tabId);
			await groupRelayTabs([tabId], "omp", "cyan");
			await removeTab(tabId);
		}
		expect(browser.savedTitles()).toEqual([]);
		expect(browser.tabs.size).toBe(0);
	});

	it("keeps the omp group while another relay tab remains in it", async () => {
		browser.addTab(1);
		browser.addTab(2);
		const { grouped } = await groupRelayTabs([1, 2], "omp", "cyan");
		await removeTab(1);
		expect(browser.savedTitles()).toEqual(["omp"]);
		expect(browser.tabs.get(2)?.groupId).toBe(grouped["2"]!);
	});

	it("closes a tab in the user's own saved group without deleting that group", async () => {
		await groupRelayTabs([], "omp", "cyan");
		browser.addTab(5);
		const groupId = browser.createGroup(1, "research");
		browser.tabs.get(5)!.groupId = groupId;
		await removeTab(5);
		expect(browser.savedTitles()).toEqual(["research"]);
		expect(browser.tabs.has(5)).toBe(false);
	});
});
