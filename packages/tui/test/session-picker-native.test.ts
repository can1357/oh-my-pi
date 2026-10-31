import { beforeAll, describe, expect, it } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { OverlayPanel } from "../src/chrome/overlay-box";
import { TextFormField } from "../src/components/form";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { type HistorySearchEntry, HistorySearchComponent, type HistorySource } from "../src/overlays/history-search";
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

describe("session selector rename", () => {
	interface RenameCall {
		id: string;
		title: string;
	}

	function makeRename(renamed?: { calls: RenameCall[]; result?: string | null }) {
		// Fresh entries per test: rename mutates the shared entry in place.
		const entries = [session("a", "Alpha", 0), session("b", "Beta", 1), session("c", "Gamma", 40 * 24 * HOUR)];
		const selector = new SessionSelectorComponent(
			entries,
			() => {},
			() => {},
			() => {},
			{
				...(renamed
					? {
							onRename: async (s, title) => {
								renamed.calls.push({ id: s.id, title });
								return renamed.result === undefined ? title : renamed.result;
							},
						}
					: {}),
				currentSessionPath: entries[1]!.path,
			},
		);
		return { selector, beta: entries[1]! };
	}

	/** The open rename dialog and its field, via the ANSI card (the native picker props have no text-input affordance). */
	function renameDialogOf(selector: SessionSelectorComponent) {
		const card = selector.describe(withoutPicker);
		const dialog = (card.c ?? []).find(
			(child): child is OverlayPanel => child instanceof OverlayPanel && child.title === "Rename Session",
		);
		if (!dialog) return undefined;
		const field = dialog.children.find((child): child is TextFormField => child instanceof TextFormField);
		if (!field) return undefined;
		return { dialog, field };
	}

	it("shows the rename action only when onRename is set", () => {
		const withHook = makeRename({ calls: [] });
		expect(props(withHook.selector.describe(withPicker)).actions?.find(a => a.id === "rename")?.label).toBe("Rename");
		const withoutHook = makeRename();
		expect(props(withoutHook.selector.describe(withPicker)).actions?.some(a => a.id === "rename")).toBe(false);
	});

	it("opens the rename dialog prefilled with the current title on F2", () => {
		const { selector, beta } = makeRename({ calls: [] });
		selector.handleInput("\x1bOQ");
		const opened = renameDialogOf(selector);
		expect(opened).toBeDefined();
		expect(opened!.field.getValue()).toBe(beta.title ?? "");
	});
	it("commits on Enter via onRename and updates the row in place", async () => {
		const renamed = { calls: [] as RenameCall[] };
		const { selector, beta } = makeRename(renamed);
		selector.handleInput("\x1bOQ");
		type(selector, " Prime");
		const updated = renderedWhen(selector, p => p.items?.find(item => item.id === beta.path)?.label === "Beta Prime");
		selector.handleInput("\r");
		await updated;
		expect(renamed.calls).toEqual([{ id: "b", title: "Beta Prime" }]);
		const after = props(selector.describe(withPicker));
		expect(after.selected).toBe(beta.path);
		expect(renameDialogOf(selector)).toBeUndefined();
	});

	it("cancels on Esc without changes", () => {
		const renamed = { calls: [] as RenameCall[] };
		const { selector, beta } = makeRename(renamed);
		selector.handleInput("\x1bOQ");
		expect(renameDialogOf(selector)).toBeDefined();
		type(selector, " Prime");
		selector.handleInput("\x1b");
		expect(renameDialogOf(selector)).toBeUndefined();
		const after = props(selector.describe(withPicker));
		expect(after.items?.find(item => item.id === beta.path)?.label).toBe("Beta");
		expect(after.selected).toBe(beta.path);
	});

	it("renders the rename editor instead of the picker while it is open", () => {
		const { selector } = makeRename({ calls: [] });
		// The picker kind has no text-input affordance: while renaming, the
		// component must describe the card path so the field is visible.
		expect(selector.describe(withPicker).k).toBe("picker");
		selector.handleInput("\x1bOQ");
		expect(selector.describe(withPicker).k).toBe("card");
		expect(selector.nativeSheet(withPicker)).toBe(false);
		expect(renameDialogOf(selector)).toBeDefined();
	});

	it("searches the new title after a rename", async () => {
		const renamed = { calls: [] as RenameCall[] };
		const { selector, beta } = makeRename(renamed);
		// Search first, so the entry caches its haystack with the old title.
		selector.handleInput("Beta");
		expect(props(selector.describe(withPicker)).items?.some(item => item.id === beta.path)).toBe(true);
		selector.handleInput("\x1bOQ");
		type(selector, " Prime");
		const updated = renderedWhen(selector, p => p.items?.find(item => item.id === beta.path)?.label === "Beta Prime");
		selector.handleInput("\r");
		await updated;
		// The cached search text must follow the rename: the new title matches,
		// the old one no longer does.
		selector.handleInput("Prime");
		const found = props(selector.describe(withPicker)).items?.find(item => item.id === beta.path);
		expect(found?.label).toBe("Beta Prime");
		selector.handleInput("Beta");
		const stale = props(selector.describe(withPicker)).items?.find(item => item.id === beta.path);
		expect(stale?.label).toBe("Beta Prime");
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

	it("searches and activates a single source while preserving its method receiver", () => {
		class Source {
			#entries = entries;

			getRecent(limit: number): HistorySearchEntry[] {
				return this.#entries.slice(0, limit);
			}

			search(query: string, limit: number): HistorySearchEntry[] {
				return this.#entries.filter(entry => entry.prompt.includes(query)).slice(0, limit);
			}
		}
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			new Source(),
			prompt => inserted.push(prompt),
			() => {},
		);
		const sheet = () => props((search.describe(withPicker).c as NativeNode[])[0]!);
		expect(sheet().items?.map(item => item.label)).toEqual(["deploy the release", "routine status"]);
		type(search, "deploy");
		const result = sheet();
		expect(result.items?.map(item => item.label)).toEqual(["deploy the release"]);
		expect(result.actions?.some(action => action.id === "scope" || action.id === "scope-back")).toBe(false);
		search.handleNativeEvent({ type: "activate", key: "^picker", item: result.items![0]!.id });
		expect(inserted).toEqual(["deploy the release\nwith notes"]);
		search.dispose();
	});

	it("searches and activates a source with virtual methods", () => {
		const virtualSource = new Proxy<HistorySource>(Object.create(null), {
			get: (_target, key) => Reflect.get(source, key),
		});
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			virtualSource,
			prompt => inserted.push(prompt),
			() => {},
		);
		const sheet = () => props((search.describe(withPicker).c as NativeNode[])[0]!);
		expect(sheet().items?.map(item => item.label)).toEqual(["deploy the release", "routine status"]);
		type(search, "deploy");
		const result = sheet();
		expect(result.items?.map(item => item.label)).toEqual(["deploy the release"]);
		search.handleNativeEvent({ type: "activate", key: "^picker", item: result.items![0]!.id });
		expect(inserted).toEqual(["deploy the release\nwith notes"]);
		search.dispose();
	});

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
		expect(sheet()).toMatchObject({ query: "deploy", cursor: 5 });
		expect(sheet().title).toContain("second");
		search.handleNativeEvent({ type: "action", key: "^picker", act: "scope-back", mods: [] });
		search.handleNativeEvent({ type: "action", key: "^picker", act: "scope-back", mods: [] });
		expect(sheet()).toMatchObject({ query: "deploy", cursor: 5 });
		expect(sheet().title).toContain("third");
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
			expect(title()).toContain("first");
			search.handleInput("\t");
			expect(title()).toContain("second");
			expect(title()).not.toContain("first");
			search.handleInput("\x1b[Z");
			expect(title()).toContain("first");
			expect(title()).not.toContain("second");
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
		search.handleInput("s");
		const refreshed = sheet();
		expect(refreshed.cursor).toBe(7);
		expect(refreshed.items?.map(item => item.label)).toEqual(["deploy release", "release follow-up"]);
		search.handleNativeEvent({ type: "activate", key: "^picker", item: refreshed.items![1]!.id });
		expect(inserted).toEqual(["release follow-up"]);
	});
});
