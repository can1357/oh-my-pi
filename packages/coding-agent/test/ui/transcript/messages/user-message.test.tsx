/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { UserMessage, type UserMessageModel } from "../../../../src/ui/transcript/messages/user-message";
import { screenSuite, single } from "./harness";

interface UserInputs {
	text: string;
	options: {
		images?: { type: "image"; mimeType: string; data: string }[];
		imageLinks?: string[];
		timestamp?: number;
		liveSteered?: boolean;
		synthetic?: boolean;
		skillPath?: Record<string, string>;
	};
	transcriptActions: boolean;
}

/** The 1×1 PNG the capture attached (`"1x1 png"` in the inputs). */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

screenSuite("user-message", corpusCase => {
	const inputs = corpusCase.inputs as UserInputs;
	const o = inputs.options;
	const reaction = signal<string | undefined>(undefined);
	const zones = signal(true);
	const height = signal<number | undefined>(undefined);
	const model: UserMessageModel = {
		text: inputs.text,
		images: o.images?.map(image => ({
			...image,
			data: image.data === "1x1 png" ? PNG_1X1 : image.data,
		})),
		imageLinks: o.imageLinks,
		timestamp: o.timestamp,
		liveSteered: o.liveSteered,
		synthetic: o.synthetic,
		skillPath: o.skillPath ? name => o.skillPath?.[name] : undefined,
		reaction,
		actions: inputs.transcriptActions,
		promptZones: zones,
	};
	return {
		node: single(<UserMessage model={model} />),
		height: height,
		apply(label) {
			if (label.startsWith("reaction ")) reaction.set(label.slice("reaction ".length));
			else if (label === "allocation 1 row") height.set(1);
			else if (label === "allocation 2 rows") height.set(2);
			else if (label === "allocation unlimited") height.set(undefined);
			else if (label === "prompt zones off") zones.set(false);
			else if (label === "prompt zones on") zones.set(true);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
