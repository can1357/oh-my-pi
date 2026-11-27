/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The bash card's shell inspector in Tern: the card's `shell` node takes the
 * shared shell-viz actions, `inspect` opens the inspector as a page of its
 * own, and Escape or `q` brings the session back with the card showing what
 * was changed.
 */
import { describe, expect, it } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { ShellVizPresentation } from "@oh-my-pi/pi-wire";
import { presentShellInspector } from "../../../../src/ui/apps/shell-visualizer";
import { Shell } from "../../../../src/ui/shell/shell";
import "../../../../src/ui/tools";
import { ToolBlock, ToolCall } from "../../../../src/ui/transcript/tool-block";
import { nativeShell } from "../../../helpers/native-shell";

/** A settled bash card over a composer field, as the session shows a finished call. */
async function session() {
	const shell = new Shell();
	const call = new ToolCall({
		id: "call-1",
		name: "bash",
		args: { command: "for n in 1 2; do echo $n; done" },
		inspectShell: source => presentShellInspector(shell, source),
	});
	call.setArgsComplete();
	const block = shell.transcript.append(() => <ToolBlock call={call} />);
	let field: UiNode | null = null;
	shell.dock.slot("composer").set(() => <editor key="input" text="" cursor={0} ref={node => (field = node)} />);
	const ui = await nativeShell(shell);
	shell.setHome(field);
	shell.transcript.settle(block);
	const shellNode = () => ui.node("shell");
	const preferences = () => (shellNode().p.presentation as ShellVizPresentation).preferences;
	/** A click on the card's own controls: the view toggle, or an entry of its menu. */
	const act = (value: string) => ui.send({ ev: "action", sf: ui.sf, id: shellNode().id, act: "shell-viz", value });
	return { ui, call, shellNode, preferences, act };
}

describe("the bash card's shell inspector in Tern", () => {
	it("applies a view action of the card's own controls to a settled card", async () => {
		const { ui, preferences, act } = await session();
		await using _ui = ui;
		expect(preferences().view).toBe("pseudo");

		act("view:raw");
		expect(preferences().view).toBe("raw");
		act("layer:color");
		expect(preferences().layers.color).toBe(false);
		act("split");
		expect(preferences().split).toBe(true);
		expect(ui.surface().mode).toBe("inline");
	});

	it("opens from the card's inspect action as a page holding only the command", async () => {
		const { ui, shellNode, act } = await session();
		await using _ui = ui;
		expect(shellNode().p.inspector).toBeUndefined();

		act("inspect");

		const page = ui.surface();
		expect({ mode: page.mode, role: page.role, focus: page.focus }).toEqual({
			mode: "screen",
			role: "omp.session",
			focus: null,
		});
		expect(page.main.map(node => node.k)).toEqual(["shell"]);
		expect(page.dock).toEqual([]);
		expect(page.layer).toEqual([]);
		expect(page.main[0]!.p).toMatchObject({ lang: "bash", inspector: true, replayEpoch: 0, liveOrigin: false });
		// A second inspect while it is open changes nothing.
		act("inspect");
		expect(ui.surface().main).toHaveLength(1);
	});

	it("runs the inspector's keys and native controls on the presentation it shows", async () => {
		const { ui, shellNode, preferences, act } = await session();
		await using _ui = ui;
		act("inspect");

		ui.type("c");
		expect(preferences().layers.color).toBe(false);
		ui.send({ ev: "change", sf: ui.sf, id: shellNode().id, item: "layer:inline", value: false });
		expect(preferences().layers.inline).toBe(false);
		ui.type("s");
		expect(preferences().split).toBe(true);
		ui.type("r");
		expect(preferences().cursor).toBe(0);
		expect(shellNode().p.replayEpoch).toBe(1);
		ui.type("l");
		expect(preferences().cursor).toBeUndefined();
		expect(shellNode().p.replayEpoch).toBe(2);
		ui.type("v");
		expect(preferences().view).toBe("raw");
		expect(shellNode().p.inspector).toBe(true);
	});

	it("closes on Escape, back on the session with the composer focused and the card showing the changes", async () => {
		const { ui, shellNode, preferences, act } = await session();
		await using _ui = ui;
		act("inspect");
		ui.type("v");
		ui.type("r");

		ui.type("\x1b");

		const back = ui.surface();
		expect(back.mode).toBe("inline");
		expect(back.focus).toBe(ui.node("editor").id);
		expect(shellNode().p.inspector).toBeUndefined();
		expect(preferences()).toMatchObject({ view: "raw", cursor: 0, playing: false });
		expect(shellNode().p.replayEpoch).toBe(1);
	});

	it("closes on q and on the inspector's close action, and opens again", async () => {
		const { ui, shellNode, act } = await session();
		await using _ui = ui;

		act("inspect");
		ui.type("q");
		expect(ui.surface().mode).toBe("inline");
		// The key closed the inspector and went no further.
		expect(ui.node("editor").p.text).toBe("");

		act("inspect");
		expect(ui.surface().mode).toBe("screen");
		ui.send({ ev: "action", sf: ui.sf, id: shellNode().id, act: "close" });
		expect(ui.surface().mode).toBe("inline");
	});

	it("leaves a call without an inspector host on the session", async () => {
		const shell = new Shell();
		const call = new ToolCall({ id: "call-2", name: "bash", args: { command: "echo hi" } });
		call.setArgsComplete();
		shell.transcript.append(() => <ToolBlock call={call} />);
		await using ui = await nativeShell(shell);

		ui.send({ ev: "action", sf: ui.sf, id: ui.node("shell").id, act: "shell-viz", value: "inspect" });

		expect(ui.surface().mode).toBe("inline");
	});
});
