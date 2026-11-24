/** @jsxImportSource @oh-my-pi/pi-tui */
import { type JSXNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import type { TranscriptBlock, TranscriptPresentation } from "../../../../src/extensibility/extensions/render-types";
import { PresentedBlock } from "../../../../src/ui/transcript/figures";
import { region } from "../messages/harness";
import { figureSuite } from "./harness";

type Face = "rows" | "tool" | "tool-target" | "card";

/** The stand-in faces' terminal rows: `inner <face> collapsed|expanded` (accent) over `x` × min(width, 50). */
type InnerTerm = {
	role: "test.inner";
	rows: (width: number) => string[];
};

function innerRows(node: UiNode, width: number): string[] {
	return ((node.props() as { term?: InnerTerm }).term?.rows ?? (() => []))(width);
}

defineRolePainter("tool", "test.inner", (node, cx) => ({ rows: innerRows(node, cx.width) }));
defineRolePainter("card", "omp.test", (node, cx) => ({ rows: innerRows(node, cx.width) }));

figureSuite("presented-block", (corpusCase, { env }) => {
	const inputs = corpusCase.inputs as { inner: { face: Face }; block: TranscriptBlock };
	const face = inputs.inner.face;
	const presentation = signal<TranscriptPresentation>(undefined);
	const expanded = signal(false);
	const visible = signal(true);
	const height = signal<number | undefined>(undefined);
	const rows = (width: number): string[] =>
		visible()
			? [
					env.theme().fg("accent", `inner ${face} ${expanded() ? "expanded" : "collapsed"}`),
					"x".repeat(Math.min(width, 50)),
				]
			: [];
	const term: InnerTerm = { role: "test.inner", rows };
	let inner: JSXNode;
	if (face === "rows") {
		inner = (
			<col>
				<canvas paint={rows} />
			</col>
		);
	} else if (face === "card") {
		inner = (
			<card role="omp.test" head="Test card" collapsed={() => !expanded()} term={term}>
				<text text={() => (expanded() ? "body expanded" : "body")} />
			</card>
		);
	} else {
		inner = (
			<tool
				name="bash"
				title="Bash"
				status="done"
				target={face === "tool-target" ? "ls -la" : undefined}
				term={term}
			>
				<text text="output" />
			</tool>
		);
	}
	const custom: TranscriptPresentation = {
		compact: {
			label: [{ t: "Custom label", s: "accent" }],
			rows: ["row one", [{ t: "row two", s: "muted" }], "row\tthree\nwrapped"],
		},
	};
	return {
		node: region(
			<PresentedBlock
				block={inputs.block}
				presentation={presentation}
				expanded={expanded}
				onToggle={collapsed => expanded.set(!collapsed)}
				activityVisible={visible}
			>
				{inner}
			</PresentedBlock>,
		),
		height,
		apply(label) {
			if (label === "presenter compact") presentation.set("compact");
			else if (label === "presenter compact with label and rows") presentation.set(custom);
			else if (label === "allocation 2 rows") height.set(2);
			else if (label === "allocation 0 rows") height.set(0);
			else if (label === "allocation unlimited") height.set(undefined);
			else if (label === "tool activity hidden") visible.set(false);
			else if (label === "tool activity shown") visible.set(true);
			else if (label === "expanded") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else if (label === "presenter hidden") presentation.set("hidden");
			else if (label === "presenter full") presentation.set("full");
			else if (label === "presenter undecided") presentation.set(undefined);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
