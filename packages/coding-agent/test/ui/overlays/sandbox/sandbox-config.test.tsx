/**
 * The `/sandbox` sheet over a recording host that applies every callback to
 * its model and pushes it back (as `/sandbox` does): keys through a plain
 * terminal, and Tern's UI events against the `prefs` node it describes.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { setNativeRenderingForTest, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import type {
	SandboxConfigCallbacks,
	SandboxConfigModel,
	SandboxListId,
	SandboxSettingChange,
	SandboxSettingId,
} from "../../../../src/modes/view-model/overlays/sandbox-config";
import { type SandboxConfigHandle, SandboxConfigOverlay } from "../../../../src/ui/overlays/sandbox/sandbox-config";
import { findKind, mountOverlay } from "../../../helpers/overlay-terminal";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const BASE_MODEL: SandboxConfigModel = {
	status: { state: "active", backend: "seatbelt", network: "allowlist", warnings: [] },
	enabled: false,
	mode: "workspace-write",
	scope: ["bash", "eval", "exec"],
	fallback: "warn",
	readScope: "all",
	networkMode: "allowlist",
	networkUnavailable: {},
	allowWrite: [],
	allowRead: [],
	denyRead: [],
	allowedHosts: [],
	ignored: [],
	locked: {},
	listNotes: {},
	effective: { readwritePaths: [], readonlyPaths: [], deniedPaths: [] },
	blockedHosts: [],
	sessionPaths: { write: [], read: [] },
	sessionExec: [],
	created: [],
};

type HostCall =
	| ["set", SandboxSettingChange]
	| ["reset", SandboxSettingId]
	| ["add" | "remove", SandboxListId, string]
	| ["replace", SandboxListId, string, string]
	| ["allow", string]
	| ["revoke", "write" | "read", string]
	| ["revokeExec" | "trust" | "forget", string]
	| ["close"];

type EventInit = UiEvent extends infer E ? (E extends UiEvent ? Omit<E, "key" | "mods"> : never) : never;

interface Sheet {
	readonly term: TestTerminal;
	readonly calls: HostCall[];
	readonly handle: SandboxConfigHandle;
	/** Replace the model as a runtime change would. */
	push(next: Partial<SandboxConfigModel>): void;
	press(...keys: string[]): void;
	/** The painted window as plain text. */
	screen(): string;
	/** The `prefs` node's props, as Tern receives them. */
	props(): TspPrefsProps;
	/** Deliver a Tern UI event to the `prefs` node. */
	send(event: EventInit): void;
}

let mounted: TestTerminal | undefined;
afterEach(() => {
	mounted?.dispose();
	mounted = undefined;
	setNativeRenderingForTest(false);
});

function open(initial: Partial<SandboxConfigModel> = {}, columns = 120): Sheet {
	const calls: HostCall[] = [];
	let model: SandboxConfigModel = { ...BASE_MODEL, ...initial };
	let handle: SandboxConfigHandle | undefined;
	const push = (next: Partial<SandboxConfigModel>): void => {
		model = { ...model, ...next };
		handle!.setModel(model);
	};
	const callbacks: SandboxConfigCallbacks = {
		set: change => {
			calls.push(["set", change]);
			push({ [change.id]: change.value });
		},
		reset: id => void calls.push(["reset", id]),
		addEntry: (list, entry) => {
			calls.push(["add", list, entry]);
			push({ [list]: [...model[list], entry] });
		},
		removeEntry: (list, entry) => {
			calls.push(["remove", list, entry]);
			push({ [list]: model[list].filter(existing => existing !== entry) });
		},
		replaceEntry: (list, previous, next) => {
			calls.push(["replace", list, previous, next]);
			push({ [list]: model[list].map(existing => (existing === previous ? next : existing)) });
		},
		allowHost: host => void calls.push(["allow", host]),
		revokePath: (kind, p) => {
			calls.push(["revoke", kind, p]);
			push({ sessionPaths: { ...model.sessionPaths, [kind]: model.sessionPaths[kind].filter(x => x !== p) } });
		},
		revokeExec: target => void calls.push(["revokeExec", target]),
		trustCreated: p => void calls.push(["trust", p]),
		forgetCreated: p => void calls.push(["forget", p]),
		close: () => void calls.push(["close"]),
	};
	const term = mountOverlay(
		() =>
			SandboxConfigOverlay({
				model,
				callbacks,
				ref: next => {
					handle = next;
				},
			}),
		{ columns, rows: 40, focusKind: "prefs" },
	);
	mounted = term;
	const node = (): UiNode => findKind(term.surface.layer()[0]!, "prefs")!;
	return {
		term,
		calls,
		handle: handle!,
		push,
		press: (...keys) => {
			for (const key of keys) term.press(key);
		},
		screen: () => {
			term.render();
			return (term.fullscreen() ?? term.screen()).map(row => Bun.stripANSI(row)).join("\n");
		},
		props: () => node().props() as unknown as TspPrefsProps,
		send: event => void bubbleEvent([node()], { key: "", mods: [], ...event } as UiEvent),
	};
}

/** `open` as a Tern terminal sees it (the status is the lead, not rows). */
function openNative(initial: Partial<SandboxConfigModel> = {}): Sheet {
	setNativeRenderingForTest(true);
	return open(initial);
}

function rowOf(props: TspPrefsProps, id: string): TspPrefsRow | undefined {
	for (const section of props.sections) for (const r of section.rows) if (r.id === id) return r;
	return undefined;
}

/** A list entry's row id: keyed by its value, with `%` and `=` escaped. */
function entryId(list: string, value: string): string {
	return `${list}:entry:${value.replaceAll("%", "%25").replaceAll("=", "%3D")}`;
}

const flat = (text: string): string => text.replace(/[│\s]+/g, " ");

