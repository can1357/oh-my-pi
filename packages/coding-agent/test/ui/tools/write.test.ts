import "../../../src/ui/styles/tools/write";
import type { ToolPresenter } from "../../../src/ui/tools/contract";
import { type WriteArgs, type WriteDetails, writePresenter } from "../../../src/ui/tools/write";
import { type ToolScreen, toolScreenSuite } from "./screens";

// The screen capture fed the call a spinner frame until "spinner stopped", even after
// the args completed; the transcript spins the head only while args stream.
const capturePresenter: ToolPresenter<WriteArgs, WriteDetails> = {
	...writePresenter,
	call(args, state) {
		const view = writePresenter.call!(args, state);
		return view?.term?.call ? { ...view, term: { ...view.term, spinning: true } } : view;
	},
};

export const writeScreen: ToolScreen = {
	dir: "tools/write",
	name: "write",
	presenter: capturePresenter,
};

toolScreenSuite(writeScreen);
