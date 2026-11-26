/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test, vi } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { fullscreenMenuView } from "../../../../src/modes/controllers/selector-views";
import { nativeShell } from "../../../helpers/native-shell";
import { signal, type UiEvent } from "@oh-my-pi/pi-tui";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { SessionSelectorEntry } from "../../../../src/modes/view-model/overlays/session-selector";
import { SessionSelector, sessionSelectorFocus } from "../../../../src/ui/overlays/pickers/session-selector";
import { Shell } from "../../../../src/ui/shell/shell";
import { type Driver, pickerSuite } from "./harness";

/** The capture's clock: sessions are aged from it. */
const NOW = Date.parse("2026-11-23T12:00:00Z");
/**
 * The capture grouped by the pinned calendar day of its harness
 * (2023-11-14), so every session fell in "Today"; the day groups follow it.
 */
const DAY_START = Date.UTC(2023, 10, 14);

const mk = (
	i: number,
	title: string | undefined,
	first: string,
	dir = "/w/a",
	extra: Partial<SessionSelectorEntry> = {},
): SessionSelectorEntry => ({
	path: `${dir}/s${i}.jsonl`,
	id: `id${i}`,
	cwd: dir,
	title,
	modified: new Date(NOW - i * 3_600_000 * 7),
	size: 1000 * i + 5,
	firstMessage: first,
	allMessagesText: `${first} body text ${i}`,
	...extra,
});
const sessions = (): SessionSelectorEntry[] => [
	mk(1, "Alpha session", "fix the build"),
	mk(2, undefined, "日本語のプロンプト\twith tab", "/w/a", { status: "error" }),
	mk(3, "Beta", "a long long long long long long long long long long long long first message", "/w/a", {
		status: "interrupted",
		parentSessionPath: "/w/a/s1.jsonl",
	}),
	mk(4, "Gamma", "gamma", "/w/b", { status: "complete" }),
	...Array.from({ length: 30 }, (_, k) => mk(10 + k, `Filler ${k}`, `filler ${k}`)),
];
const tick = (): Promise<void> => Bun.sleep(5);
const noop = (): void => {};

test("terminal rename accepts typed input and returns to the picker after cancel and save", async () => {
	const term = memoryTerminal({ columns: 100, rows: 30 });
	const shell = new Shell();
	const selected = mk(1, "Alpha", "first message");
	const picked = vi.fn();
	const renamed = vi.fn(async (_session: SessionSelectorEntry, title: string) => title);
	await shell.start({ theme: currentTheme, driver: term.options, role: "omp.session" });
	try {
		shell.overlays.show(
			() =>
				fullscreenMenuView(
					"sessions",
					<SessionSelector sessions={[selected]} onRename={renamed} onSelect={picked} onCancel={noop} />,
				),
			{ focus: sessionSelectorFocus },
		);
		term.feed("\x1bOQ Draft\x03");
		term.feed("\x1bOQ Saved\x1b[13u");
		await Promise.resolve();
		expect(renamed.mock.calls).toEqual([[selected, "Alpha Saved"]]);
		term.feed("\x1b[13u");
		expect(picked).toHaveBeenCalledWith(expect.objectContaining({ path: selected.path, title: "Alpha Saved" }));
	} finally {
		shell.overlays.closeAll();
		await shell.stop();
		shell.surface.dispose();
	}
});

test("native session selection, rename/edit, and Resume address the same session", async () => {
	await using ui = await nativeShell();
	const picked = vi.fn();
	const renamed = vi.fn(async (_session: SessionSelectorEntry, title: string) => title);
	ui.shell.overlays.show(
		() =>
			fullscreenMenuView(
				"sessions",
				<SessionSelector sessions={sessions()} onRename={renamed} onSelect={picked} onCancel={noop} />,
			),
		{ focus: sessionSelectorFocus },
	);
	const shown = (): TspPickerProps => ui.node("picker").p;
	const target = shown().items!.find(item => item.label === "Beta")!;
	const action = (label: string): void => {
		const button = shown().actions!.find(action => action.label === label)!;
		ui.send({ ev: "action", sf: ui.sf, id: ui.node("picker").id, act: button.id });
	};
	ui.send({ ev: "select", sf: ui.sf, id: ui.node("picker").id, item: target.id });
	expect(picked).not.toHaveBeenCalled();
	action("Rename");
	const input = ui.node("input");
	expect(input.p.text).toBe("Beta");
	expect(ui.surface().focus).toBe(input.id);
	ui.send({ ev: "edit", sf: ui.sf, id: input.id, len: 4, from: 0, to: 4, text: "Renamed", cursor: 7 });
	expect(ui.node("input").p.text).toBe("Renamed");
	ui.type("\r");
	await Promise.resolve();
	expect(renamed).toHaveBeenCalledWith(expect.objectContaining({ path: target.id }), "Renamed");
	expect(shown().items!.find(item => item.id === target.id)?.label).toBe("Renamed");
	action("Resume");
	expect(picked).toHaveBeenCalledWith(expect.objectContaining({ path: target.id }));
});

pickerSuite({
	dir: "overlays/session-selector",
	mount(caseName) {
		const locked = signal(false);
		const press = (raw: string) => async (d: Driver) => {
			d.press(raw);
			await tick();
		};
		const view =
			caseName === "empty"
				? () => (
						<SessionSelector
							sessions={[]}
							onSelect={noop}
							onCancel={noop}
							projectName="ui"
							now={() => NOW}
							dayStart={() => DAY_START}
						/>
					)
				: () => (
						<SessionSelector
							sessions={sessions()}
							onSelect={noop}
							onCancel={noop}
							onDelete={async () => true}
							onRename={async (_s, title) => title}
							onSetPinned={async () => {}}
							loadAllSessions={
								caseName === "load-error"
									? async () => {
											throw new Error("boom   here");
										}
									: async () => ({ sessions: [...sessions(), mk(99, "Other project", "other", "/w/z")] })
							}
							terminalRows={30}
							currentSessionPath="/w/a/s1.jsonl"
							projectName="ui"
							scopeLabel={caseName === "fill" ? "here" : undefined}
							fillHeight={caseName === "fill"}
							locked={locked}
							now={() => NOW}
							dayStart={() => DAY_START}
						/>
					);
		const action = (act: string) => async (d: Driver) => {
			d.emit({ type: "action", key: "", act, mods: [] } as UiEvent);
			await tick();
		};
		return {
			view,
			focus: d => d.root,
			steps: {
				"tab scope": press("\t"),
				"tab back": press("\t"),
				tab: press("\t"),
				"native pin": action("pin"),
				"native delete": action("delete"),
				"native delete confirm": action("delete-confirm"),
				"f2 rename": d => d.press("\x1bOQ"),
				type: d => {
					d.press("Z");
					d.press("!");
				},
				submit: press("\r"),
				"select native": d => void d.emit({ type: "select", key: "picker", item: "/w/a/s3.jsonl" }),
				lock: d => {
					locked.set(true);
					d.press("\x1b[B");
					locked.set(false);
				},
			},
		};
	},
});
