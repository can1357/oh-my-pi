/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { CollabPrompt, type CollabPromptMessage, CollabQrCode } from "../../../../src/ui/transcript/figures";
import { single } from "../messages/harness";
import { figureSuite } from "./harness";

figureSuite("collab-prompt", corpusCase => {
	const { message } = corpusCase.inputs as { message: CollabPromptMessage };
	return { node: single(<CollabPrompt message={message} />) };
});

figureSuite(
	"collab-qrcode",
	corpusCase => {
		const { url } = corpusCase.inputs as { url: string };
		const height = signal<number | undefined>(undefined);
		return {
			node: single(<CollabQrCode url={url} dark />),
			height,
			apply(label) {
				if (label === "allocation 3 rows") height.set(3);
				else if (label === "allocation unlimited") height.set(undefined);
				else throw new Error(`unknown stage ${label}`);
			},
		};
	},
	{ hyperlinks: true },
);
