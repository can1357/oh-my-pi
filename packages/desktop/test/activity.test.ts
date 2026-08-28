import { beforeEach, describe, expect, test } from "bun:test";
import {
	anyTabBusy,
	busyTabs,
	forgetTab,
	getSnapshot,
	markViewed,
	setTabActivity,
	subscribe,
	tabState,
} from "../src/shell/activity";

/** The store is module-level, so each test starts from a clean slate. */
beforeEach(() => {
	for (const tabId of getSnapshot().keys()) forgetTab(tabId);
});

describe("session state resolution", () => {
	test("a session never opened is idle", () => {
		expect(tabState("never-opened")).toBe("idle");
	});

	test("streaming reads as working", () => {
		setTabActivity("a", { streaming: true, attention: false });
		expect(tabState("a")).toBe("working");
	});

	test("attention outranks working", () => {
		// A session that is streaming AND blocked on an approval is blocked; the
		// urgent thing is that it needs an answer.
		setTabActivity("a", { streaming: true, attention: true });
		expect(tabState("a")).toBe("attention");
	});

	test("finishing a turn latches done", () => {
		setTabActivity("a", { streaming: true, attention: false });
		setTabActivity("a", { streaming: false, attention: false });
		expect(tabState("a")).toBe("done");
	});

	test("done survives unrelated updates until viewed", () => {
		setTabActivity("a", { streaming: true, attention: false });
		setTabActivity("a", { streaming: false, attention: false });
		// Another idle publish must not quietly clear the unread mark.
		setTabActivity("a", { streaming: false, attention: false });
		expect(tabState("a")).toBe("done");

		markViewed("a");
		expect(tabState("a")).toBe("idle");
	});

	test("a session that never streamed does not become done", () => {
		// Opening a saved session publishes idle; that is not "just finished".
		setTabActivity("a", { streaming: false, attention: false });
		expect(tabState("a")).toBe("idle");
	});

	test("a new turn after viewing can latch done again", () => {
		setTabActivity("a", { streaming: true, attention: false });
		setTabActivity("a", { streaming: false, attention: false });
		markViewed("a");
		setTabActivity("a", { streaming: true, attention: false });
		setTabActivity("a", { streaming: false, attention: false });
		expect(tabState("a")).toBe("done");
	});

	test("attention clears back to done when the dialog is answered", () => {
		setTabActivity("a", { streaming: true, attention: false });
		setTabActivity("a", { streaming: true, attention: true });
		expect(tabState("a")).toBe("attention");
		setTabActivity("a", { streaming: false, attention: false });
		expect(tabState("a")).toBe("done");
	});
});

describe("store semantics", () => {
	test("getSnapshot is referentially stable until something changes", () => {
		setTabActivity("a", { streaming: true, attention: false });
		const first = getSnapshot();
		expect(getSnapshot()).toBe(first);

		setTabActivity("a", { streaming: false, attention: false });
		expect(getSnapshot()).not.toBe(first);
	});

	test("an unchanged publish does not wake subscribers", () => {
		let calls = 0;
		const unsubscribe = subscribe(() => calls++);

		setTabActivity("a", { streaming: true, attention: false });
		expect(calls).toBe(1);

		// SessionView republishes on every render; identical state must be inert
		// or the sidebar would re-render on every frame of a streaming turn.
		setTabActivity("a", { streaming: true, attention: false });
		setTabActivity("a", { streaming: true, attention: false });
		expect(calls).toBe(1);

		unsubscribe();
	});

	test("subscribers stop after unsubscribing", () => {
		let calls = 0;
		const unsubscribe = subscribe(() => calls++);
		unsubscribe();
		setTabActivity("a", { streaming: true, attention: false });
		expect(calls).toBe(0);
	});

	test("markViewed on an unknown session registers it as idle", () => {
		markViewed("fresh");
		expect(getSnapshot().has("fresh")).toBe(true);
		expect(tabState("fresh")).toBe("idle");
	});
});

describe("close guard", () => {
	test("anyTabBusy tracks only streaming sessions", () => {
		expect(anyTabBusy()).toBe(false);

		setTabActivity("a", { streaming: true, attention: false });
		setTabActivity("b", { streaming: false, attention: true });
		expect(anyTabBusy()).toBe(true);
		expect(busyTabs()).toEqual(["a"]);

		setTabActivity("a", { streaming: false, attention: false });
		expect(anyTabBusy()).toBe(false);
	});

	test("a session waiting on approval is not counted as busy", () => {
		// Blocked on a human is not mid-turn; quitting loses nothing in flight.
		setTabActivity("a", { streaming: false, attention: true });
		expect(anyTabBusy()).toBe(false);
	});
});
