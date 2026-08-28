import { describe, expect, test } from "bun:test";
import { projectMenuItems, sessionMenuItems } from "../src/components/sessionMenu";
import { SESSION_DETACHED } from "../src/rpc/sessionOps";
import { type MenuItem, tidy } from "../src/shell/contextMenu";

const noop = () => {};
const ACTIONS = {
	open: noop,
	rename: noop,
	exportHtml: noop,
	reveal: noop,
	copySessionPath: noop,
	copyProjectPath: noop,
	stop: noop,
	remove: noop,
};

function labels(items: readonly MenuItem[]): string[] {
	return items.filter(item => item.kind === "action").map(item => item.label);
}

function reasonFor(items: readonly MenuItem[], id: string): string | undefined {
	const item = items.find(entry => entry.kind === "action" && entry.id === id);
	return item?.kind === "action" ? item.disabled : undefined;
}

describe("sessionMenuItems", () => {
	test("a live session in a project offers everything", () => {
		const items = sessionMenuItems({ live: true, attached: true, hasProject: true }, ACTIONS);

		expect(labels(items)).toEqual([
			"Open",
			"Rename…",
			"Export to HTML…",
			"Reveal folder in Finder",
			"Copy session path",
			"Copy project path",
			"Stop the process",
			"Delete session…",
		]);
		expect(items.every(item => item.kind !== "action" || !item.disabled)).toBe(true);
	});

	test("every disabled entry says why, rather than just going grey", () => {
		const items = sessionMenuItems({ live: false, attached: false, hasProject: false }, ACTIONS);
		const off = items.filter(item => item.kind === "action" && item.disabled);

		expect(off.length).toBeGreaterThan(0);
		for (const item of off) {
			expect(item.kind === "action" && item.disabled?.length).toBeGreaterThan(0);
		}
	});

	test("a session with no process cannot be stopped, and is told so", () => {
		const items = sessionMenuItems({ live: false, attached: false, hasProject: true }, ACTIONS);

		expect(reasonFor(items, "stop")).toBe("This session has no process running");
		// Renaming stays available: it routes through a throwaway process.
		expect(reasonFor(items, "rename")).toBeUndefined();
		expect(reasonFor(items, "export")).toBeUndefined();
	});

	test("a live session this window has no handle on refuses rename and export", () => {
		// You are on Settings: the pool still has the process, no session view is
		// mounted, and "no bridge" used to mean "nothing is running".
		const items = sessionMenuItems({ live: true, attached: false, hasProject: true }, ACTIONS);

		expect(reasonFor(items, "rename")).toBe(SESSION_DETACHED);
		expect(reasonFor(items, "export")).toBe(SESSION_DETACHED);
		// Opening it is the way out, and stopping it needs no protocol at all.
		expect(reasonFor(items, "open")).toBeUndefined();
		expect(reasonFor(items, "stop")).toBeUndefined();
	});

	test("an old session with no recorded folder loses only the folder actions", () => {
		const items = sessionMenuItems({ live: true, attached: true, hasProject: false }, ACTIONS);

		expect(reasonFor(items, "reveal")).toBe("This session recorded no project folder");
		expect(reasonFor(items, "copy-project")).toBe("This session recorded no project folder");
		expect(reasonFor(items, "copy-session")).toBeUndefined();
	});

	test("delete is marked dangerous and sits last", () => {
		const items = sessionMenuItems({ live: true, attached: true, hasProject: true }, ACTIONS);
		const last = items.at(-1);

		expect(last?.kind === "action" && last.id).toBe("delete");
		expect(last?.kind === "action" && last.danger).toBe(true);
	});
});

describe("projectMenuItems", () => {
	test("leads with the thing a right click on a project promises", () => {
		const items = projectMenuItems({ newChat: noop, reveal: noop, copyPath: noop, collapseAll: noop });
		expect(labels(items)[0]).toBe("New chat here");
	});
});

describe("tidy", () => {
	test("drops leading, trailing and doubled separators", () => {
		// Menus are assembled conditionally, so separators outlive the entries they
		// were meant to divide.
		const items = tidy([
			{ kind: "separator", id: "a" },
			{ kind: "action", id: "1", label: "One", run: noop },
			{ kind: "separator", id: "b" },
			{ kind: "separator", id: "c" },
			{ kind: "action", id: "2", label: "Two", run: noop },
			{ kind: "separator", id: "d" },
		]);

		expect(items.map(item => item.id)).toEqual(["1", "b", "2"]);
	});

	test("a menu of only separators comes out empty", () => {
		expect(
			tidy([
				{ kind: "separator", id: "a" },
				{ kind: "separator", id: "b" },
			]),
		).toEqual([]);
	});
});
