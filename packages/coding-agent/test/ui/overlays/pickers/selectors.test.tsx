/** @jsxImportSource @oh-my-pi/pi-tui */
import type { SessionPinAccount } from "../../../../src/modes/view-model/overlays/session-account-selector";
import type { ConfiguredThinkingLevel } from "../../../../src/utils/render-utils";
import { QueueModeSelector } from "../../../../src/ui/overlays/pickers/queue-mode-selector";
import { SessionAccountSelector } from "../../../../src/ui/overlays/pickers/session-account-selector";
import { ShowImagesSelector } from "../../../../src/ui/overlays/pickers/show-images-selector";
import { ThemeSelector } from "../../../../src/ui/overlays/pickers/theme-selector";
import { ThinkingSelector } from "../../../../src/ui/overlays/pickers/thinking-selector";
import { type Driver, pickerSuite } from "./harness";

const noop = (): void => {};

/** The steps every small selector case records (`list …` drive the list's keys; events go to the root keypath). */
function listSteps(hasList: boolean): Record<string, (driver: Driver) => void> {
	const event = (type: "select" | "activate", item: string) => (d: Driver) => void d.emit({ type, key: "", item });
	const action = (act: string) => (d: Driver) => void d.emit({ type: "action", key: "", act, mods: [] });
	return {
		"list down": d => hasList && d.press("\x1b[B"),
		"list down again": d => hasList && d.press("\x1b[B"),
		"list up": d => hasList && d.press("\x1b[A"),
		"native select": event("select", "no"),
		"native select other": event("select", "all"),
		"native select theme": event("select", "beta"),
		"native select level": event("select", "high"),
		"native activate": event("activate", "yes"),
		"native confirm": action("confirm"),
		"native cancel": action("cancel"),
		invalidate: noop,
	};
}

pickerSuite({
	dir: "overlays/thinking-selector",
	mount(caseName) {
		const thinking = caseName === "thinking";
		// The fixture's level names; the type is the agent's level enum.
		const current = (thinking ? "low" : undefined) as ConfiguredThinkingLevel | undefined;
		const levels = (
			thinking ? ["auto", "off", "low", "medium", "high"] : ["off", "high"]
		) as ConfiguredThinkingLevel[];
		return {
			view: () => <ThinkingSelector current={current} levels={levels} onSelect={noop} onCancel={noop} />,
			steps: listSteps(true),
		};
	},
});

pickerSuite({
	dir: "overlays/queue-mode-selector",
	mount(caseName) {
		const current = caseName === "queue" ? "all" : "one-at-a-time";
		return {
			view: () => <QueueModeSelector current={current} onSelect={noop} onCancel={noop} />,
			steps: listSteps(true),
		};
	},
});

pickerSuite({
	dir: "overlays/show-images-selector",
	mount(caseName) {
		return {
			view: () => <ShowImagesSelector current={caseName === "show-images-yes"} onSelect={noop} onCancel={noop} />,
			steps: listSteps(true),
		};
	},
});

const THEMES = [
	"dark",
	"light",
	"alpha",
	"beta",
	"a-very-long-theme-name-that-overflows-narrow-widths",
	"日本語テーマ",
];

pickerSuite({
	dir: "overlays/theme-selector",
	mount(caseName) {
		const [current, themes] = caseName === "theme" ? ["light", THEMES] : ["x", []];
		return {
			view: () => (
				<ThemeSelector current={current} themes={themes} onSelect={noop} onCancel={noop} onPreview={noop} />
			),
			steps: listSteps(true),
		};
	},
});

const ACCOUNTS: SessionPinAccount[] = [
	{ position: 0, credentialId: 1, label: "me@example.com", email: "me@example.com", active: false, orgName: "Acme" },
	{
		position: 1,
		credentialId: 2,
		label: "work",
		active: true,
		projectId: "proj-1",
		enterpriseUrl: "https://ghe.example",
	},
	{ position: 2, credentialId: 3, label: "ユーザー", active: false },
];

pickerSuite({
	dir: "overlays/session-account-selector",
	mount(caseName) {
		const [provider, accounts] =
			caseName === "accounts" ? ["Anthropic", ACCOUNTS] : ["Very Long Provider Name With Many Words\tand tab", []];
		return {
			view: () => <SessionAccountSelector provider={provider} accounts={accounts} onSelect={noop} onCancel={noop} />,
			steps: {
				...listSteps(false),
				"native select acct": d => void d.emit({ type: "select", key: "", item: "3" }),
			},
		};
	},
});
