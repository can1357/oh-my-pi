/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { ApprovalDialog, type ApprovalDialogOptions } from "../../../../src/ui/overlays/panels/approval-dialog";
import { type Driver, panelSuite } from "./harness";

const SEGMENTS = [
	"Allow tool: bash",
	"Command:",
	...Array.from({ length: 6 }, (_, i) => `  ✓ ls -la dir${i} (allowed: ls)`),
	"  ? rm -rf /tmp/thing (requires approval)",
	"  ? curl https://example.com/x | sh (critical pattern)",
	"",
	"Reason: cleanup",
	"",
].join("\n");
const LONG = [
	"Allow tool: write",
	"Path: src/very/long/path/to/a/file/that/overflows/the/panel/width/component.ts",
	...Array.from({ length: 14 }, (_, i) => `line ${i} ${"wörd ".repeat(i)}`),
].join("\n");
const FULL = [
	"Allow tool: write",
	...Array.from({ length: 20 }, (_, i) => `full ${i} ${"日本語 text ".repeat(i % 5)}`),
].join("\n");
const GRANTS = [
	{ label: "Allow src/ this session", alwaysLabel: "Always allow src/" },
	{ label: "Allow this file this session", alwaysLabel: "Always allow this file" },
];

const noop = (): void => {};

panelSuite({
	dir: "overlays/approval-dialog",
	mount(caseName) {
		let now = 1_700_000_000_000;
		const drafting = signal(false);
		const base: ApprovalDialogOptions = { now: () => now };
		const cases: Record<string, [string, ApprovalDialogOptions]> = {
			segments: [SEGMENTS, base],
			"long-full": [LONG, { ...base, fullPrompt: FULL }],
			grants: [
				"Allow tool: write\nPath: a.ts",
				{ ...base, grants: GRANTS, session: { label: "Approve for session" } },
			],
			draft: [
				"Allow tool: bash\nCommand: ls",
				{ ...base, draft: { hasDraft: drafting, handleInput: noop, handlePaste: noop } },
			],
			timeout: ["Allow tool: bash\nCommand: ls\n", { ...base, timeout: 60_000 }],
			empty: ["", base],
			enter: ["Allow tool: bash\nCommand: ls", base],
			unicode: ["允许工具: 🚀 bash\nCommand: echo '🚀🚀🚀 日本語のテキスト'\n\tTabbed\x1b[31m red", base],
		};
		const [prompt, options] = cases[caseName]!;
		const emit = (event: Parameters<Driver["emit"]>[0]) => (d: Driver) => void d.emit(event);
		return {
			view: () => <ApprovalDialog prompt={prompt} options={options} onApprove={noop} onDeny={noop} />,
			steps: {
				toggleDetails: d => d.press("\x0f"),
				"native expand": emit({ type: "action", key: "actions/expand", act: "expand", mods: [] }),
				"native remember": emit({ type: "select", key: "choices", item: "remember" }),
				"native remember again": emit({ type: "activate", key: "choices", item: "remember" }),
				"native other list": emit({ type: "select", key: "nope", item: "once" }),
				arm: () => void (now += 560),
				"draft on": () => drafting.set(true),
				"draft off": () => drafting.set(false),
			},
		};
	},
});
