import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import type { SandboxConfigOverlayComponent } from "@oh-my-pi/pi-tui/overlays/sandbox-config";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { sandboxHost } from "./sandbox-config-host";

const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";

beforeAll(async () => {
	await initTheme(false);
});

function press(overlay: SandboxConfigOverlayComponent, ...keys: string[]): void {
	for (const key of keys) overlay.handleInput(key);
}

function screen(overlay: SandboxConfigOverlayComponent, width = 80): string {
	return overlay
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

describe("/sandbox overlay in a plain terminal", () => {
	it("adds a writable path from the keyboard and removes it by clearing its text", () => {
		const { overlay, calls } = sandboxHost({
			status: { state: "unavailable", reason: "bwrap not found", fallback: "warn" },
		});
		expect(screen(overlay)).toContain("Status: Unavailable · running unsandboxed · bwrap not found");

		// Filesystem page: Read scope, then the Writable list's "Add path" row.
		press(overlay, TAB, DOWN, ENTER);
		for (const ch of "~/build-cache") overlay.handleInput(ch);
		expect(screen(overlay)).toContain("~/build-cache");
		press(overlay, ENTER);
		expect(calls).toEqual([["add", "allowWrite", "~/build-cache"]]);
		expect(screen(overlay)).toMatch(/Writable\s*│\n│\s+Path\s+~\/build-cache/);

		// Focus stays on "Add path"; the entry is the row above. Open it, clear it and save.
		press(overlay, UP, ENTER);
		for (let i = 0; i < "~/build-cache".length; i++) overlay.handleInput(BACKSPACE);
		press(overlay, ENTER);
		expect(calls.at(-1)).toEqual(["remove", "allowWrite", "~/build-cache"]);
		expect(screen(overlay)).not.toContain("~/build-cache");
	});

	it("toggles Enabled, steps a choice both ways with wrap-around and keeps scope in canonical order", () => {
		const { overlay, calls } = sandboxHost({ scope: ["bash", "exec"] });
		press(overlay, ENTER);
		press(overlay, DOWN, RIGHT, RIGHT, LEFT);
		// Overview rows: Enabled, Mode, then one line per scope option.
		press(overlay, DOWN, DOWN, ENTER);
		expect(calls).toEqual([
			["set", { id: "enabled", value: true }],
			["set", { id: "mode", value: "read-only" }],
			["set", { id: "mode", value: "workspace-write" }],
			["set", { id: "mode", value: "read-only" }],
			["set", { id: "scope", value: ["bash", "eval", "exec"] }],
		]);
	});

	it("allows the focused blocked host even when a refresh reorders the list before Enter", () => {
		const { overlay, calls, push } = sandboxHost({ blockedHosts: ["a.example", "b.example"] });
		// Network page: Mode, Add host, then the blocked hosts.
		press(overlay, TAB, TAB, DOWN, DOWN, DOWN);
		push({ blockedHosts: ["new.example", "a.example", "b.example"] });
		press(overlay, ENTER);
		expect(calls).toEqual([["allow", "b.example"]]);
	});

	it("after an Allow removes the host, keeps the selection on the next blocked host, never on the mode", () => {
		const { overlay, calls, push } = sandboxHost({ blockedHosts: ["a.example", "b.example"] });
		press(overlay, TAB, TAB, DOWN, DOWN, ENTER);
		push({ blockedHosts: ["b.example"] });
		press(overlay, ENTER);
		push({ blockedHosts: [] });
		expect(calls).toEqual([
			["allow", "a.example"],
			["allow", "b.example"],
		]);
		// With none left the selection is the hosts list's Add row: Enter opens a draft, not a mode change.
		press(overlay, ENTER);
		expect(calls.some(call => call[0] === "set")).toBe(false);
	});

	it("lists session grants under Allowed this session and removes them in turn, never touching a setting", () => {
		const empty = sandboxHost();
		press(empty.overlay, TAB);
		expect(screen(empty.overlay)).not.toContain("Allowed this session");

		const { overlay, calls } = sandboxHost({ sessionPaths: { write: ["/work/out"], read: ["/data/in"] } });
		// Filesystem: Read scope, the three lists' Add rows, then the session grants.
		press(overlay, TAB);
		expect(screen(overlay)).toMatch(/Allowed this session[^]*Write {2}\/work\/out[^]*Read {2}\/data\/in/);
		press(overlay, DOWN, DOWN, DOWN, DOWN, ENTER, ENTER);
		expect(calls).toEqual([
			["revoke", "write", "/work/out"],
			["revoke", "read", "/data/in"],
		]);
		expect(screen(overlay)).not.toContain("Allowed this session");
		// The selection fell back to an Add row: Enter opens a draft instead of stepping Read scope.
		press(overlay, ENTER);
		expect(calls.some(call => call[0] === "set")).toBe(false);
	});

	it("names a locked setting's reason under its row", () => {
		const { overlay, calls } = sandboxHost({ locked: { mode: "Set by a session override" } });
		expect(screen(overlay)).toMatch(/Mode .*\n│\s+Set by a session override/);
		press(overlay, DOWN, RIGHT);
		expect(calls).toEqual([]);
	});

	it("shows a list's note under the list and a rejected edit's notice without changing the frame height", () => {
		const { overlay } = sandboxHost({
			listNotes: { allowedHosts: "Project config narrows this list here: 1 entry does not apply." },
			ignored: [{ id: "sandbox.network.allowedHosts", reason: "dropped" }],
		});
		// A full-width row is not cut.
		expect(screen(overlay, 40)).toMatch(/│ {3}network\.allowedHosts {4,}│/);
		const before = overlay.render(80).length;
		overlay.setNotice("unknown path token $HOME");
		expect(screen(overlay)).toContain("⚠ unknown path token $HOME");
		expect(overlay.render(80).length).toBe(before);
		press(overlay, TAB, TAB);
		expect(screen(overlay)).toMatch(/Allowed hosts[^]*Add host[^]*Note[^]*⚠ Project config narrows this list here/);
	});

	it("removes the focused entry with Delete", () => {
		const { overlay, calls } = sandboxHost({ allowRead: ["/data"] });
		// Filesystem: Read scope, Add path (Writable), then the Readable entry.
		press(overlay, TAB, DOWN, DOWN, DELETE);
		expect(calls).toEqual([["remove", "allowRead", "/data"]]);
	});

	it("Esc on a draft cancels it on the same page, adding nothing; Esc again closes", () => {
		const { overlay, calls } = sandboxHost();
		press(overlay, TAB, DOWN, ENTER, "x", ESC);
		expect(screen(overlay)).toContain("Writable");
		expect(calls).toEqual([]);
		press(overlay, ESC);
		expect(calls).toEqual([["close"]]);
	});

	it("keeps hostile model text single-line, unescaped and within the width, on every page and in the prefs page", () => {
		const hostile = "evil\tvalue\x1b[31m with a tail long enough to overflow a forty column frame";
		const home = path.join(os.homedir(), "project\tdir");
		const { overlay } = sandboxHost({
			status: { state: "unavailable", reason: hostile, fallback: "block" },
			ignored: [{ id: "sandbox.network.allowedHosts", reason: hostile }],
			blockedHosts: [`host\t\x1b[31m.example-with-a-very-long-name-that-overflows`],
			effective: { readwritePaths: [home], readonlyPaths: [], deniedPaths: [] },
		});
		const cx: DescribeContext = {
			cols: 40,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		const pages: string[] = [];
		for (let page = 0; page < 4; page++) {
			const lines = overlay.render(40);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(40);
				expect(line).not.toContain("\t");
				expect(line).not.toContain("\x1b[31m");
			}
			pages.push(lines.map(line => Bun.stripANSI(line)).join("\n"));
			// The prefs page carries the same strings cleaned.
			const props = JSON.stringify(overlay.describe(cx).p);
			expect(props).not.toContain("\\t");
			expect(props).not.toContain("\\u001b");
			press(overlay, TAB);
		}
		// The status wraps, and its consequence leads, so a long reason never hides it.
		expect(pages[0].replace(/[│\s]+/g, " ")).toContain("Status: Unavailable · contained tools fail · evil value");
		// The ignored setting is named without the common prefix.
		expect(pages[0]).toContain("network.allowedHosts");
		expect(pages[3]).toContain("~/project dir");
	});
});