describe("/sandbox sheet in a plain terminal", () => {
	it("adds a writable path from the keyboard and removes it by clearing its text", () => {
		const s = open({ status: { state: "unavailable", reason: "bwrap not found", fallback: "warn" } });
		expect(s.screen()).toContain("Unavailable · running unsandboxed · bwrap not found");

		// Filesystem page (nothing selected after the page switch): Read scope, then the Writable list's "Add path" row.
		s.press("tab", "down", "down", "enter");
		s.term.type("~/build-cache");
		expect(s.screen()).toContain("~/build-cache");
		s.press("enter");
		expect(s.calls).toEqual([["add", "allowWrite", "~/build-cache"]]);
		expect(s.screen()).toMatch(/Writable[^]*Path\s+~\/build-cache[^]*Add path/);

		// Focus stays on "Add path"; the entry is the row above. Open it, clear it and save.
		s.press("up", "enter");
		for (let i = 0; i < "~/build-cache".length; i++) s.press("backspace");
		s.press("enter");
		expect(s.calls.at(-1)).toEqual(["remove", "allowWrite", "~/build-cache"]);
		expect(s.screen()).not.toContain("~/build-cache");
	});

	it("toggles Enabled, steps a choice both ways with wrap-around and keeps scope in canonical order", () => {
		const s = open({ scope: ["bash", "exec"] });
		s.press("enter");
		s.press("down", "right", "right", "left");
		// "Applies to" opens its options; ↓ highlights eval, Space toggles it.
		s.press("down", "enter", "down", "space", "escape");
		expect(s.calls).toEqual([
			["set", { id: "enabled", value: true }],
			["set", { id: "mode", value: "read-only" }],
			["set", { id: "mode", value: "workspace-write" }],
			["set", { id: "mode", value: "read-only" }],
			["set", { id: "scope", value: ["bash", "eval", "exec"] }],
		]);
		// The first Esc closed the options, the second closes the sheet.
		s.press("escape");
		expect(s.calls.at(-1)).toEqual(["close"]);
	});

	it("allows the focused blocked host even when a refresh reorders the list before Enter", () => {
		const s = open({ blockedHosts: ["a.example", "b.example"] });
		// Network page: Mode, Add host, then the blocked hosts.
		s.press("tab", "tab", "down", "down", "down", "down");
		s.push({ blockedHosts: ["new.example", "a.example", "b.example"] });
		s.press("enter");
		expect(s.calls).toEqual([["allow", "b.example"]]);
	});

	it("after an Allow removes the host, selects the list's Add row: a second Enter allows no other host", () => {
		const s = open({ blockedHosts: ["a.example", "b.example"] });
		s.press("tab", "tab", "down", "down", "down", "enter");
		s.push({ blockedHosts: ["b.example"] });
		// Enter opens the Add draft: it neither allows b.example nor changes the mode.
		expect(s.screen()).not.toContain("New host");
		s.press("enter");
		expect(s.screen()).toContain("New host");
		s.press("escape");
		expect(s.calls).toEqual([["allow", "a.example"]]);
	});

	describe("with the Add row of the list locked", () => {
		const locked = "Set by a session override";

		it("after Trust of the last record, selects nothing: a second Enter changes no setting", () => {
			const s = open({ locked: { allowWrite: locked }, created: [{ path: "/work/.vscode", exists: false }] });
			// Filesystem: Read scope, the unlocked Add rows (Readable, Denied), then the record's Trust row.
			s.press("tab", "down", "down", "down", "down", "enter");
			expect(s.calls).toEqual([["trust", "/work/.vscode"]]);
			s.push({ created: [] });
			s.press("enter", "space");
			expect(s.calls).toEqual([["trust", "/work/.vscode"]]);
		});

		it("after Allow of the last blocked host, selects nothing: a second Enter changes no setting", () => {
			const s = open({ locked: { allowedHosts: locked }, blockedHosts: ["a.example"] });
			// Network: Mode, then the blocked host (the Add row is disabled).
			s.press("tab", "tab", "down", "down", "enter");
			expect(s.calls).toEqual([["allow", "a.example"]]);
			s.push({ blockedHosts: [] });
			s.press("enter", "space");
			expect(s.calls).toEqual([["allow", "a.example"]]);
		});

		it("after Revoke of the last session grant, selects nothing: a second Enter changes no setting", () => {
			const s = open({ locked: { allowWrite: locked }, sessionPaths: { write: ["/work/out"], read: [] } });
			s.press("tab", "down", "down", "down", "down", "enter");
			expect(s.calls).toEqual([["revoke", "write", "/work/out"]]);
			s.press("enter", "space");
			expect(s.calls).toEqual([["revoke", "write", "/work/out"]]);
		});
	});

	it("when the selected setting becomes locked, selects nothing: Enter and Space change no setting", () => {
		const s = open();
		s.press("down"); // Mode
		s.push({ locked: { mode: "Set by a session override" } });
		s.press("enter", "space");
		expect(s.calls).toEqual([]);
	});

	it("on a fresh sheet, when Enabled becomes locked after Enter, selects nothing: a second Enter changes no setting", () => {
		const s = open();
		// No ↓ first: the fresh sheet's selection is the first row, Enabled.
		s.press("enter");
		expect(s.calls).toEqual([["set", { id: "enabled", value: true }]]);
		// The project layer keeps it on, so the write is locked; Mode must not inherit the selection.
		s.push({ locked: { enabled: "Set by the project settings" } });
		s.press("enter", "space");
		expect(s.calls).toEqual([["set", { id: "enabled", value: true }]]);
	});

	it("lists session grants under Allowed this session and removes them in turn, never touching a setting", () => {
		const empty = open();
		empty.press("tab");
		expect(empty.screen()).not.toContain("Allowed this session");
		empty.term.dispose();

		const s = open({ sessionPaths: { write: ["/work/out"], read: ["/data/in"] } });
		// Filesystem: Read scope, the three lists' Add rows, then the session grants.
		s.press("tab");
		expect(s.screen()).toMatch(/Allowed this session[^]*Write {2}\/work\/out[^]*Read {2}\/data\/in/);
		s.press("down", "down", "down", "down", "down", "enter", "enter");
		expect(s.calls).toEqual([
			["revoke", "write", "/work/out"],
			["revoke", "read", "/data/in"],
		]);
		expect(s.screen()).not.toContain("Allowed this session");
		// The selection fell back to an Add row: Enter opens a draft instead of stepping Read scope.
		s.press("enter");
		expect(s.screen()).toContain("New path");
		expect(s.calls.some(call => call[0] === "set")).toBe(false);
	});

	it("after Revoke of the last host-action grant, selects nothing: a second Enter leaves Enabled unchanged", () => {
		const s = open({ sessionExec: ["debug:launch /work/app"] });
		// Overview, ↑ from Enabled wraps to the last row: the grant's Revoke.
		s.press("up", "enter");
		expect(s.calls).toEqual([["revokeExec", "debug:launch /work/app"]]);
		s.push({ sessionExec: [] });
		s.press("enter", "space");
		expect(s.calls).toEqual([["revokeExec", "debug:launch /work/app"]]);
	});

	it("after Revoke of one of several host-action grants, selects a remaining grant, never a setting", () => {
		const s = open({ sessionExec: ["debug:a", "debug:b"] });
		s.press("up", "enter");
		expect(s.calls).toEqual([["revokeExec", "debug:b"]]);
		s.push({ sessionExec: ["debug:a"] });
		s.press("enter");
		expect(s.calls).toEqual([
			["revokeExec", "debug:b"],
			["revokeExec", "debug:a"],
		]);
	});

	it("after a page switch selects nothing: Enter and Space change no setting until the selection moves", () => {
		const s = open();
		expect(s.screen()).toContain("❯ Enabled");
		// Filesystem, Network, Effective policy, back to Overview.
		for (let page = 0; page < 4; page++) {
			s.press("tab");
			// No row carries the cursor, not even the read-only status row at the top.
			expect(s.screen()).not.toContain("❯");
			s.press("enter", "space");
			expect(s.calls).toEqual([]);
		}
		// The first ↓ selects the page's first row (Enabled): Enter acts on what the user can see selected.
		s.press("down", "enter");
		expect(s.calls).toEqual([["set", { id: "enabled", value: true }]]);
	});

	it("after a page switch ↑ selects the page's last row", () => {
		const s = open({ sessionExec: ["debug:a"] });
		s.press("tab", "tab", "tab", "tab");
		s.press("up", "enter");
		expect(s.calls).toEqual([["revokeExec", "debug:a"]]);
	});

	it("after a page switch ←→ keep switching pages: they do not step the page's first choice", () => {
		const s = open();
		s.press("tab", "right");
		expect(s.screen()).toContain("Allowed hosts"); // the Network page: the switch moved on, no choice stepped
		expect(s.screen()).not.toContain("Read scope");
		s.press("left", "left", "right");
		expect(s.screen()).toContain("Read scope");
		expect(s.calls).toEqual([]);
	});

	describe("created-by-sandbox records", () => {
		const gone = (...names: string[]) => names.map(name => ({ path: `/work/${name}`, exists: false }));
		const downs = (n: number) => Array.from({ length: n }, () => "down");

		it("after Remove record, keeps the selection on the next record's Remove row, never its Trust row", () => {
			const s = open({ created: gone(".vscode", ".claude", ".omp") });
			// Filesystem: Read scope, three Add rows, then per record a Trust row and a Remove row.
			s.press("tab", ...downs(6), "enter");
			expect(s.calls).toEqual([["forget", "/work/.vscode"]]);
			s.push({ created: gone(".claude", ".omp") });
			s.press("enter");
			expect(s.calls).toEqual([
				["forget", "/work/.vscode"],
				["forget", "/work/.claude"],
			]);
		});

		it("after Trust, keeps the selection off every Trust row: the next record's Remove row", () => {
			const s = open({ created: gone(".vscode", ".claude", ".omp") });
			s.press("tab", ...downs(5), "enter");
			s.push({ created: gone(".claude", ".omp") });
			// A second Enter acts on the Remove row (it only drops a record), never trusting another path.
			s.press("enter");
			s.push({ created: gone(".omp") });
			s.press("enter");
			expect(s.calls).toEqual([
				["trust", "/work/.vscode"],
				["forget", "/work/.claude"],
				["forget", "/work/.omp"],
			]);
		});

		it("after Remove on the last record, moves to the previous record's Remove row", () => {
			const s = open({ created: gone(".vscode", ".claude") });
			s.press("tab", ...downs(8), "enter");
			expect(s.calls).toEqual([["forget", "/work/.claude"]]);
			s.push({ created: gone(".vscode") });
			s.press("enter");
			expect(s.calls).toEqual([
				["forget", "/work/.claude"],
				["forget", "/work/.vscode"],
			]);
		});

		it("with no record left, falls back to the Writable Add row", () => {
			const s = open({ created: gone(".vscode") });
			s.press("tab", ...downs(6), "enter");
			s.push({ created: [] });
			// The Add row opens a draft instead of acting on a record.
			s.press("enter");
			expect(s.screen()).toContain("New path");
			expect(s.calls).toEqual([["forget", "/work/.vscode"]]);
		});

		it("after Remove, skips records whose path exists (their Remove row is disabled) and acts on none", () => {
			const records = [
				{ path: "/work/.vscode", exists: false },
				{ path: "/work/.claude", exists: true },
				{ path: "/work/.omp", exists: true },
			];
			const s = open({ created: records });
			s.press("tab", ...downs(6), "enter");
			expect(s.calls).toEqual([["forget", "/work/.vscode"]]);
			s.push({ created: records.slice(1) });
			// No enabled Remove row is left: the selection is the Writable Add row, which opens a draft.
			s.press("enter");
			expect(s.calls).toEqual([["forget", "/work/.vscode"]]);
		});

		it("moves off a focused Remove row whose path reappeared, onto the next enabled Remove row", () => {
			const s = open({ created: gone(".vscode", ".claude") });
			s.press("tab", ...downs(6));
			s.push({ created: [{ path: "/work/.vscode", exists: true }, ...gone(".claude")] });
			s.press("enter");
			expect(s.calls).toEqual([["forget", "/work/.claude"]]);
		});

		it("after Trust with only existing records left (Remove rows disabled), falls to the Writable Add row", () => {
			const s = open({ created: [...gone(".vscode"), { path: "/work/.claude", exists: true }] });
			s.press("tab", ...downs(5), "enter");
			s.push({ created: [{ path: "/work/.claude", exists: true }] });
			// Enter opens the Add draft: it neither trusts the remaining record nor writes anything.
			s.press("enter", "escape");
			expect(s.calls).toEqual([["trust", "/work/.vscode"]]);
		});
	});

	it("names a locked setting's reason on its row, and ↓ skips the row", () => {
		const s = open({ locked: { mode: "Set by a session override" } });
		expect(s.screen()).toMatch(/Mode\s+workspace-write · Set by a session override/);
		// ↓ from Enabled lands on "Applies to": → is no choice step there, it switches the page.
		s.press("down", "right");
		expect(s.calls).toEqual([]);
		expect(s.screen()).toContain("Read scope");
	});

	it("shows a list's note under the list and a rejected edit's notice without changing the frame height", () => {
		const s = open({
			listNotes: { allowedHosts: "Project config narrows this list here: 1 entry does not apply." },
			ignored: [{ id: "sandbox.network.allowedHosts", reason: "dropped" }],
		});
		// The ignored setting is named without the common prefix.
		expect(s.screen()).toMatch(/network\.allowedHosts ⚠\s+dropped/);
		const before = s.screen().split("\n").length;
		s.handle.setNotice("unknown path token $HOME");
		expect(s.screen()).toContain("unknown path token $HOME");
		expect(s.screen().split("\n").length).toBe(before);
		s.press("tab", "tab");
		expect(s.screen()).toMatch(/Allowed hosts[^]*Add host[^]*Note[^]*Project config narrows this list here/);
		s.handle.setNotice(undefined);
		expect(s.screen()).not.toContain("unknown path token");
	});

	it("removes the focused entry with Delete", () => {
		const s = open({ allowRead: ["/data"] });
		// Filesystem: Read scope, Add path (Writable), then the Readable entry.
		s.press("tab", "down", "down", "down", "delete");
		expect(s.calls).toEqual([["remove", "allowRead", "/data"]]);
	});

	describe("list entries are identified by value, not by position", () => {
		// Filesystem: Read scope, the Writable and Readable Add rows, then the Denied entries.
		const selectDenied = (s: Sheet, position: number): void =>
			s.press("tab", ...Array.from({ length: 3 + position }, () => "down"));

		it("Delete after an outside reload removed the selected entry removes nothing, not the entry that took its slot", () => {
			const s = open({ denyRead: ["/a", "/b", "/c"] });
			selectDenied(s, 2);
			s.push({ denyRead: ["/a", "/c"] });
			s.press("delete", "backspace");
			expect(s.calls).toEqual([]);
			expect(s.screen()).toContain("/c");
		});

		it("Delete after an outside reload reordered the list removes the entry that was selected", () => {
			const s = open({ denyRead: ["/a", "/b"] });
			selectDenied(s, 2);
			s.push({ denyRead: ["/b", "/a"] });
			s.press("delete");
			expect(s.calls).toEqual([["remove", "denyRead", "/b"]]);
		});

		it("Enter on a selection whose entry vanished opens the Add draft, not another entry's edit", () => {
			const s = open({ denyRead: ["/a", "/b", "/c"] });
			selectDenied(s, 2);
			s.push({ denyRead: ["/a", "/c"] });
			s.press("enter");
			expect(s.screen()).toContain("New path");
			s.press("escape");
			expect(s.calls).toEqual([]);
		});

		it("drops an open draft whose entry vanished, so its submit changes nothing", () => {
			const s = open({ denyRead: ["/a", "/b", "/c"] });
			selectDenied(s, 2);
			s.press("enter");
			expect(s.screen()).toContain("enter save");
			s.push({ denyRead: ["/a", "/c"] });
			expect(s.screen()).not.toContain("enter save");
			s.press("enter");
			expect(s.calls).toEqual([]);
		});

		it("keeps the selection on an entry after its edit lands under the new value", () => {
			const s = open({ denyRead: ["/a", "/b"] });
			selectDenied(s, 2);
			s.press("enter");
			s.term.type("2");
			s.press("enter");
			expect(s.calls).toEqual([["replace", "denyRead", "/b", "/b2"]]);
			// The selection is the edited entry: Delete removes it, not the Add row's neighbour.
			s.press("delete");
			expect(s.calls.at(-1)).toEqual(["remove", "denyRead", "/b2"]);
		});

		it("Delete moves the selection to the next entry, so a second Delete removes it", () => {
			const s = open({ denyRead: ["/a", "/b", "/c"] });
			selectDenied(s, 1);
			s.press("delete", "delete");
			expect(s.calls).toEqual([
				["remove", "denyRead", "/a"],
				["remove", "denyRead", "/b"],
			]);
		});

		it("shows a duplicated value once: it is selectable and removable as one entry", () => {
			const s = open({ denyRead: ["/a", "/a", "/b"] });
			selectDenied(s, 2);
			s.press("delete");
			expect(s.calls).toEqual([["remove", "denyRead", "/b"]]);
		});

		it("handles an entry that is not well-formed UTF-16", () => {
			const lone = "/x\ud800";
			const s = open({ denyRead: [lone] });
			expect(() => s.screen()).not.toThrow();
			selectDenied(s, 1);
			expect(() => s.screen()).not.toThrow();
			s.press("delete");
			expect(s.calls).toEqual([["remove", "denyRead", lone]]);
		});

		it("handles entries with separator, equals and percent characters", () => {
			const odd = "~/a:b=c%20d";
			const s = open({ denyRead: [odd] });
			selectDenied(s, 1);
			s.press("delete");
			expect(s.calls).toEqual([["remove", "denyRead", odd]]);
		});
	});

	it("pastes into an open draft as one line", () => {
		const s = open();
		s.press("tab", "down", "down", "enter");
		s.term.paste("~/a\nb");
		s.press("enter");
		expect(s.calls).toEqual([["add", "allowWrite", "~/ab"]]);
	});

	it("moves over the read-only rows of the resolved policy, so the page scrolls, and Enter edits none", () => {
		const s = open({ effective: { readwritePaths: ["/work"], readonlyPaths: ["/usr"], deniedPaths: [] } });
		s.press("tab", "tab", "tab");
		expect(s.screen()).not.toContain("❯");
		s.press("down", "down");
		expect(s.screen()).toMatch(/❯ Path\s+\/usr/);
		s.press("enter", "delete");
		expect(s.screen()).not.toContain("enter save");
		expect(s.calls).toEqual([]);
	});

	it("Esc on a draft cancels it on the same page, adding nothing; Esc again closes", () => {
		const s = open();
		s.press("tab", "down", "down", "enter");
		s.term.type("x");
		s.press("escape");
		expect(s.screen()).toContain("Writable");
		expect(s.calls).toEqual([]);
		s.press("escape");
		expect(s.calls).toEqual([["close"]]);
	});

	it("keeps hostile model text single-line, unescaped and within the width, on every page and in the prefs props", () => {
		const hostile = "evil\tvalue\x1b[31m with a tail long enough to overflow a forty column frame";
		const home = path.join(os.homedir(), "project\tdir");
		const model: Partial<SandboxConfigModel> = {
			status: { state: "unavailable", reason: hostile, fallback: "block" },
			ignored: [{ id: "sandbox.network.allowedHosts", reason: hostile }],
			blockedHosts: [`host\t\x1b[31m.example-with-a-very-long-name-that-overflows`],
			effective: { readwritePaths: [home], readonlyPaths: [], deniedPaths: [] },
		};
		const narrow = open(model, 40);
		for (let page = 0; page < 4; page++) {
			for (const row of narrow.screen().split("\n")) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(40);
				expect(row).not.toContain("\t");
				expect(row).not.toContain("[31m");
			}
			const props = JSON.stringify(narrow.props());
			expect(props).not.toContain("\\t");
			expect(props).not.toContain("\\u001b");
			narrow.press("tab");
		}
		narrow.term.dispose();

		const wide = open(model);
		// The consequence leads the status, so a long reason never hides it.
		expect(flat(wide.screen())).toContain("Unavailable · contained tools fail · evil value");
		wide.press("tab", "tab", "tab");
		expect(wide.screen()).toContain("~/project dir");
	});

	describe("network modes the host cannot enforce", () => {
		const missing =
			'Network mode "allow" needs slirp4netns on this host; missing: slirp4netns. Install it to use it.';
		const unavailable = { allow: missing, allowlist: 'Network mode "allowlist" is unavailable: no namespaces.' };

		it("names each reason on the Network page", () => {
			const s = open({ networkMode: "deny", networkUnavailable: unavailable });
			s.press("tab", "tab");
			const page = flat(s.screen());
			expect(page).toContain('allow ⚠ Network mode "allow" needs slirp4netns');
			expect(page).toContain('allowlist ⚠ Network mode "allowlist" is unavailable: no namespaces.');
		});

		it("never writes an unavailable option: stepping onto it shows its reason as a notice", () => {
			const s = open({ networkMode: "deny", networkUnavailable: unavailable });
			s.press("tab", "tab");
			expect(s.screen()).not.toContain("Rejected");
			s.press("down", "right");
			expect(s.calls).toEqual([]);
			expect(flat(s.screen())).toContain('Rejected ⚠ Network mode "allow" needs');
			s.press("enter", "left");
			expect(s.calls).toEqual([]);
		});

		it("still steps to the available options, skipping the unavailable one", () => {
			const s = open({ networkMode: "deny", networkUnavailable: { allow: missing } });
			s.press("tab", "tab", "down", "right");
			expect(s.calls).toEqual([["set", { id: "networkMode", value: "allowlist" }]]);
			// From allowlist, ← wraps over the unavailable allow to deny.
			s.press("left");
			expect(s.calls.at(-1)).toEqual(["set", { id: "networkMode", value: "deny" }]);
			s.press("enter");
			expect(s.calls.at(-1)).toEqual(["set", { id: "networkMode", value: "allowlist" }]);
		});

		it("shows the reason on the Overview when the sandbox is not active and the configured mode is the unavailable one", () => {
			const s = open({ status: { state: "off" }, networkMode: "allow", networkUnavailable: { allow: missing } });
			expect(flat(s.screen())).toContain('Network allow ⚠ Network mode "allow" needs');
			s.term.dispose();
			const fine = open({ status: { state: "off" }, networkMode: "deny", networkUnavailable: { allow: missing } });
			expect(fine.screen()).not.toContain("slirp4netns");
		});
	});
});

