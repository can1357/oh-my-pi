import { beforeAll, describe, expect, it } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { type HistorySearchEntry, HistorySearchComponent } from "../src/overlays/history-search";
import { type SessionSelectorEntry, SessionSelectorComponent } from "../src/overlays/session-selector";
import { initTheme } from "../src/theme";

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };

beforeAll(async () => {
	await initTheme(false);
});

const HOUR = 3_600_000;

function session(id: string, title: string, ageMs: number, cwd = "/work/app"): SessionSelectorEntry {
	return {
		path: `${cwd}/.omp/${id}.jsonl`,
		id,
		cwd,
		title,
		modified: new Date(Date.now() - ageMs),
		size: 5_600,
		firstMessage: `${title} prompt`,
		allMessagesText: `${title} prompt ${title} answer`,
		status: "complete",
	};
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function type(component: { handleInput(data: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

/** Resolves on the first render request after which the picker props satisfy `ready`. */
function renderedWhen(selector: SessionSelectorComponent, ready: (p: TspPickerProps) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	selector.setOnRequestRender(() => {
		if (ready(props(selector.describe(withPicker)))) resolve();
	});
	return promise;
}

describe("session selector picker", () => {
	const today = session("a", "Alpha", 0);
	const todayToo = session("b", "Beta", 1);
	const old = session("c", "Gamma", 40 * 24 * HOUR);
	const others = session("d", "Delta", 3 * 24 * HOUR, "/work/other");

	function make(opts: { deleted?: string[]; resumed?: string[]; standalone?: boolean } = {}) {
		return new SessionSelectorComponent(
			[today, todayToo, old],
			s => opts.resumed?.push(s.id),
			() => {},
			() => {},
			{
				onDelete: async s => {
					opts.deleted?.push(s.id);
					return true;
				},
				loadAllSessions: async () => [today, todayToo, others, old],
				currentSessionPath: todayToo.path,
				standalone: opts.standalone,
			},
		);
	}

	it("describes a grouped cards picker with a preview when the terminal has the kind, else the card", () => {
		const selector = make();
		expect(selector.nativeSheet(withPicker)).toBe(true);
		const root = selector.describe(withPicker);
		const p = props(root);
		expect(p.size).toBe("lg");
		expect(p.layout).toBe("cards");
		expect(p.actions?.find(a => a.id === "scope")?.label).toBe("All projects");
		expect(p.placeholder).toMatch(/^Search sessions in .+…$/);
		expect(p.order).toEqual([
			{ group: "today-0", label: "Today", count: 2 },
			today.path,
			todayToo.path,
			{ group: "earlier-2", label: "Earlier", count: 1 },
			old.path,
		]);
		expect(p.selected).toBe(todayToo.path);
		expect(p.current).toEqual([todayToo.path]);
		const beta = p.items?.find(item => item.id === todayToo.path);
		expect(beta?.badges?.map(b => b.text)).toEqual(["current"]);
		expect(beta?.dot).toBe("success");
		const preview = root.c as NativeNode[];
		expect(preview[0]).toMatchObject({ k: "text", p: { text: "Beta", role: "omp.picker.title" } });
		expect(preview.find(child => child.k === "section")?.p).toEqual({ head: "Conversation" });

		expect(selector.nativeSheet(withoutPicker)).toBe(false);
		expect(selector.describe(withoutPicker).k).toBe("card");
	});

	it("fills the screen surface in the standalone app", () => {
		const selector = make({ standalone: true });
		expect(selector.nativeSheet(withPicker)).toBe(false);
		expect(props(selector.describe(withPicker)).size).toBe("screen");
	});

	it("keeps the catalogue while typing: only order, hits and selection follow the query", () => {
		const selector = make();
		const before = props(selector.describe(withPicker));
		type(selector, "gam");
		const after = props(selector.describe(withPicker));
		expect(after.items).toBe(before.items);
		expect(after.query).toBe("gam");
		expect(after.order).toEqual([old.path]);
		expect(after.hits).toEqual({ [old.path]: [[0, 3]] });
		expect(after.selected).toBe(old.path);
	});

	it("runs pointer events down the keys' paths", async () => {
		const resumed: string[] = [];
		const deleted: string[] = [];
		const selector = make({ resumed, deleted });

		selector.handleNativeEvent({ type: "select", key: "", item: old.path });
		expect(props(selector.describe(withPicker)).selected).toBe(old.path);
		selector.handleNativeEvent({ type: "action", key: "", act: "resume", mods: [] });
		expect(resumed).toEqual(["c"]);

		selector.handleNativeEvent({ type: "action", key: "", act: "delete", mods: [] });
		expect(props(selector.describe(withPicker)).confirm?.act).toBe("delete-confirm");
		selector.handleNativeEvent({ type: "action", key: "", act: "cancel", mods: [] });
		expect(props(selector.describe(withPicker)).confirm).toBeNull();

		// Backspace on an empty query opens the same confirm strip.
		selector.handleInput("\x7f");
		expect(props(selector.describe(withPicker)).confirm?.text).toBe("Delete “Gamma”? This removes the session file.");
		const closed = renderedWhen(selector, p => p.confirm === null);
		selector.handleNativeEvent({ type: "action", key: "", act: "delete-confirm", mods: [] });
		await closed;
		expect(deleted).toEqual(["c"]);
		expect(props(selector.describe(withPicker)).order).not.toContain(old.path);

		const loaded = renderedWhen(
			selector,
			p => p.state === "ready" && p.actions?.find(a => a.id === "scope")?.label === "This folder",
		);
		selector.handleNativeEvent({ type: "action", key: "", act: "scope", mods: [] });
		expect(props(selector.describe(withPicker)).state).toBe("loading");
		await loaded;
		const all = props(selector.describe(withPicker));
		expect(all.placeholder).toBe("Search all sessions…");
		expect(all.items?.find(item => item.id === others.path)?.detail).toEqual([
			{ t: "/work/", s: "path dim" },
			{ t: "other", s: "path" },
		]);
	});
});

describe("history search picker", () => {
	const now = Math.floor(Date.now() / 1000);
	const entries: HistorySearchEntry[] = [
		{ prompt: "deploy the release\nwith notes", created_at: now - 60, cwd: "/work/app" },
		{ prompt: "routine status", created_at: now - 7200 },
	];
	const source = {
		getRecent: (limit: number) => entries.slice(0, limit),
		search: (query: string) => entries.filter(e => e.prompt.includes(query)),
	};

	it("hoists a keyed picker from the dock and inserts on activate", () => {
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			[{ ...source, label: "all projects" }],
			prompt => inserted.push(prompt),
			() => {},
		);
		type(search, "deploy");
		const root = search.describe(withPicker);
		expect(root.k).toBe("col");
		const sheet = (root.c as NativeNode[])[0]!;
		expect(sheet.key).toBe("picker");
		const p = props(sheet);
		expect(p.items).toHaveLength(1);
		expect(p.items?.[0]).toMatchObject({ label: "deploy the release", hits: [[0, 6]], detail: "/work/app" });

		search.handleNativeEvent({ type: "activate", key: "^picker", item: p.items![0]!.id });
		expect(inserted).toEqual(["deploy the release\nwith notes"]);
		expect(search.describe(withoutPicker).k).toBe("card");
	});

	it("exposes both scope directions and preserves the query caret during native actions", () => {
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			["first", "second", "third"].map(label => ({ ...source, label })),
			prompt => inserted.push(prompt),
			() => inserted.push("canceled"),
		);
		type(search, "deploy");
		search.handleInput("\x1b[D");
		const sheet = () => props((search.describe(withPicker).c as NativeNode[])[0]!);
		expect(sheet().actions).toContainEqual({ id: "scope", label: "second", keys: ["tab"] });
		expect(sheet().actions).toContainEqual({ id: "scope-back", label: "third", keys: ["shift", "tab"] });
		const hints = (search.describe(withoutPicker).c as NativeNode[]).find(child => child.key === "hints")!;
		const keycaps = (hints.c as NativeNode[]).flatMap(row =>
			(row.c as NativeNode[]).filter(child => child.k === "kbd").map(child => child.p),
		);
		expect(keycaps).toContainEqual({ keys: ["tab"] });
		expect(keycaps).toContainEqual({ keys: ["shift", "tab"] });
		search.handleNativeEvent({ type: "action", key: "^picker", act: "scope", mods: [] });
		expect(sheet()).toMatchObject({ title: "History (second)", query: "deploy", cursor: 5 });
		search.handleNativeEvent({ type: "action", key: "^picker", act: "scope-back", mods: [] });
		search.handleNativeEvent({ type: "action", key: "^picker", act: "scope-back", mods: [] });
		expect(sheet()).toMatchObject({ title: "History (third)", query: "deploy", cursor: 5 });
		expect(inserted).toEqual([]);
		search.handleNativeEvent({ type: "activate", key: "^picker", item: sheet().items![0]!.id });
		expect(inserted).toEqual([entries[0]!.prompt]);
	});

	it("does not advertise or reset selection for a one-scope ring", () => {
		const search = new HistorySearchComponent(
			[{ ...source, label: "only" }],
			() => {},
			() => {},
		);
		search.handleInput("\x1b[B");
		const sheet = () => props((search.describe(withPicker).c as NativeNode[])[0]!);
		const selected = sheet().selected;
		for (const key of ["\t", "\x1b[Z"]) search.handleInput(key);
		search.handleNativeEvent({ type: "action", key: "^picker", act: "scope", mods: [] });
		expect(sheet().selected).toBe(selected);
		expect(sheet().actions?.filter(action => action.id.startsWith("scope"))).toEqual([]);
		const hints = (search.describe(withoutPicker).c as NativeNode[]).find(child => child.key === "hints")!;
		const keycaps = (hints.c as NativeNode[]).flatMap(row =>
			(row.c as NativeNode[]).filter(child => child.k === "kbd").map(child => child.p),
		);
		expect(keycaps).not.toContainEqual({ keys: ["tab"] });
		expect(keycaps).not.toContainEqual({ keys: ["shift", "tab"] });
	});

	for (const [name, context] of [
		["picker", withPicker],
		["card", withoutPicker],
	] as const) {
		it("updates " + name + " scope chrome when both sources reuse the same empty array", () => {
			const shared: HistorySearchEntry[] = [];
			const search = new HistorySearchComponent(
				["first", "second"].map(label => ({ label, getRecent: () => shared, search: () => shared })),
				() => {},
				() => {},
			);
			const title = () => {
				const root = search.describe(context);
				return name === "picker" ? props((root.c as NativeNode[])[0]!).title : (root.p as { head: string }).head;
			};
			expect(title()).toBe("History (first)");
			search.handleInput("\t");
			expect(title()).toBe("History (second)");
			search.handleInput("\x1b[Z");
			expect(title()).toBe("History (first)");
		});
	}

	it("refreshes query hits and selectable rows when a source reuses a mutable array", () => {
		const shared: HistorySearchEntry[] = [{ prompt: "deploy release", created_at: now }];
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			[{ label: "only", getRecent: () => shared, search: () => shared }],
			text => inserted.push(text),
			() => {},
		);
		const sheet = () => props((search.describe(withPicker).c as NativeNode[])[0]!);
		type(search, "deploy");
		expect(sheet().items?.[0]?.hits).toEqual([[0, 6]]);
		search.handleNativeEvent({ type: "action", key: "^picker", act: "clear", mods: [] });
		type(search, "release");
		expect(sheet().items?.[0]?.hits).toEqual([[7, 14]]);
		shared.push({ prompt: "release follow-up", created_at: now + 1 });
		search.handleInput("\x1b[D");
		const refreshed = sheet();
		expect(refreshed.cursor).toBe(6);
		expect(refreshed.items?.map(item => item.label)).toEqual(["deploy release", "release follow-up"]);
		search.handleNativeEvent({ type: "activate", key: "^picker", item: refreshed.items![1]!.id });
		expect(inserted).toEqual(["release follow-up"]);
	});
});
