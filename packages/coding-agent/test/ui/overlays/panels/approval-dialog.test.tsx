/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { signal, type UiEvent } from "@oh-my-pi/pi-tui";
import { bubbleEvent, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { APPROVE_ARM_MS } from "../../../../src/modes/view-model/overlays/approval-dialog";
import {
	type ApprovalChoice,
	ApprovalDialog,
	type ApprovalDialogOptions,
} from "../../../../src/ui/overlays/panels/approval-dialog";
import { mountOverlay } from "../../../helpers/overlay-terminal";
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

const mounted: TestTerminal[] = [];
afterEach(() => {
	for (const term of mounted.splice(0)) term.dispose();
	vi.useRealTimers();
});

/** A UI event without its keypath and modifiers (each union member on its own, so `act` and `item` stay typed). */
type EventInit = UiEvent extends infer E ? (E extends UiEvent ? Omit<E, "key" | "mods"> : never) : never;

interface Opened {
	readonly approved: ApprovalChoice[];
	readonly denied: number[];
	/** Advance the dialog's clock. */
	advance(ms: number): void;
	/** Deliver a UI event to the choices list (select, activate) or the root (actions), bubbling as a Tern terminal's event does. */
	send(event: EventInit): void;
}

function open(options: ApprovalDialogOptions = {}): Opened {
	let clock = 1_000;
	const approved: ApprovalChoice[] = [];
	const denied: number[] = [];
	const term = mountOverlay(() => (
		<ApprovalDialog
			prompt={"Allow tool: write\nPath: a.ts"}
			options={{ ...options, now: () => clock }}
			onApprove={choice => void approved.push(choice)}
			onDeny={() => void denied.push(clock)}
		/>
	));
	mounted.push(term);
	return {
		approved,
		denied,
		advance: ms => void (clock += ms),
		send: event => {
			const root = term.surface.layer()[0]!;
			const list = event.type === "action" ? root : root.children().find(node => node.key() === "choices")!;
			bubbleEvent(pathTo([root], list), { key: "", mods: [], ...event } as UiEvent);
		},
	};
}

const GRANTS_OPTIONS: ApprovalDialogOptions = {
	grants: GRANTS,
	session: { label: "Approve for session" },
};

describe("approval dialog under a native surface", () => {
	it("ignores approving clicks and picks until armed, then takes each", () => {
		const events: [string, EventInit, ApprovalChoice][] = [
			["Approve button", { type: "action", act: "approve" }, { kind: "once" }],
			["once row", { type: "activate", item: "once" }, { kind: "once" }],
			["session row", { type: "select", item: "session" }, { kind: "session" }],
			["grant row", { type: "activate", item: "grant0" }, { kind: "grant", index: 0, remember: false }],
		];
		for (const [name, event, choice] of events) {
			const dialog = open(GRANTS_OPTIONS);
			// A click can land the instant the dialog mounts, like a key: nothing approves.
			dialog.send(event);
			dialog.advance(APPROVE_ARM_MS - 1);
			dialog.send(event);
			expect([name, dialog.approved]).toEqual([name, []]);
			dialog.advance(1);
			dialog.send(event);
			expect([name, dialog.approved]).toEqual([name, [choice]]);
		}
	});

	it("denies at once: deliberate, so it never waits to arm", () => {
		const dialog = open(GRANTS_OPTIONS);
		dialog.send({ type: "action", act: "deny" });
		dialog.send({ type: "activate", item: "deny" });
		expect(dialog.denied).toHaveLength(2);
		expect(dialog.approved).toEqual([]);
	});

	it("takes the remember toggle before arming, and grants then carry it", () => {
		const dialog = open(GRANTS_OPTIONS);
		dialog.send({ type: "activate", item: "remember" });
		dialog.send({ type: "activate", item: "grant1" });
		expect(dialog.approved).toEqual([]);
		dialog.advance(APPROVE_ARM_MS);
		dialog.send({ type: "activate", item: "grant1" });
		expect(dialog.approved).toEqual([{ kind: "grant", index: 1, remember: true }]);
	});

	it("restarts the countdown when the remember row is selected or activated, like a key", () => {
		vi.useFakeTimers();
		const onTimeoutReset = vi.fn();
		const dialog = open({ ...GRANTS_OPTIONS, timeout: 1_000, onTimeoutReset });
		vi.advanceTimersByTime(900);
		dialog.send({ type: "select", item: "remember" });
		expect(onTimeoutReset).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(900);
		expect(dialog.denied).toEqual([]);
		dialog.send({ type: "activate", item: "remember" });
		expect(onTimeoutReset).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(900);
		expect(dialog.denied).toEqual([]);
		// The restarted countdown still runs out.
		vi.advanceTimersByTime(100);
		expect(dialog.denied).toHaveLength(1);
	});

	it("leaves the countdown alone for rows that are not the remember toggle, or when there is no toggle", () => {
		vi.useFakeTimers();
		const onTimeoutReset = vi.fn();
		const withGrants = open({ ...GRANTS_OPTIONS, timeout: 1_000, onTimeoutReset });
		withGrants.send({ type: "select", item: "once" });
		withGrants.send({ type: "select", item: "session" });
		expect(onTimeoutReset).not.toHaveBeenCalled();
		// No grants, no remember row: a stale remember event is not input.
		const plain = open({ timeout: 1_000, onTimeoutReset });
		plain.send({ type: "select", item: "remember" });
		expect(onTimeoutReset).not.toHaveBeenCalled();
	});
});
