/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The shared button-like controls as Tern receives them: `button` nodes and
 * segmented `tabs`, whose clicks run the same action the row/icon did.
 */
import { describe, expect, it } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import {
	ActionButton,
	EscCloseButton,
	IconButton,
	QuietButton,
	segmentedVariant,
} from "../../../../src/ui/overlays/panels/common";
import { PauseScreen } from "../../../../src/ui/overlays/panels/pause-screen";
import { ReportPanel } from "../../../../src/ui/overlays/panels/report-panel";
import { Shell } from "../../../../src/ui/shell/shell";
import { nativeShell } from "../../../helpers/native-shell";

/** Every control once, under one node recording the actions it receives. */
function controls(acts: string[], tab: { set(value: string): void; (): string }) {
	return (
		<col key="controls" onAction={act => void acts.push(act)}>
			<ActionButton id="plain" label="Plain" />
			<ActionButton id="save" label="Save" title="Save  ⏎" keys={["enter"]} tone="accent" />
			<ActionButton id="kill" label="Kill" tone="error" keys={["ctrl", "c"]} title="Kill  ⌃C" />
			<ActionButton
				id="commit"
				label="Commit"
				title="Commit the staged changes"
				tone="accent"
				disabled="Nothing to commit"
			/>
			<ActionButton id="generate" label="Generating…" busy disabled="" />
			<ActionButton
				nodeKey="openLink"
				id="open"
				label="Open"
				href="https://example.com"
				icon="open"
				title="Open example.com"
			/>
			<EscCloseButton />
			<IconButton nodeKey="wrap" name="corner-down-right" act="wrap" title="Wrap lines (W)" on />
			<IconButton nodeKey="quit" name="x" act="quit" title="Quit  q" aria="Quit" />
			<QuietButton label="Stage all" act="stage-all" title="Stage every change" />
			<tabs
				key="views"
				role="omp.app.seg"
				variant={segmentedVariant}
				items={[
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				]}
				active={tab}
				onSelect={item => tab.set(item)}
			/>
		</col>
	);
}

describe("button-like controls in Tern", () => {
	it("sends button nodes with the released props and routes their clicks", async () => {
		await using ui = await nativeShell();
		const acts: string[] = [];
		const tab = signal("a");
		ui.shell.dock.slot("ask").set(() => controls(acts, tab));

		expect(ui.node("button", "plain").p).toEqual({
			role: "omp.btn",
			text: "Plain",
			title: "Plain",
			actions: { click: "plain" },
		});
		expect(ui.node("button", "save").p).toEqual({
			role: "omp.btn",
			text: "Save",
			title: "Save  ⏎",
			keys: ["enter"],
			variant: "primary",
			tone: "accent",
			actions: { click: "save" },
		});
		expect(ui.node("button", "kill").p).toMatchObject({ variant: "danger", tone: "error", keys: ["ctrl", "c"] });
		// A disabled button is muted, loses its variant and says why; the reason is the tooltip Tern shows.
		expect(ui.node("button", "commit").p).toEqual({
			role: "omp.btn",
			text: "Commit",
			title: "Commit the staged changes",
			tone: "muted",
			disabled: "Nothing to commit",
			actions: { click: "commit" },
		});
		expect(ui.node("button", "generate").p).toMatchObject({ busy: true, disabled: true, tone: "muted" });
		expect(ui.node("button", "openLink").p).toEqual({
			role: "omp.btn",
			text: "Open",
			title: "Open example.com",
			icon: "open",
			href: "https://example.com",
			actions: { click: "open" },
		});
		expect(ui.node("button", "esc-close").p).toEqual({
			role: "omp.btn",
			keys: ["escape"],
			title: "Close  esc",
			aria: "Close",
			actions: { click: "close" },
		});
		expect(ui.node("button", "wrap").p).toEqual({
			role: "omp.app.ibtn.set",
			variant: "quiet",
			icon: "corner-down-right",
			title: "Wrap lines (W)",
			aria: "Wrap lines (W)",
			on: true,
			actions: { click: "wrap" },
		});
		expect(ui.node("button", "quit").p).toEqual({
			role: "omp.app.ibtn",
			variant: "quiet",
			icon: "x",
			title: "Quit  q",
			aria: "Quit",
			actions: { click: "quit" },
		});
		expect(ui.node("button", "stage-all").p).toEqual({
			role: "omp.app.qbtn",
			variant: "quiet",
			size: "sm",
			text: "Stage all",
			title: "Stage every change",
			actions: { click: "stage-all" },
		});
		expect(ui.node("tabs", "views").p).toMatchObject({ role: "omp.app.seg", variant: "segmented", active: "a" });

		for (const key of ["plain", "save", "openLink", "esc-close", "wrap", "quit", "stage-all"])
			ui.click("button", key);
		expect(acts).toEqual(["plain", "save", "open", "close", "wrap", "quit", "stage-all"]);
		ui.send({ ev: "select", sf: ui.sf, id: ui.node("tabs", "views").id, item: "b" });
		expect(ui.node("tabs", "views").p.active).toBe("b");
	});

	it("keeps the row and icon composition where no terminal draws buttons", async () => {
		const term = memoryTerminal({ columns: 100, rows: 30 });
		const shell = new Shell();
		await shell.start({ theme: currentTheme, driver: term.options, role: "omp.session" });
		try {
			const tab = signal("a");
			const root = controls([], tab);
			shell.dock.slot("ask").set(() => root);
			if (typeof root !== "object" || root === null || !("children" in root)) throw new Error("no controls");
			const kinds = root.children().map(child => `${child.kind}:${String(child.props().role ?? "")}`);
			expect(kinds).toEqual([
				"row:omp.btn",
				"row:omp.btn",
				"row:omp.btn",
				"row:omp.btn",
				"row:omp.btn",
				"row:omp.btn",
				"row:omp.btn",
				"icon:omp.app.ibtn.set",
				"icon:omp.app.ibtn",
				"row:omp.app.qbtn",
				"tabs:omp.app.seg",
			]);
			const commit = root.children()[3]!;
			// A disabled row sends no click at all.
			expect(commit.props().actions).toBeUndefined();
			expect(commit.props().tone).toBe("muted");
			expect(root.children()[4]!.children()[0]!.kind).toBe("spinner");
			const tabs = root.children().at(-1)!.props();
			expect("variant" in tabs ? tabs.variant : undefined).toBeUndefined();
		} finally {
			await shell.stop();
			shell.surface.dispose();
		}
	});

	it("closes a report from its Close button", async () => {
		await using ui = await nativeShell();
		let closed = 0;
		ui.shell.dock
			.slot("ask")
			.set(() =>
				ReportPanel({ title: "Tools", body: <text text="body" />, closeKey: "Esc", onClose: () => closed++ }),
			);
		expect(ui.node("button", "close").p).toEqual({
			role: "omp.btn",
			text: "Close",
			title: "Close  esc",
			keys: ["escape"],
			actions: { click: "close" },
		});
		ui.click("button", "close");
		expect(closed).toBe(1);
	});

	it("resumes from the pause screen's primary button", async () => {
		await using ui = await nativeShell();
		let resumed = 0;
		ui.shell.dock.slot("ask").set(() =>
			PauseScreen({
				since: () => 0,
				work: () => ({ unsettledTurns: 0, unfinishedJobs: 0 }),
				onResume: () => resumed++,
			}),
		);
		expect(ui.node("button", "resume").p).toMatchObject({
			role: "omp.btn",
			text: "Resume",
			variant: "primary",
			tone: "accent",
		});
		ui.click("button", "resume");
		expect(resumed).toBe(1);
	});
});
