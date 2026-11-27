/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { fullscreenMenuView } from "../../../../src/modes/controllers/selector-views";
import { reportSheetView } from "../../../../src/modes/controllers/command-views";
import { nativeShell } from "../../../helpers/native-shell";
import type { ContextViewData } from "../../../../src/session/context-view-model";
import { ContextViewer, ContextViewerModel } from "../../../../src/ui/overlays/panels/context-viewer";
import { type Driver, panelSuite } from "./harness";

process.env.TZ = "UTC";

function fixture(window = 200_000): unknown {
	const output = {
		id: "tool-output",
		label: "Tool Output",
		tokens: 30000,
		entries: [
			{
				id: "result/0",
				label: "read result",
				tokens: 20000,
				timestamp: 0,
				callId: "call-123",
				text:
					Array.from({ length: 100 }, (_, index) => `line ${index}\t${"long ".repeat(30)}`).join("\n") +
					"\ncontext-output-tail",
			},
			{ id: "result/1", label: "bash result ünïcödé", tokens: 10000, text: "short result", timestamp: 60_000 },
			{ id: "result/2", label: "empty", tokens: 1, text: "" },
		],
	} as { id: string; label: string; tokens: number; entries: unknown[]; children?: unknown[] };
	output.children = [
		{ ...output, key: "tool-output/read", label: "read", entries: output.entries.slice(0, 1), tokens: 20000 },
		{ ...output, key: "tool-output/bash", label: "bash", entries: output.entries.slice(1), tokens: 10000 },
	];
	return {
		breakdown: {
			model: { name: "Claude ✦", id: "claude" },
			contextWindow: window,
			categories: [],
			thresholdTokens: 180000,
			snapcompact: {
				visionCapable: true,
				savedTokens: 6000,
				systemPrompt: {
					applied: true,
					textTokens: 10000,
					imageTokens: 4000,
					frames: 2,
					savedTokens: 6000,
					scope: "all",
				},
			},
			usedTokens: 85000,
			freeTokens: 95000,
			autoCompactBufferTokens: 20000,
		},
		notices: ["A snapshot notice that is long enough to wrap in the legend column at narrow widths."],
		categories: [
			{
				id: "system-prompt",
				label: "System Prompt",
				tokens: 20000,
				entries: [{ id: "system/0", label: "system block", tokens: 20000, text: "entire system source" }],
			},
			{
				id: "skills",
				label: "Skills",
				tokens: 10000,
				entries: [{ id: "skill/0", label: "fixture skill", tokens: 10000, text: "skill hint" }],
			},
			{ id: "custom-tools", label: "Custom Tools", tokens: 0, entries: [] },
			{
				id: "user-messages",
				label: "User / Developer Messages",
				tokens: 10000,
				entries: [{ id: "user/0", label: "user", tokens: 10000, text: "question" }],
			},
			output,
		],
	};
}

test("activating the category list and an entry inside the shell opens the clicked entry", async () => {
	await using ui = await nativeShell();
	const model = new ContextViewerModel(
		fixture() as ContextViewData,
		() => 24,
		() => {},
	);
	ui.shell.overlays.show(() => fullscreenMenuView("context", <ContextViewer model={model} />));
	const sf = ui.sf;
	ui.send({ ev: "activate", sf, id: ui.node("list", "categories").id, item: ui.node("item", "tool-output").id });
	expect(model.state).toBe("category");
	ui.send({ ev: "action", sf, id: ui.node("col", "result%2F1").id, act: "open-entry" });
	expect(model.state).toBe("entry");
	expect(model.entry?.label).toBe("bash result ünïcödé");
});

test("arrow and page keys scroll an open entry's full content natively", async () => {
	await using ui = await nativeShell();
	ui.send({ ev: "features", features: ["aside", "settle", "scroll"] });
	const model = new ContextViewerModel(
		fixture() as ContextViewData,
		() => 24,
		() => {},
	);
	// As `/context` shows it: a focused sheet taking the viewer's keys.
	ui.shell.overlays.show(
		() => reportSheetView(<ContextViewer model={model} />, { page: false, onKey: key => model.key(key.id) }),
		{ focus: root => root },
	);
	const sf = ui.sf;
	ui.send({ ev: "activate", sf, id: ui.node("list", "categories").id, item: ui.node("item", "tool-output").id });
	ui.send({ ev: "action", sf, id: ui.node("col", "result%2F1").id, act: "open-entry" });
	expect(model.state).toBe("entry");
	for (const key of ["\x1b[B", "\x1b[B", "\x1b[6~", "\x1b[A", "\x1b[5~"]) ui.type(key);
	const scrolls = ui.scrolls();
	expect(scrolls.map(([, by]) => by)).toEqual(["line-down", "line-down", "page-down", "line-up", "page-up"]);
	expect(new Set(scrolls.map(([id]) => id)).size).toBe(1);
});

const DOWN = "\x1b[B";
panelSuite({
	dir: "overlays/context-viewer",
	mount(caseName) {
		const rows = signal(24);
		const model = new ContextViewerModel(
			fixture(caseName === "no-window" ? 0 : undefined) as ContextViewData,
			rows,
			() => {},
		);
		const emit = (event: Parameters<Driver["emit"]>[0]) => (d: Driver) => void d.emit(event);
		return {
			view: () => <ContextViewer model={model} />,
			steps: {
				"select output": emit({ type: "select", key: "overview/categories", item: "tool-output" }),
				"activate output": emit({ type: "activate", key: "overview/categories", item: "tool-output" }),
				"select entry": () => void (model.state === "category" && ((model.entryId = "result/1"), model.touch())),
				"short terminal 3": () => rows.set(3),
				"short terminal 2": () => rows.set(2),
				"short terminal 1": () => rows.set(1),
				tall: () => rows.set(40),
				"open entry": () => {
					if (model.state !== "category") return;
					model.entryId = "result/0";
					model.activate();
					model.touch();
				},
				down: d => d.press(DOWN),
				page: d => d.press("\x1b[6~"),
				back: emit({ type: "action", key: "", act: "back", mods: [] }),
				"back again": emit({ type: "action", key: "", act: "back", mods: [] }),
				"select single": emit({ type: "activate", key: "overview/categories", item: "skills" }),
				"back to overview": emit({ type: "action", key: "", act: "back", mods: [] }),
				"edge reveal": d => {
					for (let i = 0; i < 7; i++) d.press(DOWN);
				},
				captures: () => {},
				"rows 24": () => rows.set(24),
			},
		};
	},
});
