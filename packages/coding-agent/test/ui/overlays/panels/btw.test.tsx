/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import type { BtwInjectState } from "../../../../src/modes/view-model/overlays/btw-inject";
import type { BtwNoteHost } from "../../../../src/modes/view-model/overlays/btw-note";
import { type BtwHistoryRecord, splitBtwInject } from "../../../../src/session/btw-history-model";
import { BtwInjectAnswer } from "../../../../src/ui/overlays/panels/btw-answer";
import { BtwNote } from "../../../../src/ui/overlays/panels/btw-note";
import { BtwPanel, BtwPanelState } from "../../../../src/ui/overlays/panels/btw-panel";
import { CleansePanel, CleanseRun } from "../../../../src/ui/overlays/panels/cleanse-panel";
import { OmfgPanel, OmfgPanelState } from "../../../../src/ui/overlays/panels/omfg-panel";
import { type Driver, panelSuite } from "./harness";

const INJECT_ANSWERS: Record<string, string> = {
	full: "It is looping, see `ps`.\n\n- one\n- two\n<inject>Stop the audit now, cancel every running agent, delete the clone, and report what you removed.\n\nSecond paragraph\twith tab.</inject>\nThat should **do** it.",
	only: "<inject>Stop.</inject>",
	open: "Status ok.\n<inject>Stop ret",
	unicode: "日本語の説明 🎉\n<inject>止めて 🛑 now\n\n\x1b[31mred\x1b[0m</inject>\n終わり",
	blank: "  \n<inject>\n</inject>\n  ",
};

panelSuite({
	dir: "overlays/btw-inject",
	nativeOnly: caseName => caseName.includes("-native-"),
	mount(caseName) {
		const match = /^(\w+)(-native)?-sent-(true|false)(?:-stream-(true|false))?$/.exec(caseName)!;
		const parts = splitBtwInject(INJECT_ANSWERS[match[1]!]!)!;
		const state: BtwInjectState = match[3] === "true" ? "sent" : "pending";
		return { view: () => <BtwInjectAnswer parts={parts} state={state} stream={match[4] === "true"} /> };
	},
});

const NOTE_BASE: BtwHistoryRecord = {
	id: "r1",
	leafId: null,
	question: "Why is `bun test` slow?",
	answer: "Because of **reasons**.\n<inject>Stop running the full suite.</inject>\nDone.",
	status: "complete",
	createdAt: 1,
	updatedAt: 1,
};
const NOTE_RUNNING: BtwHistoryRecord = { ...NOTE_BASE, answer: "", status: "running" };
const NOTE_FAILED: BtwHistoryRecord = { ...NOTE_BASE, answer: "", status: "error", error: "network\ndown" };
const NOTE_FOLLOW_UPS: BtwHistoryRecord = {
	...NOTE_BASE,
	title: "/sitrep",
	followUps: [
		{ question: "And `then`?", answer: "Then this. 日本語 🎉", status: "complete", createdAt: 2, updatedAt: 2 },
		{ question: "Last?", answer: "partial <inject>half", status: "running", createdAt: 3, updatedAt: 3 },
	],
};
const NOTE_ERRORED: BtwHistoryRecord = {
	...NOTE_FOLLOW_UPS,
	followUps: [
		{ question: "x", answer: "has text", status: "error", error: "bad", createdAt: 2, updatedAt: 2 },
		{ question: "y", answer: "", status: "interrupted", createdAt: 3, updatedAt: 3 },
	],
};

