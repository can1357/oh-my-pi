/** @jsxImportSource @oh-my-pi/pi-tui */
import { computed, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { StreamingPanel, ToolActivity, TranscriptBlocks } from "../../../../src/ui/transcript/messages/panel";
import { screenSuite, single } from "./harness";

screenSuite("container", () => {
	const visible = signal(true);
	const block = (text: string): UiNode => single(<text spans={[{ t: text }]} wrap="word" />);
	const blocks = [
		block("first block"),
		single(<ToolActivity visible={visible}>{block("tool activity")}</ToolActivity>),
		block("third\nblock with 日本語"),
		block("late"),
		block("inserted"),
	];
	const shown = signal<readonly UiNode[]>(blocks.slice(0, 3));
	return {
		node: single(<TranscriptBlocks>{() => shown()}</TranscriptBlocks>),
		apply(label) {
			const list = [...shown()];
			if (label === "tool activity hidden") visible.set(false);
			else if (label === "tool activity shown") visible.set(true);
			else if (label === "late block added while hidden") shown.set([...list, blocks[3]!]);
			else if (label === "inserted at 1") shown.set([list[0]!, blocks[4]!, ...list.slice(1)]);
			else if (label === "third removed") shown.set(list.filter(b => b !== blocks[2]));
			else if (label === "first removed") shown.set(list.filter(b => b !== blocks[0]));
			else throw new Error(`unknown stage ${label}`);
		},
	};
});

const MORE = "# Title\n\nmore text ".repeat(5);

screenSuite("streaming-panel", (_case, env) => {
	const phase = signal(0);
	const canCancel = signal(true);
	const markdown = signal("# Title\n\nsome **streamed** text");
	const md = single(<md text={markdown} />);
	const wide = single(<text spans={[{ t: "日本語 🎉 ".repeat(10) }]} wrap="word" />);
	const view = computed(() => {
		const p = phase();
		return {
			sections: [
				p === 2 ? undefined : <text spans={[{ t: `Phase ${p}`, s: "accent" }]} wrap="word" />,
				[],
				p >= 1 ? [md, wide] : undefined,
			],
			footer: p === 3 ? "static footer" : canCancel() ? env.theme().fg("dim", "esc cancel · enter copy") : "done",
		};
	});
	return {
		node: single(<StreamingPanel view={view} />),
		apply(label) {
			if (label === "footer provider flipped, refreshed") canCancel.set(false);
			else if (label === "phase 1") phase.set(1);
			else if (label === "markdown appended") markdown.set(MORE);
			else if (label === "phase 2") phase.set(2);
			else if (label === "phase 3 static footer") phase.set(3);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
