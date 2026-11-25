/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The Spotlight notice opens its sheet: a notice with an original carries the `spotlight` action and
 * activates its opener; the transcript mounts it after a shaped result's card, and the terminal draws
 * none of it.
 */
import { describe, expect, it } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { SpotlightDetails } from "../../../src/tools/details/spotlight";
import { SpotlightNotice } from "../../../src/ui/transcript/figures/spotlight";
import { createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";
import { single } from "./messages/harness";

const SHAPED: SpotlightDetails = {
	tool: "bash",
	steps: ["window"],
	inChars: 48_800,
	outChars: 2_400,
	inTokens: 52_000,
	outTokens: 12_000,
	savedTokens: 40_000,
	original: { url: "local://7.log", lines: 5, start: 1, heat: "1-29", kept: [[1, 1]] },
};

function find(node: UiNode, role: string): UiNode | undefined {
	if (node.props().role === role) return node;
	for (const child of node.children()) {
		const found = find(child, role);
		if (found) return found;
	}
	return undefined;
}

describe("Spotlight notice", () => {
	it("activates its opener through the spotlight action when it has an original", () => {
		let opened = 0;
		const node = single(<SpotlightNotice toolCallId="c1" spotlight={SHAPED} onOpen={() => opened++} />);
		expect(node.props().actions).toEqual({ click: "spotlight" });
		node.handlers.onAction?.("spotlight", { type: "action", key: "", act: "spotlight", mods: [] });
		expect(opened).toBe(1);
	});

	it("has no action without an original or an opener", () => {
		const { original: _, ...held } = SHAPED;
		const bare = single(<SpotlightNotice toolCallId="c1" spotlight={{ ...held, holdout: true }} onOpen={() => {}} />);
		expect(bare.props().actions).toBeUndefined();
		const unhosted = single(<SpotlightNotice toolCallId="c1" spotlight={SHAPED} />);
		expect(unhosted.props().actions).toBeUndefined();
	});
});

describe("transcript Spotlight notices", () => {
	it("mounts a shaped result's notice after its card, drawing no terminal rows", () => {
		const ctx = createInteractiveModeContext();
		const pending = ctx.presentToolCall({
			name: "bash",
			args: { command: "ls" },
			tool: undefined,
			id: "c1",
			cwd: "/",
		});
		pending.updateResult({ content: [{ type: "text", text: "a\nb" }], details: {} }, false, "c1");
		expect(find(pending.block.node, "omp.tool.spotlight")).toBeUndefined();
		const plain = renderTranscript(ctx);

		pending.updateResult({ content: [{ type: "text", text: "a\nb" }], details: { spotlight: SHAPED } }, false, "c1");
		expect(find(pending.block.node, "omp.tool.spotlight")).toBeDefined();
		expect(renderTranscript(ctx)).toEqual(plain);
	});
});
