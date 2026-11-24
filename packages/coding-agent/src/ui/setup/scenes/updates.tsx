/** @jsxImportSource @oh-my-pi/pi-tui */
/** Updates: install new releases automatically, or only announce them. */
import "../../styles/setup";
import type { SetupScene } from "../types";
import { ChoiceList, ChoiceModel } from "./choice";

type UpdateMode = "auto" | "notify";

export const updatesScene: SetupScene = {
	id: "auto-update",
	title: "Keep omp up to date",
	subtitle: "Choose how new releases reach you.",
	step: "Updates",
	minVersion: 3,
	mount(context) {
		const model = new ChoiceModel<UpdateMode>({
			context,
			choices: [
				{
					value: "auto",
					label: "1 Update automatically",
					detail: "Installs in the background; the next launch runs it",
				},
				{ value: "notify", label: "2 Notify me", detail: "Show a notice on startup; run omp update yourself" },
			],
			initial: context.host.autoUpdate ? "auto" : "notify",
			commit: mode => context.host.saveAutoUpdate(mode === "auto"),
		});
		return {
			body: (
				<col
					role="omp.setup.updates"
					gap="sm"
					term={() => ({ maxLines: context.maxLines() })}
					onKey={key => model.key(key)}
				>
					<text
						wrap="word"
						spans={[
							{
								s: "muted",
								t: "Updates install through whatever installed omp: the standalone binary, Homebrew, mise, bun, or npm. Change this later in /settings.",
							},
						]}
					/>
					<ChoiceList model={model} />
				</col>
			),
			wheel: delta => model.move(delta, false),
		};
	},
};
