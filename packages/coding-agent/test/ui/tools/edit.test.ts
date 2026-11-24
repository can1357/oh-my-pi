import "../../../src/ui/styles/tools/edit";
import type { EditToolDetails } from "../../../src/tools/details/edit";
import type { ToolPresenter } from "../../../src/ui/tools/contract";
import { type EditArgs, editToolPresenter } from "../../../src/ui/tools/edit";
import { type ToolScreen, toolScreenSuite } from "./screens";

// The screen capture fed the renderer a spinner frame until "spinner stopped", even after
// the args completed or while a result streamed; the transcript spins only while args stream.
const capturePresenter: ToolPresenter<EditArgs, EditToolDetails> = {
	...editToolPresenter,
	call(args, state) {
		const view = editToolPresenter.call!(args, state);
		return view && { ...view, term: { ...view.term, spinning: true } };
	},
	result(result, state, args) {
		const view = editToolPresenter.result!(result, state, args);
		return view && state.isPartial ? { ...view, term: { ...view.term, spinning: true } } : view;
	},
};

export const editScreen: ToolScreen = {
	dir: "tools/edit",
	name: "edit",
	presenter: capturePresenter,
};

toolScreenSuite(editScreen);