panelSuite({
	dir: "overlays/btw-note",
	nativeOnly: () => true,
	mount(caseName) {
		const env = { inject: "pending" as BtwInjectState | undefined, menuExtra: false, runs: [] as string[] };
		const host: BtwNoteHost = {
			menu: (record, folded) => [
				{ id: folded ? "btw-expand" : "btw-fold", label: folded ? "Open" : "Fold" },
				...(env.menuExtra ? [{ id: "btw-copy", label: `Copy ${record.id}` }] : []),
			],
			injectState: () => env.inject,
			run: (record, action) => env.runs.push(`${record.id}:${action}`),
		};
		const record = signal(caseName === "open" ? NOTE_BASE : NOTE_RUNNING);
		const folded = signal(caseName === "folded");
		const active = signal(false);
		const revision = signal(0);
		const refresh = () => revision.set(revision() + 1);
		const action = (act: string) => (d: Driver) => void d.emit({ type: "action", key: "", act, mods: [] });
		return {
			view: () => <BtwNote record={record} folded={folded} active={active} revision={revision} host={host} />,
			steps: {
				running: () => record.set(NOTE_RUNNING),
				failed: () => record.set(NOTE_FAILED),
				"follow-ups": () => record.set(NOTE_FOLLOW_UPS),
				active: () => active.set(true),
				"inject sent (no refresh)": () => void (env.inject = "sent"),
				refresh,
				"menu extra + refresh": () => ((env.menuExtra = true), refresh()),
				fold: () => folded.set(true),
				"fold running": () => record.set(NOTE_FOLLOW_UPS),
				unfold: () => folded.set(false),
				"errored follow-up": () => record.set(NOTE_ERRORED),
				"inject plain": () => ((env.inject = undefined), refresh()),
				inactive: () => active.set(false),
				event: action("btw-copy"),
				"event other": action("nope"),
				runs: () => {
					if (env.runs.join() !== "r1:btw-copy") throw new Error(`runs ${env.runs.join()}`);
				},
			},
		};
	},
});

const PANEL_ANSWER = "It is looping, see `ps aux`.\n\n1. first\n2. second\twith tab";
const PANEL_INJECT =
	"It is looping.\n<inject>Stop the audit now, cancel every running agent, and report.</inject>\nThat should **do** it.";

panelSuite({
	dir: "overlays/btw-panel",
	mount(caseName) {
		const flags = { follow: false, branch: undefined as boolean | undefined, inject: true };
		const question =
			{ plain: "What is up?", "inject-streaming": "Stuck?", "inject-title": "x", "no-inject-plain-block": "q" }[
				caseName
			] ?? "long ".repeat(40);
		const inject = caseName === "inject-streaming" || caseName === "inject-title";
		const state = new BtwPanelState(caseName === "inject-title" ? "/sitrep the migration 日本語" : undefined);
		return {
			view: () => (
				<BtwPanel
					question={question}
					state={state}
					canFollowUp={() => flags.follow}
					canBranch={flags.branch === undefined ? undefined : () => flags.branch!}
					canInject={inject ? () => flags.inject : undefined}
				/>
			),
			steps: {
				"empty answer": () => state.setAnswer("   "),
				answer: () => state.setAnswer(caseName === "plain" ? PANEL_ANSWER : PANEL_INJECT),
				complete: () => state.markComplete(),
				copied: () => state.markCopied(),
				"title set": () => state.title.set("custom\ntitle"),
				"open block finished": () => state.setAnswer("a\n<inject>unclosed"),
				"empty complete": () => state.setAnswer(""),
				error: () => state.markError(caseName === "error-unknown" ? "" : "boom\nsecond line\twith tab"),
				aborted: () => state.markAborted(),
				"delta 1": () => state.appendText("It is "),
				"delta 2": () => state.appendText("looping.\n<inject>Stop the"),
				"delta 3": () => state.appendText(" audit now.</inject>\nDone."),
				injected: () => state.setInjected(true),
				"not injected": () => state.setInjected(false),
				"append clears copy": () => state.appendText(" more"),
				"copied again": () => state.markCopied(),
				branching: () => state.markBranching(),
				close: () => state.close(),
				"after close": () => state.setAnswer("ignored"),
				"flip flags": () => {
					flags.follow = !flags.follow;
					flags.branch = flags.branch === undefined ? true : !flags.branch;
					flags.inject = !flags.inject;
				},
			},
		};
	},
});

