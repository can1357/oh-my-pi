/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import type { SpotlightDetails } from "../../../../src/tools/details/spotlight";
import { SpotlightNotice } from "../../../../src/ui/transcript/figures";
import { single } from "../messages/harness";
import { figureSuite } from "./harness";

figureSuite("spotlight", corpusCase => {
	const inputs = corpusCase.inputs as { toolCallId: string; details: SpotlightDetails };
	const hidden = signal<boolean | undefined>(undefined);
	return {
		node: single(<SpotlightNotice toolCallId={inputs.toolCallId} spotlight={inputs.details} hidden={hidden} />),
		apply(label) {
			if (label === "hidden") hidden.set(true);
			else if (label === "shown") hidden.set(undefined);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
