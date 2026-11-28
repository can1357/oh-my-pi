/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import { createSurface, settle } from "@oh-my-pi/pi-tui/surface";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
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

test("emits complete OSC 133 zones only on first retirement, not during viewport or history redraws", async () => {
	const term = memoryTerminal({ columns: 40, rows: 8 });
	const driver = createTerminalDriver(term.options);
	const rebuilt = signal(false);
	const dock = signal<readonly string[]>([]);
	const first = { text: "first prompt", promptZoneKey: {} };
	const surface = createSurface(() => ({
		main: () =>
			rebuilt()
				? [
						<UserMessage key="rebuilt" model={first} />,
						<UserMessage key="suppressed" model={{ text: "unmarked prompt", promptZones: false }} />,
						<UserMessage key="new" model={{ text: "next prompt" }} />,
					]
				: <UserMessage key="original" model={first} />,
		dock: <rows lines={dock} />,
	}));
	const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME });
	const output = () => term.output.join("");
	const reset = () => {
		driver.resetDisplay();
		backend.renderNow();
	};
	try {
		await driver.start();
		backend.start();
		for (let i = 0; i < 5; i++) reset();
		expect(output()).toContain("first prompt");
		expect(output()).not.toContain("\x1b]133;");

		// The top two rows enter history; the bubble's bottom padding is still live.
		settle(surface.main()[0]!);
		dock.set(["1", "2", "3", "4", "5", "6", "7"]);
		backend.renderNow();
		const zones = () =>
			Array.from(output().matchAll(/\x1b]133;A\x07\x1b]133;B\x07(.*?)\x1b]133;C\x07\x1b]133;D;0\x07/g), match =>
				Bun.stripANSI(match[1]!).trim(),
			);
		expect(zones()).toEqual(["first prompt"]);

		reset(); // Rewrites the partially retired bubble at the head of the viewport.
		rebuilt.set(true); // A transcript rebuild can also remount the same message.
		reset();
		backend.flush();
		expect(zones()).toEqual(["first prompt", "next prompt"]);
		expect(output().match(/\x1b]133;[ABCD]/g)).toHaveLength(8);
	} finally {
		backend.stop();
		await driver.stop();
		surface.dispose();
	}
});
