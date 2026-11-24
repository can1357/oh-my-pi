/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { DEFAULT_FIGURE_CELL, FigureMarkdown, figureWorkSettled } from "../../../../src/ui/transcript/figures";
import { single } from "../messages/harness";
import { figureSuite } from "./harness";

figureSuite("figure-markdown", corpusCase => {
	const inputs = corpusCase.inputs as {
		text?: string;
		initial?: string;
		charts?: boolean;
		showImages?: boolean;
		maxRows?: number;
		stages?: { streaming: boolean; text?: string; settled?: boolean }[];
	};
	const text = signal(inputs.text ?? inputs.initial ?? "");
	const streaming = signal(false);
	return {
		node: single(
			<FigureMarkdown
				text={text}
				streaming={streaming}
				charts={inputs.charts ?? true}
				showImages={inputs.showImages ?? true}
				maxRows={inputs.maxRows}
				cell={DEFAULT_FIGURE_CELL}
				host={{ cwd: () => "/nonexistent-dir", capturePage: () => Promise.reject(new Error("no browser")) }}
			/>,
		),
		settle: figureWorkSettled,
		apply(_label, index) {
			const stage = inputs.stages?.[index - 1];
			if (!stage) throw new Error(`unknown stage ${_label}`);
			streaming.set(stage.streaming);
			if (stage.text !== undefined) text.set(stage.text);
		},
	};
});
