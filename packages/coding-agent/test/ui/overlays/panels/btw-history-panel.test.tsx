/** @jsxImportSource @oh-my-pi/pi-tui */
import { decodeMouse } from "@oh-my-pi/pi-tui/driver/input/mouse";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import type { BtwHistoryRecord } from "../../../../src/session/btw-history-model";
import { BtwHistoryPanel } from "../../../../src/ui/overlays/panels/btw-history-panel";
import { BtwHistoryModel } from "../../../../src/ui/overlays/panels/btw-history-panel-model";
import { type Driver, type Mounted, panelSuite } from "./harness";

process.env.TZ = "UTC";

const DAY = 86_400_000;
const now = CORPUS_NOW;
const rec = (id: string, extra: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord => ({
	id,
	leafId: null,
	question: `Question ${id} about \`code\` and a fairly long tail of words to wrap`,
	answer: `Answer for ${id}.\n\n- point one\n- point two with **bold**\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n${"More text. ".repeat(20)}`,
	status: "complete",
	createdAt: now - 1000,
	updatedAt: now - 1000,
	...extra,
});
const records: BtwHistoryRecord[] = [
	rec("a", {
		title: "/sitrep",
		followUps: [
			{
				question: "And then?",
				answer: "Then <inject>Stop the build now.</inject> ok",
				status: "complete",
				createdAt: now - 500,
				updatedAt: now - 500,
			},
			{
				question: "Later 日本語?",
				answer: "",
				status: "error",
				error: "network\tdown",
				createdAt: now - 2 * DAY,
				updatedAt: now,
			},
		],
	}),
	rec("b", { status: "running", answer: "Streaming <inject>half a", createdAt: now - 3 * DAY }),
	rec("c", { status: "interrupted", answer: "", createdAt: now - 400 * DAY }),
	rec("d", { status: "cancelled", answer: "short" }),
	rec("e", { status: "error", answer: "", error: "boom" }),
];

interface Env {
	height: number;
	follow: boolean;
	branch: boolean;
	inject: "pending" | "sent" | undefined;
	canSend: boolean;
	accept: boolean;
}

const DOWN = "\x1b[B";
const tick = () => Bun.sleep(0);

function mount(
	initial: readonly BtwHistoryRecord[],
	height: number,
	options: { escapeHides?: boolean; inject?: boolean } = {},
): Mounted {
	const env: Env = { height, follow: true, branch: true, inject: "pending", canSend: true, accept: true };
	const rows = () => env.height;
	const model = new BtwHistoryModel({
		records: initial,
		onClose: () => {},
		onCopy: () => {},
		onCancel: () => {},
		canFollowUp: () => env.follow,
		canBranch: () => env.branch,
		onBranch: () => {},
		onFollowUp: async () => env.accept,
		terminalRows: rows,
		escapeHides: options.escapeHides,
		inject: options.inject ? { state: () => env.inject, canSend: () => env.canSend, send: () => {} } : undefined,
		now: () => now,
	});
	const press =
		(...keys: string[]) =>
		(driver: Driver) => {
			for (const key of keys) driver.press(key);
		};
	const set = (change: (env: Env) => void) => () => {
		change(env);
		// The host re-reads its predicates (follow-up, branch, inject) when they change.
		model.touch();
	};
	const action = (act: string) => (driver: Driver) => void driver.emit({ type: "action", key: "", act, mods: [] });
	// The recording routed the wheel against the frame it drew last (120 columns: the split).
	const wheel = (row: number, col: number) => (driver: Driver) =>
		driver.mouse(decodeMouse(`\x1b[<65;${col + 1};${row + 1}M`)!, 120);
	const heights = (value: number) => set(env => (env.height = value));
	return {
		view: () => <BtwHistoryPanel model={model} />,
		steps: {
			down: press(DOWN),
			tab: press("\t"),
			"scroll down": press(DOWN),
			"page down": press("\x1b[6~"),
			end: press("\x1b[F"),
			home: press("\x1b[H"),
			left: press("\x1b[D"),
			"page down list": press("\x1b[6~"),
			"end list": press("\x1b[F"),
			"home list": press("\x1b[H"),
			"wheel list": wheel(4, 3),
			"wheel reader": wheel(4, 70),
			"copy key": press("c"),
			"mark copied": () => model.markCopied("a", "Answer for a."),
			"branch key": press("b"),
			"no follow/branch": set(env => ((env.follow = false), (env.branch = false))),
			"inject sent": set(env => ((env.inject = "sent"), (env.canSend = false))),
			"height 10": heights(10),
			"height 7": heights(7),
			"height 3": heights(3),
			"height 2": heights(2),
			"height 1": heights(1),
			"height 0": heights(0),
			"height 40": heights(40),
			"height 5": heights(5),
			"follow on": set(env => ((env.follow = true), (env.branch = true), (env.canSend = true))),
			"open follow-up": press("f"),
			type: press("W", "h", "y", "?"),
			paste: driver => driver.paste(" more"),
			"composer scroll": press("\x1b[5~"),
			"native send": async driver => {
				action("send")(driver);
				await tick();
				await tick();
			},
			"open again": () => void model.openFollowUp("a"),
			"submit empty": async driver => {
				driver.press("\r");
				await tick();
			},
			reject: async driver => {
				env.accept = false;
				driver.press("x");
				driver.press("\r");
				await tick();
				await tick();
			},
			"height 9 composer": heights(9),
			"height 3 composer": heights(3),
			"height 40 again": heights(40),
			discard: action("discard"),
			"select native": driver => void driver.emit({ type: "select", key: "history/records", item: "c" }),
			"activate native": driver => void driver.emit({ type: "activate", key: "history/records", item: "a" }),
			"escape composer": press("\x1b"),
			"native stop": action("stop"),
			"native copy": action("copy-answer"),
			"native inject": action("inject"),
			"show b": () => model.showRecord("b"),
			"update streamed": () =>
				model.update(
					records.map(record =>
						record.id === "b" ? { ...record, answer: `${record.answer} more</inject> tail` } : record,
					),
				),
			"update drop selection": () => model.update(records.slice(2)),
			"update single": () => model.update([records[0]!]),
			"update empty": () => model.update([]),
			update: () => model.update(records),
			escape: press("\x1b"),
			unfocus: () => {},
			log: () => {},
		},
	};
}

const CASES: Record<string, () => Mounted> = {
	"many-framed": () => mount(records, 30, { inject: true }),
	"many-hides": () => mount(records, 24, { escapeHides: true, inject: true }),
	single: () => mount([records[1]!], 20, { inject: true }),
	empty: () => mount([], 20),
	keys: () => mount(records, 16, { escapeHides: true }),
};

panelSuite({
	dir: "overlays/btw-history-panel",
	mount(caseName) {
		const build = CASES[caseName];
		if (!build) throw new Error(`unknown case ${caseName}`);
		return build();
	},
});
