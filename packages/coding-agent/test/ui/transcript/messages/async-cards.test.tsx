/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterAll, expect, setSystemTime, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../../src/ui/styles/tools/irc";
import type { AsyncNotifyDetails, ProcessWatchNotice } from "../../../../src/session/transcript/messages";
import { extensionOutput } from "../../../../src/ui/extensions/render-output";
import {
	AsyncNotify,
	AsyncResult,
	IrcMessageBlock,
	LaunchCompletion,
	type LaunchCompletionDetails,
	ParentIrcMessage,
	ProcessWatch,
	processWatchRows,
} from "../../../../src/ui/transcript/messages/async-cards";
import type { FramedMessage, FrameRenderer } from "../../../../src/ui/transcript/messages/frame";
import { region, screenSuite, single } from "./harness";

afterAll(() => setSystemTime());

/** The transcript's expansion and tool-activity toggles, driven by the stage labels. */
function toggles() {
	const expanded = signal(false);
	const visible = signal(true);
	return {
		expanded,
		visible,
		apply(label: string): void {
			if (label === "expanded") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else if (label === "tool activity hidden") visible.set(false);
			else if (label === "tool activity shown") visible.set(true);
			else throw new Error(`unknown stage ${label}`);
		},
	};
}

/** The capture's `async-result` renderers, by how the inputs describe them. */
function renderer(doc: string | null): FrameRenderer | undefined {
	if (doc === null) return undefined;
	if (doc.startsWith("returns undefined")) return () => undefined;
	if (doc.startsWith("throws")) {
		return () => {
			throw new Error("boom");
		};
	}
	if (doc.startsWith("always")) {
		const same = <text spans={[{ t: "custom same" }]} wrap="word" />;
		return () => same;
	}
	if (doc.startsWith("returns a rows object")) {
		return expanded =>
			extensionOutput({
				render: () => [`rows ${expanded ? "expanded" : "collapsed"}`],
			});
	}
	const flip = doc.startsWith("undefined while collapsed");
	return expanded =>
		flip && !expanded ? undefined : (
			<text spans={[{ t: `custom ${expanded ? "expanded" : "collapsed"}`, s: "accent" }]} wrap="word" />
		);
}

screenSuite("async-result", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: FramedMessage & { details?: unknown };
		renderer: string | null;
	};
	const t = toggles();
	return {
		node: region(
			<AsyncResult
				message={inputs.message}
				expanded={t.expanded}
				visible={t.visible}
				renderer={renderer(inputs.renderer)}
				onToggle={open => t.expanded.set(open)}
			/>,
		),
		apply: t.apply,
	};
});

screenSuite("async-notify", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: { details?: AsyncNotifyDetails };
	};
	const t = toggles();
	return {
		node: single(<AsyncNotify details={inputs.message.details} visible={t.visible} />),
		apply: t.apply,
	};
});

screenSuite("launch-completion", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: { details?: LaunchCompletionDetails; content: unknown };
	};
	const t = toggles();
	return {
		node: single(
			<LaunchCompletion details={inputs.message.details} content={inputs.message.content} visible={t.visible} />,
		),
		apply: t.apply,
	};
});

screenSuite("irc-message", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: { customType: string; details?: unknown; timestamp: number };
		nowMs: number;
	};
	setSystemTime(new Date(inputs.nowMs));
	const t = toggles();
	return {
		node: single(<IrcMessageBlock message={inputs.message} expanded={t.expanded} visible={t.visible} />),
		apply: t.apply,
	};
});

screenSuite("parent-irc", corpusCase => {
	const inputs = corpusCase.inputs as {
		parentIrc: { from: string; body: string };
		timestamp: number;
		nowMs: number;
	};
	setSystemTime(new Date(inputs.nowMs));
	const t = toggles();
	return {
		node: single(
			<ParentIrcMessage parentIrc={inputs.parentIrc} timestamp={inputs.timestamp} expanded={t.expanded} />,
		),
		apply: t.apply,
	};
});

test("a process-watch notice draws one row per flagged job with its command and output beneath", () => {
	const details: ProcessWatchNotice = {
		jobs: [
			{
				jobId: "bg_7",
				command: "npm install",
				ageMs: 120_000,
				quietMs: 90_000,
				lastOutput: "fetching metadata\nretrying registry",
				verdict: "stalled",
			},
		],
		hostStrain: ["memory pressure"],
	};
	const node = single(<ProcessWatch details={details} visible={signal(true)} />);
	const terminal = paintNode(staticEnvironment(currentTheme()), node, 120).rows.map(stripEscapes).join("\n");
	expect(terminal).toContain("Looks stalled bg_7");
	expect(terminal).toContain("npm install");
	expect(terminal).toContain("retrying registry");
	expect(terminal).toContain("Host shows memory pressure");
	// The job row and the host row are notices; the command and output are the job row's body.
	expect(processWatchRows(details).filter(row => !row.native.body)).toHaveLength(2);
});
