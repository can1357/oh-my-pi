/**
 * A menu setting's disabled choice (the `/settings` host marks `sandbox.network.mode`
 * choices this host cannot enforce): listed, labelled unavailable, its reason readable,
 * and refused by keys and by a Tern `change` alike, without changing the value.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { UiEvent, UiNode } from "@oh-my-pi/pi-tui";
import { batch } from "@oh-my-pi/pi-tui";
import { bubbleEvent, keypathOf, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import type { TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import type { SettingsDisplayEntry, SettingsHost, SubmenuOption } from "../../../src/config/settings-defs";
import { SettingsWindow } from "../../../src/ui/overlays/settings/settings";
import { findKind, mountOverlay } from "../../helpers/overlay-terminal";

const NET_REASON =
	'Network mode "allow" is unavailable on this host: packages slirp4netns, iproute2 are missing (commands: slirp4netns, ip). Install them to use this mode.';

const ROW = "sandbox.network.mode";

/** Shaped as `createSettingsHost` shapes it where the host cannot enforce `allowlist` or `allow`. */
const ENTRIES: SettingsDisplayEntry[] = [
	{
		path: ROW,
		type: "enum",
		enumValues: ["allowlist", "deny", "allow"],
		defaultValue: "deny",
		ui: {
			tab: "tools",
			group: "Sandbox",
			label: "Sandbox Network",
			description: `Network access of contained commands. ${NET_REASON}`,
			options: [
				{ value: "allowlist", label: "Allowlist (unavailable)", description: NET_REASON, disabled: true },
				{ value: "deny", label: "Deny", description: "No network access." },
				{ value: "allow", label: "Allow (unavailable)", description: NET_REASON, disabled: true },
			],
		},
	},
];

interface Harness {
	readonly term: TestTerminal;
	readonly values: Map<string, unknown>;
	readonly changes: [string, unknown][];
}

const open: TestTerminal[] = [];

afterEach(() => {
	for (const term of open.splice(0)) term.dispose();
});

function harness(
	columns = 120,
	entries: SettingsDisplayEntry[] = ENTRIES,
	runtimeOptions?: ReadonlyMap<string, readonly SubmenuOption[]>,
	initial: [string, unknown] = [ROW, "deny"],
): Harness {
	const values = new Map<string, unknown>([initial]);
	const changes: [string, unknown][] = [];
	const settings: SettingsHost = {
		entries,
		get: path => values.get(path),
		set: (path, value) => void values.set(path, value),
		unset: path => void values.delete(path),
		normalizeProviderLimits: () => ({}),
		validateProviderLimits: () => ({}),
	};
	const term = mountOverlay(
		() =>
			SettingsWindow({
				context: {
					settings,
					availableThinkingLevels: [],
					availableThemes: ["dark"],
					providers: [],
					runtimeOptions,
				},
				callbacks: { onChange: (path, value) => void changes.push([path, value]), onCancel: () => {} },
			}),
		{ columns, rows: 40, focusKind: "__root__" },
	);
	open.push(term);
	return { term, values, changes };
}

function prefsNode(term: TestTerminal): { root: UiNode; prefs: UiNode } {
	const root = term.surface.layer()[0]!;
	const prefs = findKind(root, "prefs");
	if (!prefs) throw new Error("no prefs node");
	return { root, prefs };
}

function props(term: TestTerminal): TspPrefsProps {
	return prefsNode(term).prefs.props() as unknown as TspPrefsProps;
}

/** A UI event without its keypath (each union member on its own, so `act`/`item` stay typed). */
type UnkeyedEvent = UiEvent extends infer E ? (E extends UiEvent ? Omit<E, "key"> : never) : never;

/** A Tern event from the prefs node, bubbling as the native host delivers it. */
function send(term: TestTerminal, event: UnkeyedEvent): void {
	const { root, prefs } = prefsNode(term);
	const path = pathTo([root], prefs);
	batch(() => void bubbleEvent(path, { ...event, key: keypathOf(path) } as UiEvent));
}

function row(term: TestTerminal, id: string): TspPrefsRow {
	for (const section of props(term).sections) {
		const hit = section.rows.find(candidate => candidate.id === id);
		if (hit) return hit;
	}
	throw new Error(`no row ${id}`);
}

function screen(term: TestTerminal): string {
	term.render();
	return (term.fullscreen() ?? term.screen()).map(line => Bun.stripANSI(line)).join("\n");
}

