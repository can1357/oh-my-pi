import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { OverlayPanel } from "../src/chrome/overlay-box";
import { TextFormField } from "../src/components/form";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { type HistorySearchEntry, HistorySearchComponent } from "../src/overlays/history-search";
import { type SessionSelectorEntry, SessionSelectorComponent } from "../src/overlays/session-selector";
import { initTheme } from "../src/theme";
import { KeybindingsManager } from "../src/app-keybindings";
import { getKeybindings, setKeybindings } from "../src/keybindings";

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
				loadAllSessions: async () => ({ sessions: [today, todayToo, others, old] }),
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
	let previousKeybindings: KeybindingsManager;
	beforeEach(() => {
		previousKeybindings = getKeybindings() as KeybindingsManager;
		setKeybindings(KeybindingsManager.inMemory());
	});
	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	interface RenameCall {
		id: string;
		title: string;
	}

	function makeRename(
		renamed?: { calls: RenameCall[]; result?: string | null },
		extra?: {
			onGenerateTitle?: (session: SessionSelectorEntry, signal: AbortSignal) => Promise<string | null>;
			onSetPinned?: (session: SessionSelectorEntry, pinned: boolean) => Promise<void>;
			onDelete?: (session: SessionSelectorEntry) => Promise<boolean>;
			loadAllSessions?: () => Promise<{ sessions: SessionSelectorEntry[] }>;
		},
	) {
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
				onGenerateTitle: extra?.onGenerateTitle,
				onSetPinned: extra?.onSetPinned,
				onDelete: extra?.onDelete,
				loadAllSessions: extra?.loadAllSessions,
				currentSessionPath: entries[1]!.path,
			},
		);
		return { selector, beta: entries[1]! };
	}

	function isNativeNode(child: NativeChild): child is NativeNode {
		return Boolean(child && typeof child === "object" && "k" in child);
	}

	function hintLabelsOf(card: NativeNode): string[] {
		const hintsNode = (card.c ?? []).find(
			(child): child is NativeNode =>
				isNativeNode(child) && child.k === "row" && child.p?.role === "omp.overlay.hints",
		);
		if (!hintsNode || !hintsNode.c) return [];
		const labels: string[] = [];
		for (const hintChild of hintsNode.c) {
			if (!isNativeNode(hintChild) || hintChild.k !== "row" || !hintChild.c) continue;
			for (const part of hintChild.c) {
				if (!isNativeNode(part) || part.k !== "text" || !part.p?.spans) continue;
				for (const s of part.p.spans) {
					if (s && typeof s === "object" && "t" in s) {
						labels.push(s.t);
					}
				}
			}
		}
		return labels;
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
	it("opens the rename dialog on a Kitty F2 press instead of forwarding it to search", () => {
		const { selector, beta } = makeRename({ calls: [] });
		selector.handleInput("\x1b[Q");
		const opened = renameDialogOf(selector);
		expect(opened?.field.getValue()).toBe(beta.title);
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

	it("renders Rename Session once and replaces footer hints with dialog hints", () => {
		const { selector } = makeRename(
			{ calls: [] },
			{
				onDelete: async () => true,
				onSetPinned: async () => {},
				loadAllSessions: async () => ({ sessions: [] }),
				onGenerateTitle: async () => "New Title",
			},
		);

		const beforeRender = selector.render(100).join("\n");
		expect(beforeRender).toContain("delete");
		expect(beforeRender).toContain("rename");
		expect(beforeRender).toContain("pin");
		expect(beforeRender).toContain("all projects");

		const beforeCard = selector.describe(withoutPicker);
		const beforeHints = hintLabelsOf(beforeCard);
		expect(beforeHints).toContain("delete");
		expect(beforeHints).toContain("rename");
		expect(beforeHints).toContain("pin");
		expect(beforeHints).toContain("all projects");

		selector.handleInput("\x1bOQ");

		const afterRender = selector.render(100).join("\n");
		const titleMatches = afterRender.match(/Rename [Ss]ession/g);
		expect(titleMatches).toEqual(["Rename Session"]);

		expect(afterRender).toContain("save");
		expect(afterRender).toContain("auto-title");
		expect(afterRender).toContain("cancel");
		expect(afterRender).not.toContain("delete");
		expect(afterRender).not.toContain("rename ·");
		expect(afterRender).not.toContain("pin");
		expect(afterRender).not.toContain("all projects");

		const afterCard = selector.describe(withoutPicker);
		const afterHints = hintLabelsOf(afterCard);
		expect(afterHints).toEqual(["save", "auto-title", "cancel"]);
	});

	it("generates a title on Alt+T and commits on Enter", async () => {
		const renamed = { calls: [] as RenameCall[] };
		const generatedTitles: string[] = [];
		const { promise: titlePromise, resolve: finishGenerate } = Promise.withResolvers<string>();
		const { selector, beta } = makeRename(renamed, {
			onGenerateTitle: async (s, signal) => {
				generatedTitles.push(s.id);
				expect(signal.aborted).toBe(false);
				return titlePromise;
			},
		});

		selector.handleInput("\x1bOQ");
		const opened = renameDialogOf(selector);
		expect(opened).toBeDefined();
		expect(opened!.field.getValue()).toBe(beta.title ?? "");

		const { promise: renderedGeneration, resolve: onGeneratedRender } = Promise.withResolvers<void>();
		selector.setOnRequestRender(() => {
			if (opened?.field.getValue() === "Auto Generated Beta") {
				onGeneratedRender();
			}
		});

		selector.handleInput("\x1bt");
		finishGenerate("Auto Generated Beta");
		await renderedGeneration;

		expect(generatedTitles).toEqual([beta.id]);
		expect(opened!.field.getValue()).toBe("Auto Generated Beta");
		expect(renamed.calls).toEqual([]);

		const updated = renderedWhen(
			selector,
			p => p.items?.find(item => item.id === beta.path)?.label === "Auto Generated Beta",
		);
		selector.handleInput("\r");
		await updated;

		expect(renamed.calls).toEqual([{ id: "b", title: "Auto Generated Beta" }]);
		expect(renameDialogOf(selector)).toBeUndefined();
	});

	it("aborts onGenerateTitle and closes rename dialog on Esc", async () => {
		const renamed = { calls: [] as RenameCall[] };
		let abortSignal: AbortSignal | undefined;
		const { promise: pendingPromise, resolve: finishGenerate } = Promise.withResolvers<string>();

		const { selector, beta } = makeRename(renamed, {
			onGenerateTitle: async (s, signal) => {
				abortSignal = signal;
				return pendingPromise;
			},
		});

		selector.handleInput("\x1bOQ");
		expect(renameDialogOf(selector)).toBeDefined();

		selector.handleInput("\x1bt");
		expect(abortSignal).toBeDefined();
		expect(abortSignal!.aborted).toBe(false);

		selector.handleInput("\x1b");
		expect(abortSignal!.aborted).toBe(true);
		expect(renameDialogOf(selector)).toBeUndefined();

		finishGenerate("Late Title");
		await pendingPromise;

		expect(renamed.calls).toEqual([]);
		const after = props(selector.describe(withPicker));
		expect(after.items?.find(item => item.id === beta.path)?.label).toBe("Beta");
	});

	it("omits auto-title hint and disables Alt+T when app.session.generateTitle is unbound", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.session.generateTitle": [] }));
		let generateCalls = 0;
		const { selector } = makeRename(
			{ calls: [] },
			{
				onGenerateTitle: async () => {
					generateCalls++;
					return "Generated";
				},
			},
		);

		selector.handleInput("\x1bOQ");
		expect(renameDialogOf(selector)).toBeDefined();

		const rendered = selector.render(100).join("\n");
		expect(rendered).not.toContain("auto-title");

		const card = selector.describe(withoutPicker);
		expect(hintLabelsOf(card)).not.toContain("auto-title");

		selector.handleInput("\x1bt");
		expect(generateCalls).toBe(0);
	});

	it("displays an error message when onGenerateTitle resolves null", async () => {
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const { selector } = makeRename(
			{ calls: [] },
			{
				onGenerateTitle: async () => promise,
			},
		);
		selector.handleInput("\x1bOQ");
		expect(renameDialogOf(selector)).toBeDefined();
		let renders = 0;
		const { promise: renderedError, resolve: onRender } = Promise.withResolvers<void>();
		selector.setOnRequestRender(() => {
			if (++renders === 2) onRender();
		});

		selector.handleInput("\x1bt");
		resolve(null);
		await renderedError;
		const rendered = selector.render(100).join("\n");
		expect(rendered).toContain("Could not generate a title for this session.");

		const card = selector.describe(withoutPicker);
		const messageNode = (card.c ?? []).find(
			(child): child is NativeNode & { k: "text" } =>
				isNativeNode(child) && child.k === "text" && child.key === "message",
		);
		expect(messageNode).toBeDefined();
		expect(messageNode?.p?.spans?.[0]).toMatchObject({
			t: expect.stringContaining("Could not generate a title for this session."),
		});
	});

	it("aborts onGenerateTitle when Enter is pressed while generating", async () => {
		const renamed = { calls: [] as RenameCall[] };
		let abortSignal: AbortSignal | undefined;
		const { promise: pendingPromise, resolve: finishGenerate } = Promise.withResolvers<string>();

		const { selector } = makeRename(renamed, {
			onGenerateTitle: async (_s, signal) => {
				abortSignal = signal;
				return pendingPromise;
			},
		});

		selector.handleInput("\x1bOQ");
		expect(renameDialogOf(selector)).toBeDefined();

		selector.handleInput("\x1bt");
		expect(abortSignal).toBeDefined();
		expect(abortSignal!.aborted).toBe(false);

		selector.handleInput("\r");
		expect(abortSignal!.aborted).toBe(true);

		finishGenerate("Late Title");
		await pendingPromise;
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

	it("hoists a keyed md picker from the dock and inserts on activate", () => {
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			source,
			prompt => inserted.push(prompt),
			() => {},
		);
		type(search, "deploy");
		const root = search.describe(withPicker);
		expect(root.k).toBe("col");
		const sheet = (root.c as NativeNode[])[0]!;
		expect(sheet.key).toBe("picker");
		const p = props(sheet);
		expect(p.size).toBe("md");
		expect(p.items).toHaveLength(1);
		expect(p.items?.[0]).toMatchObject({ label: "deploy the release", hits: [[0, 6]], detail: "/work/app" });

		search.handleNativeEvent({ type: "activate", key: "^picker", item: p.items![0]!.id });
		expect(inserted).toEqual(["deploy the release\nwith notes"]);
		expect(search.describe(withoutPicker).k).toBe("card");
	});
});