panelSuite({
	dir: "overlays/omfg-panel",
	mount(caseName) {
		const complaint =
			caseName === "flow" ? "stop\tusing unwrap" : caseName === "empty" ? "" : `${"x".repeat(300)} 日本語`;
		const state = new OmfgPanelState();
		return {
			view: () => <OmfgPanel complaint={complaint} state={state} />,
			steps: {
				append: () => state.appendDraft("---\nname: no-unwrap\n"),
				"append empty": () => state.appendDraft(""),
				"append more": () => state.appendDraft("---\n# Rule\n\n- never `unwrap()`\n\t- tabbed 日本語\n"),
				validating: () => state.setStatus("validating", "Attempt 1/3 · validating\twith tab"),
				setRule: () => state.setRule("# Final rule\n\nBody **bold**"),
				confirming: () => state.setStatus("confirming", "Couldn't confirm a conversation match."),
				saving: () => state.setStatus("saving", "Saving no-unwrap…"),
				rejected: () => state.markRejected(),
				aborted: () => state.markAborted(),
				error: () => state.markError("The model did not return a valid TTSR rule.\nsecond\tline"),
				"clear rule": () => state.setRule(""),
				generating: () => state.setStatus("generating", "Attempt 2/3 · generating"),
				"empty rule": () => state.setRule("   "),
				"error default": () => state.markError(""),
				close: () => state.close(),
				"after close": () => state.setStatus("saving", "ignored"),
				"after close append": () => state.appendDraft("ignored"),
			},
		};
	},
});

const ASSIGNMENT = { index: 0, groups: [{ file: "src/a.ts" }, { file: "src/b.ts" }], weight: 3 };
const CLEANSE_ENDINGS: Record<string, (run: CleanseRun) => void> = {
	clean: run => run.finish("clean"),
	unresolved: run => run.finish("unresolved"),
	unsupported: run => run.finish("unsupported"),
	cancelled: run => run.finish("cancelled"),
	error: run => run.markError("Unexpected\tfailure 日本語"),
	close: run => run.close(),
};

panelSuite({
	dir: "overlays/cleanse-panel",
	mount(caseName) {
		const run = new CleanseRun(() => 1_700_000_000_000);
		const steps: Record<string, () => void> = {
			phase: () => run.phase("Discovering checkers…"),
			checkerStarted: () => run.checkerStarted({ id: "tsc", label: "tsc" }),
			"checkerStarted 2": () => run.checkerStarted({ id: "lint", label: "oxlint\twith tab" }),
			log: () => run.log("plain\tlog line 日本語"),
			logError: () => run.logError("stderr line"),
			checkerFinished: () => run.checkerFinished({ id: "tsc", label: "tsc", diagnostics: [1, 2] }, 1234),
			"checkerFinished clean": () => run.checkerFinished({ id: "lint", label: "oxlint", diagnostics: [] }, 50),
			"phase clear": () => run.phase(undefined),
			agentStarted: () => run.agentStarted("agent-1", ASSIGNMENT),
			agentProgress: () => run.agentProgress("agent-1", { tokens: 1200, cost: 0.02 } as never),
			agentFinished: () => run.agentFinished({ name: "agent-1", success: true, resolvedModel: "m" }, ASSIGNMENT),
			"agentStarted 2": () => run.agentStarted("agent-2", ASSIGNMENT),
			"agentFinished err": () =>
				run.agentFinished({ name: "agent-2", success: false, error: "boom\nline" }, ASSIGNMENT),
			repairFinished: () => run.repairFinished(),
		};
		for (let i = 0; i < 16; i++) steps[`log ${i}`] = () => run.log(`line ${i}`);
		const ending = CLEANSE_ENDINGS[caseName];
		if (ending) steps.finish = () => ending(run);
		return {
			view: () => <CleansePanel run={run} request={caseName === "no-request" ? undefined : "fix\tall"} />,
			steps,
		};
	},
});