describe("settings menu with unavailable choices", () => {
	it("names the missing packages at 80 columns in the terminal's open menu", () => {
		const { term } = harness(80);
		send(term, { type: "action", act: "page", value: "tools", mods: [] });
		send(term, { type: "activate", item: ROW });
		const text = screen(term);
		expect(text).toContain("Allow (unavailable)");
		// The reason wraps over rows at this width, so compare without the line breaks.
		const flat = text.replace(/\s+/g, " ");
		expect(flat).toContain("slirp4netns");
		expect(flat).toContain("iproute2");
	});

	it("refuses an unavailable choice picked with the keys, closing the menu", () => {
		const { term, values, changes } = harness();
		term.type("sandbox network");
		term.press("enter");
		expect(props(term).editing?.row).toBe(ROW);
		term.press("down"); // Deny → Allow (unavailable)
		term.press("enter");
		expect(values.get(ROW)).toBe("deny");
		expect(changes).toEqual([]);
		expect(props(term).editing).toBeNull();
	});

	it("takes an available choice picked with the keys", () => {
		const { term, values, changes } = harness();
		values.set(ROW, "allow");
		term.type("sandbox network");
		term.press("enter");
		term.press("up"); // Allow (unavailable) → Deny
		term.press("enter");
		expect(values.get(ROW)).toBe("deny");
		expect(changes).toEqual([[ROW, "deny"]]);
	});

	it("labels unavailable choices natively and refuses picking one without opening or changing anything", () => {
		const { term, values, changes } = harness();
		send(term, { type: "action", act: "page", value: "tools", mods: [] });
		const control = row(term, ROW).control;
		if (control.k !== "choice") throw new Error(`control is ${control.k}`);
		expect(control.options.map(option => option.label)).toEqual([
			"Allowlist (unavailable)",
			"Deny",
			"Allow (unavailable)",
		]);

		send(term, { type: "change", item: ROW, value: "allow" });
		expect(values.get(ROW)).toBe("deny");
		expect(changes).toEqual([]);
		expect(props(term).editing).toBeNull();

		// An already open menu closes on the refused pick.
		send(term, { type: "activate", item: ROW });
		expect(props(term).editing?.row).toBe(ROW);
		send(term, { type: "change", item: ROW, value: "allowlist" });
		expect(values.get(ROW)).toBe("deny");
		expect(props(term).editing).toBeNull();
	});
});

describe("settings menu with runtime choices", () => {
	const RUNTIME_ROW = "todo.backend";
	const RUNTIME_ENTRIES: SettingsDisplayEntry[] = [
		{
			path: RUNTIME_ROW,
			type: "enum",
			enumValues: ["native", "ext", "off"],
			defaultValue: "native",
			ui: {
				tab: "tools",
				group: "Todo",
				label: "Todo Backend",
				description: "Where todos live.",
				options: [{ value: "native", label: "Native" }],
			},
		},
	];
	// What the host hands in at runtime: the extension's backend, and one it cannot switch to yet.
	const RUNTIME_OPTIONS: ReadonlyMap<string, readonly SubmenuOption[]> = new Map([
		[
			RUNTIME_ROW,
			[
				{ value: "native", label: "Native" },
				{ value: "ext", label: "Ext Backend", description: "line one" },
				{ value: "off", label: "Off", description: "needs a restart", disabled: true },
			],
		],
	]);
	const runtimeHarness = () => harness(120, RUNTIME_ENTRIES, RUNTIME_OPTIONS, [RUNTIME_ROW, "native"]);

	it("lists a disabled runtime choice with its reason", () => {
		const { term } = runtimeHarness();
		send(term, { type: "action", act: "page", value: "tools", mods: [] });
		const control = row(term, RUNTIME_ROW).control;
		if (control.k !== "choice") throw new Error(`control is ${control.k}`);
		expect(control.options.map(option => [option.value, option.detail])).toEqual([
			["native", undefined],
			["ext", "line one"],
			["off", "needs a restart"],
		]);
	});

	it("refuses a native change to a runtime choice the host marked disabled, and takes an enabled one", () => {
		const { term, values, changes } = runtimeHarness();
		send(term, { type: "action", act: "page", value: "tools", mods: [] });
		send(term, { type: "change", item: RUNTIME_ROW, value: "off" });
		expect(values.get(RUNTIME_ROW)).toBe("native");
		expect(changes).toEqual([]);
		send(term, { type: "change", item: RUNTIME_ROW, value: "ext" });
		expect(changes).toEqual([[RUNTIME_ROW, "ext"]]);
	});
});
