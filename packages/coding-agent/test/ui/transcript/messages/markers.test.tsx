/** @jsxImportSource @oh-my-pi/pi-tui */
import { CacheMissMarker, MessageDivider, ServedModelMarker } from "../../../../src/ui/transcript/messages/markers";
import { screenSuite, single } from "./harness";

interface DividerInputs {
	label: string;
	labelColor: string;
	ruleColor?: string;
	ruleWidth?: number;
	role?: string;
	native?: { icon: string; label: string };
	truncateWhenNarrow?: boolean;
}

/** `<icon.cacheMiss> rest` → the glyph's symbol key and the rest; `**x** (bold)` → bold `x`. */
function dividerLabel(label: string): { glyph?: string; label: string } {
	const glyph = /^<([\w.]+)> (.*)$/.exec(label);
	if (glyph) return { glyph: glyph[1], label: glyph[2]! };
	const bold = /^\*\*(.*)\*\* \(bold\)$/.exec(label);
	if (bold) return { label: `\x1b[1m${bold[1]}\x1b[22m` };
	return { label };
}

screenSuite("message-divider", corpusCase => {
	const inputs = corpusCase.inputs as DividerInputs;
	const { glyph, label } = dividerLabel(inputs.label);
	return {
		node: single(<MessageDivider {...inputs} glyph={glyph} label={label} />),
	};
});

screenSuite("cache-miss-marker", corpusCase => {
	const inputs = corpusCase.inputs as { reprocessedTokens: number };
	return { node: single(<CacheMissMarker info={inputs} />) };
});

screenSuite("served-model-marker", corpusCase => {
	const inputs = corpusCase.inputs as {
		requested: string;
		served: string;
		provider: string;
	};
	return { node: single(<ServedModelMarker info={inputs} />) };
});