describe("/sandbox sheet as a native prefs page", () => {
	const MODEL: Partial<SandboxConfigModel> = {
		allowWrite: ["~/cache"],
		denyRead: ["~/.ssh"],
		allowedHosts: ["github.com"],
		ignored: [{ id: "sandbox.enabled", reason: "project config sets false, looser than true" }],
		effective: { readwritePaths: ["/work"], readonlyPaths: ["/usr"], deniedPaths: ["/home/u/.ssh"] },
		blockedHosts: ["evil.example"],
	};

	it("draws the four pages with the status as the lead and the settings as typed controls", () => {
		const s = openNative(MODEL);
		const props = s.props();
		expect(props.pages.map(page => page.id)).toEqual(["overview", "filesystem", "network", "effective"]);
		expect(props.lead).toBe("Active · seatbelt · network allowlist");
		expect(rowOf(props, "status")).toBeUndefined();
		expect(rowOf(props, "enabled")?.control).toEqual({ k: "switch", on: false });
		expect(rowOf(props, "scope")?.control).toMatchObject({ k: "multi", values: ["bash", "eval", "exec"] });
		// A loosening the project tried is shown once, read-only, as a warning.
		expect(rowOf(props, "ignored:0")).toMatchObject({
			label: "enabled",
			warning: "project config sets false, looser than true",
			control: { k: "text", value: "" },
		});
		expect(rowOf(props, "ignored:0")?.disabled).toBeDefined();
	});

	it("explains a degraded runtime with its warnings on the overview", () => {
		const warning = "Network allowlist needs loopback proxy confinement; network is denied instead.";
		const s = openNative({
			status: { state: "active", backend: "bubblewrap", network: "deny", warnings: [warning] },
		});
		expect(s.props().sections.find(section => section.id === "warnings")?.rows).toEqual([
			expect.objectContaining({ id: "warning:0", warning }),
		]);
	});

	it("applies switch, choice and multi changes as typed setting writes, and null as a reset", () => {
		const s = openNative(MODEL);
		s.send({ type: "change", item: "enabled", value: true });
		s.send({ type: "change", item: "mode", value: "read-only" });
		s.send({ type: "change", item: "mode", value: "bogus" });
		s.send({ type: "change", item: "scope", value: ["exec", "bash", "nope"] });
		s.send({ type: "change", item: "fallback", value: null });
		expect(s.calls).toEqual([
			["set", { id: "enabled", value: true }],
			["set", { id: "mode", value: "read-only" }],
			["set", { id: "scope", value: ["bash", "exec"] }],
			["reset", "fallback"],
		]);
		// The host's refreshed model reaches the page.
		expect(rowOf(s.props(), "enabled")?.control).toEqual({ k: "switch", on: true });
		expect(rowOf(s.props(), "mode")?.control).toMatchObject({ value: "read-only" });
	});

	it("opens the scope options on activate and toggles them by change", () => {
		const s = openNative({ scope: ["bash"] });
		s.send({ type: "activate", item: "scope" });
		expect(s.props().editing).toEqual({ row: "scope", option: "bash" });
		s.send({ type: "select", item: "scope=exec" });
		expect(s.props().editing).toEqual({ row: "scope", option: "exec" });
		s.send({ type: "change", item: "scope", value: ["exec", "bash"] });
		expect(s.calls).toEqual([["set", { id: "scope", value: ["bash", "exec"] }]]);
		s.send({ type: "action", act: "close", value: "scope" });
		expect(s.props().editing ?? null).toBeNull();
		expect(s.calls).toEqual([["set", { id: "scope", value: ["bash", "exec"] }]]);
	});

	it("disables a locked setting with its reason and ignores changes and activation of it", () => {
		const s = openNative({ ...MODEL, locked: { enabled: "Set by $PI_SANDBOX" } });
		expect(rowOf(s.props(), "enabled")?.disabled).toBe("Set by $PI_SANDBOX");
		s.send({ type: "change", item: "enabled", value: true });
		s.send({ type: "activate", item: "enabled" });
		expect(s.calls).toEqual([]);
	});

	it("opens no draft on a locked list: its Add row and entries are disabled", () => {
		const s = openNative({ ...MODEL, locked: { allowWrite: "Set by a session override" } });
		s.send({ type: "action", act: "page", value: "filesystem" });
		expect(rowOf(s.props(), "allowWrite:add")?.disabled).toBe("Set by a session override");
		s.send({ type: "action", act: "add", value: "allowWrite:add" });
		s.send({ type: "activate", item: entryId("allowWrite", "~/cache") });
		expect(s.props().editing ?? null).toBeNull();
		expect(rowOf(s.props(), "allowWrite:new")).toBeUndefined();
		// An unlocked list still opens its draft.
		s.send({ type: "action", act: "add", value: "allowRead:add" });
		expect(s.props().editing).toMatchObject({ row: "allowRead:new" });
	});

	it("shows a rejected edit's notice in the lead until cleared", () => {
		const s = openNative(MODEL);
		s.handle.setNotice("unknown path token $HOME");
		expect(s.props().lead).toBe("Active · seatbelt · network allowlist — unknown path token $HOME");
		s.handle.setNotice(undefined);
		expect(s.props().lead).toBe("Active · seatbelt · network allowlist");
	});

	it("adds a path through the add action and a draft row, edits an entry and removes a cleared one", () => {
		const s = openNative(MODEL);
		s.send({ type: "action", act: "page", value: "filesystem" });
		expect(s.props().page).toBe("filesystem");
		expect(rowOf(s.props(), entryId("allowWrite", "~/cache"))?.control).toEqual({
			k: "text",
			value: "~/cache",
			mono: true,
		});

		s.send({ type: "action", act: "add", value: "allowWrite:add" });
		expect(s.props().editing).toMatchObject({ row: "allowWrite:new", draft: "" });
		s.send({ type: "change", item: "allowWrite:new", value: "  /opt/tools  " });
		expect(s.calls.at(-1)).toEqual(["add", "allowWrite", "/opt/tools"]);
		expect(rowOf(s.props(), "allowWrite:new")).toBeUndefined();
		expect(rowOf(s.props(), entryId("allowWrite", "/opt/tools"))?.control).toMatchObject({ value: "/opt/tools" });

		s.send({ type: "change", item: entryId("allowWrite", "~/cache"), value: "~/cache2" });
		expect(s.calls.at(-1)).toEqual(["replace", "allowWrite", "~/cache", "~/cache2"]);

		s.send({ type: "change", item: entryId("denyRead", "~/.ssh"), value: "   " });
		expect(s.calls.at(-1)).toEqual(["remove", "denyRead", "~/.ssh"]);
		expect(rowOf(s.props(), entryId("denyRead", "~/.ssh"))).toBeUndefined();
		// The emptied list's Add row takes the selection.
		expect(s.props().focus).toBe("denyRead:add");
	});

	it("addresses entries by value: a change to an entry removed outside acts on nothing, and odd values are valid ids", () => {
		const odd = "~/a:b=c%20d";
		const s = openNative({ ...MODEL, denyRead: ["/a", "/b", odd] });
		s.send({ type: "action", act: "page", value: "filesystem" });
		expect(rowOf(s.props(), entryId("denyRead", odd))?.control).toMatchObject({ value: odd });
		s.send({ type: "select", item: entryId("denyRead", "/b") });
		expect(s.props().focus).toBe(entryId("denyRead", "/b"));
		s.push({ denyRead: ["/a", odd] });
		// The selection no longer resolves: the list's Add row takes it, and the stale id removes nothing.
		expect(s.props().focus).toBe("denyRead:add");
		s.send({ type: "change", item: entryId("denyRead", "/b"), value: null });
		expect(s.calls).toEqual([]);
		s.send({ type: "change", item: entryId("denyRead", odd), value: null });
		expect(s.calls).toEqual([["remove", "denyRead", odd]]);
	});

	it("cancels a draft on close or on picking another row, adding nothing, and leaves the selection on Add", () => {
		const s = openNative(MODEL);
		s.send({ type: "action", act: "page", value: "network" });
		s.send({ type: "action", act: "add", value: "allowedHosts:add" });
		s.send({ type: "action", act: "close", value: "allowedHosts:new" });
		expect(s.props().editing ?? null).toBeNull();
		expect(rowOf(s.props(), "allowedHosts:new")).toBeUndefined();
		expect(s.props().focus).toBe("allowedHosts:add");

		s.send({ type: "action", act: "add", value: "allowedHosts:add" });
		s.send({ type: "select", item: "networkMode" });
		expect(rowOf(s.props(), "allowedHosts:new")).toBeUndefined();
		expect(s.props().editing ?? null).toBeNull();

		s.send({ type: "action", act: "add", value: "allowedHosts:add" });
		s.send({ type: "change", item: "allowedHosts:new", value: "" });
		expect(s.calls).toEqual([]);
		s.send({ type: "action", act: "close" });
		expect(s.calls).toEqual([["close"]]);
	});

	it("allows the host a blocked row names, even after the list was refreshed", () => {
		const s = openNative({ ...MODEL, blockedHosts: ["evil.example", "cdn.example"] });
		s.send({ type: "action", act: "page", value: "network" });
		expect(rowOf(s.props(), "blocked:cdn.example")).toMatchObject({
			label: "cdn.example",
			control: { k: "action", act: "allow" },
		});
		// A refresh lands between drawing the row and the click: the click still names cdn.example.
		s.push({ blockedHosts: ["new.example", "cdn.example"] });
		s.send({ type: "action", act: "allow", value: "blocked:cdn.example" });
		s.send({ type: "action", act: "allow", value: "blocked:evil.example" });
		expect(s.calls).toEqual([["allow", "cdn.example"]]);
	});

	it("lists session grants on the Filesystem page with a Remove action", () => {
		const s = openNative({ sessionPaths: { write: ["/work/out"], read: [] } });
		s.send({ type: "action", act: "page", value: "filesystem" });
		expect(s.props().sections.find(section => section.id === "session")?.rows).toEqual([
			expect.objectContaining({ control: { k: "action", label: "Remove", act: "remove" } }),
		]);
	});

	it("selects no row after a page switch, so the terminal has no Enter target until the user picks one", () => {
		const s = openNative(MODEL);
		expect(s.props().focus).toBe("enabled");
		for (const page of ["filesystem", "network", "effective", "overview"]) {
			s.send({ type: "action", act: "page", value: page });
			expect(s.props().focus ?? null).toBeNull();
		}
		s.send({ type: "select", item: "enabled" });
		expect(s.props().focus).toBe("enabled");
	});

	it("when Enabled becomes locked on a fresh page, selects no row: the focus does not move to Mode", () => {
		const s = openNative(MODEL);
		expect(s.props().focus).toBe("enabled");
		s.push({ locked: { enabled: "Set by the project settings" } });
		expect(s.props().focus ?? null).toBeNull();
	});

	it("after Revoke of the last host-action grant selects no row, never Enabled", () => {
		const target = "debug:launch /work/app";
		const s = openNative({ sessionExec: [target] });
		s.send({ type: "select", item: `exec:${target}` });
		s.send({ type: "action", act: "revoke", value: `exec:${target}` });
		s.push({ sessionExec: [] });
		expect(s.calls).toEqual([["revokeExec", target]]);
		expect(s.props().focus ?? null).toBeNull();
	});

	it("after Trust selects the next record's Remove row, never a Trust row", () => {
		const s = openNative({
			created: [
				{ path: "/work/.a", exists: false },
				{ path: "/work/.b", exists: false },
			],
		});
		s.send({ type: "action", act: "page", value: "filesystem" });
		s.send({ type: "select", item: "created:trust:/work/.a" });
		s.send({ type: "action", act: "trust", value: "created:trust:/work/.a" });
		s.push({ created: [{ path: "/work/.b", exists: false }] });
		expect(s.calls).toEqual([["trust", "/work/.a"]]);
		expect(s.props().focus).toBe("created:remove:/work/.b");
	});

	it("routes Trust, Remove and Revoke to the raw path and target, never forgetting a path that exists", () => {
		const raw = "/work/.omp\u001b[31m";
		const target = "debug:launch /work/app";
		const s = openNative({ created: [{ path: raw, exists: true }], sessionExec: [target] });
		s.send({ type: "action", act: "page", value: "filesystem" });
		const [trust, remove] = s.props().sections.find(section => section.id === "created")?.rows ?? [];
		s.send({ type: "action", act: "trust", value: trust!.id });
		s.send({ type: "action", act: "remove", value: remove!.id });
		s.send({ type: "action", act: "page", value: "overview" });
		const [revoke] = s.props().sections.find(section => section.id === "exec")?.rows ?? [];
		s.send({ type: "action", act: "revoke", value: revoke!.id });
		expect(s.calls).toEqual([
			["trust", raw],
			["revokeExec", target],
		]);
	});

	it("shows the resolved policy read-only: its rows ignore changes", () => {
		const s = openNative(MODEL);
		s.send({ type: "action", act: "page", value: "effective" });
		const props = s.props();
		expect(props.sections.map(section => section.title)).toEqual(["Writable", "Readable", "Denied"]);
		expect(rowOf(props, "rw:0")).toMatchObject({ control: { value: "/work" } });
		expect(rowOf(props, "rw:0")?.disabled).toBeDefined();
		s.send({ type: "change", item: "rw:0", value: "/elsewhere" });
		s.send({ type: "activate", item: "rw:0" });
		expect(s.calls).toEqual([]);
		expect(s.props().editing ?? null).toBeNull();
	});

	describe("network modes the host cannot enforce", () => {
		const missing =
			'Network mode "allow" needs slirp4netns on this host; missing: slirp4netns. Install it to use it.';
		const model: Partial<SandboxConfigModel> = { networkMode: "deny", networkUnavailable: { allow: missing } };

		it("labels the option unavailable with its reason as the detail and as a warning row", () => {
			const s = openNative(model);
			s.send({ type: "action", act: "page", value: "network" });
			const props = s.props();
			expect(rowOf(props, "networkMode")?.control).toMatchObject({
				k: "choice",
				value: "deny",
				options: [
					{ value: "allowlist", label: "allowlist" },
					{ value: "deny", label: "deny" },
					{ value: "allow", label: "allow (unavailable)", detail: missing },
				],
			});
			expect(rowOf(props, "networkUnavailable:allow")).toMatchObject({ label: "allow", warning: missing });
			expect(rowOf(props, "networkUnavailable:allow")?.disabled).toBeDefined();
			expect(rowOf(props, "networkUnavailable:allowlist")).toBeUndefined();
		});

		it("never writes an unavailable choice: it shows the reason in the lead, available ones still apply", () => {
			const s = openNative(model);
			s.send({ type: "action", act: "page", value: "network" });
			s.send({ type: "change", item: "networkMode", value: "allow" });
			expect(s.calls).toEqual([]);
			expect(s.props().lead).toContain(missing);
			s.send({ type: "change", item: "networkMode", value: "allowlist" });
			expect(s.calls).toEqual([["set", { id: "networkMode", value: "allowlist" }]]);
		});

		it("steps an activated row past the unavailable option", () => {
			const s = openNative(model);
			s.send({ type: "action", act: "page", value: "network" });
			s.send({ type: "activate", item: "networkMode" });
			expect(s.calls).toEqual([["set", { id: "networkMode", value: "allowlist" }]]);
		});

		it("shows the reason on the overview when the sandbox is not active and the configured mode is the unavailable one", () => {
			const s = openNative({
				status: { state: "off" },
				networkMode: "allow",
				networkUnavailable: { allow: missing },
			});
			expect(rowOf(s.props(), "networkUnavailable:allow")).toMatchObject({ warning: missing });
			s.push({ networkMode: "deny" });
			expect(rowOf(s.props(), "networkUnavailable:allow")).toBeUndefined();
		});

		it("shows the reason once on the overview of an active sandbox whose warnings already carry it", () => {
			const s = openNative({
				status: { state: "active", backend: "bubblewrap", network: "deny", warnings: [missing] },
				networkMode: "allow",
				networkUnavailable: { allow: missing },
			});
			const warnings = s
				.props()
				.sections.flatMap(section => section.rows)
				.filter(row => row.warning === missing);
			expect(warnings).toHaveLength(1);
			expect(rowOf(s.props(), "warning:0")?.warning).toBe(missing);
		});

		it("sanitizes a hostile reason", () => {
			const hostile = "evil\tpackage\x1b[31m missing\nsecond line";
			const s = openNative({ networkMode: "deny", networkUnavailable: { allow: hostile } });
			s.send({ type: "action", act: "page", value: "network" });
			s.send({ type: "change", item: "networkMode", value: "allow" });
			const props = JSON.stringify(s.props());
			expect(props).not.toContain("\\t");
			expect(props).not.toContain("\\u001b");
			expect(props).not.toContain("\\n");
			expect(props).toContain("evil package missing second line");
		});
	});
});
