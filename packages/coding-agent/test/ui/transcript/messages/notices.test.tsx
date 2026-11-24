/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { NotificationRule } from "../../../../src/session/transcript/ttsr-notification";
import {
	MessageNotice,
	Notice,
	NoticeLine,
	type NoticeTone,
	Recap,
	type ReminderTodo,
	StatusBlock,
	StatusNotice,
	type StatusRow,
	StrippedToolCalls,
	TangentDispatch,
	TodoReminder,
	TtsrNotice,
} from "../../../../src/ui/transcript/messages/notices";
import { screenSuite, single } from "./harness";

const BOLD = (text: string) => `\x1b[1m${text}\x1b[22m`;
const ITALIC = (text: string) => `\x1b[3m${text}\x1b[23m`;

/** `[["Read "], ["src/a.ts", "path"]]` → spans. */
function docSpans(doc: readonly (readonly string[])[]): TspSpan[] {
	return doc.map(([t, s]) => (s ? { t: t!, s } : { t: t! }));
}

/** The capture's ANSI body: Spacer(1), Text('Job finished' accent, px 1), Text('output line\nsecond', px 3). */
function ansiBody(env: { theme(): { fg(color: string, text: string): string } }) {
	return (
		<canvas
			paint={width => [
				"",
				` ${env.theme().fg("accent", "Job finished")}`.padEnd(width),
				"   output line".padEnd(width),
				"   second".padEnd(width),
			]}
		/>
	);
}

screenSuite("notice", (corpusCase, env) => {
	const inputs = corpusCase.inputs as {
		kind: "line" | "custom";
		tone: "warning" | "error";
		message: string;
		native: {
			tone: NoticeTone;
			message: string | (readonly string[])[];
			icon?: string;
			key?: string;
			body?: (readonly string[])[][];
		};
		ansi: string[];
	};
	if (inputs.kind === "line") {
		const message = inputs.message === "**bold** tail (bold)" ? `${BOLD("bold")} tail` : inputs.message;
		return {
			node: single(<NoticeLine tone={inputs.tone} message={message} />),
		};
	}
	const native = inputs.native;
	const message: TspText = typeof native.message === "string" ? native.message : docSpans(native.message);
	return {
		node: single(
			<Notice
				tone={native.tone}
				message={message}
				icon={native.icon}
				nodeKey={native.key}
				body={native.body?.map(doc => (
					<text spans={docSpans(doc)} />
				))}
				terminal={inputs.ansi.length > 0 ? ansiBody(env) : []}
			/>,
		),
	};
});

screenSuite("status-block", corpusCase => {
	const inputs = corpusCase.inputs as { rows: StatusRow[] };
	return {
		node: single(
			<StatusBlock
				rows={inputs.rows.map(row => ({
					...row,
					parts: row.parts.map(part => part ?? undefined),
				}))}
			/>,
		),
	};
});

screenSuite("status-notice", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: string;
		styleFn?: string;
		toast?: boolean;
		action?: { act: string; label: string };
	};
	return {
		node: single(
			<StatusNotice message={inputs.message} color={inputs.styleFn} toast={inputs.toast} action={inputs.action} />,
		),
	};
});

screenSuite("recap", corpusCase => {
	const inputs = corpusCase.inputs as { recap: string };
	return { node: single(<Recap recap={inputs.recap} />) };
});

/** Stage labels that move the tool-activity toggle. */
function activity(visible: { set(value: boolean): void }, label: string): boolean {
	if (label === "tool activity hidden") visible.set(false);
	else if (label === "tool activity shown") visible.set(true);
	else return false;
	return true;
}

screenSuite("stripped-tool-calls", corpusCase => {
	const inputs = corpusCase.inputs as {
		strippedToolCalls: number;
		toolActivityVisible: boolean;
	};
	const visible = signal(inputs.toolActivityVisible);
	return {
		node: single(<StrippedToolCalls count={inputs.strippedToolCalls} visible={visible} />),
		apply(label) {
			if (!activity(visible, label)) throw new Error(`unknown stage ${label}`);
		},
	};
});

screenSuite("tangent-dispatch", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: { details?: { jobId?: string; work?: string } };
	};
	return { node: single(<TangentDispatch details={inputs.message.details} />) };
});

screenSuite("todo-reminder", corpusCase => {
	const inputs = corpusCase.inputs as {
		todos: ReminderTodo[];
		attempt: number;
		maxAttempts: number;
	};
	const visible = signal(true);
	return {
		node: single(<TodoReminder {...inputs} visible={visible} />),
		apply(label) {
			if (!activity(visible, label)) throw new Error(`unknown stage ${label}`);
		},
	};
});

screenSuite("ttsr-notice", corpusCase => {
	const inputs = corpusCase.inputs as {
		rules: NotificationRule[];
		addedLater: NotificationRule[];
	};
	const rules = signal<readonly NotificationRule[]>(inputs.rules);
	const expanded = signal(false);
	const visible = signal(true);
	return {
		node: single(<TtsrNotice rules={rules} expanded={expanded} visible={visible} />),
		apply(label) {
			if (activity(visible, label)) return;
			if (label === "expanded") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else if (label === "rules added") {
				const next = [...rules()];
				for (const rule of inputs.addedLater) if (!next.some(r => r.name === rule.name)) next.push(rule);
				rules.set(next);
			} else throw new Error(`unknown stage ${label}`);
		},
	};
});

screenSuite("message-notice", corpusCase => {
	const inputs = corpusCase.inputs as {
		variant: "card" | "inline" | "plain";
		severity?: string;
		leadingSpace?: boolean;
		background?: string;
	};
	const { variant } = inputs;
	const expanded = signal(false);
	const visible = signal(true);
	return {
		node: single(
			<MessageNotice
				role="omp.notice.test"
				severity={inputs.severity}
				leadingSpace={inputs.leadingSpace}
				background={inputs.background ? "toolPendingBg" : undefined}
				expanded={expanded}
				visible={visible}
				box={open => ({
					icon: variant === "plain" ? undefined : "status.warning",
					header: `Injecting 1 rules ${BOLD("alpha")}`,
					body:
						variant === "plain"
							? undefined
							: open
								? [ITALIC("line one\nline two\nline three"), "more"]
								: [ITALIC("line one…")],
				})}
				native={{
					head:
						variant === "inline"
							? [
									{ t: "Rule applied: ", s: "warning" },
									{ t: "alpha", s: "mono strong" },
								]
							: "Plain head",
					body:
						variant === "plain"
							? undefined
							: [
									<text propKey="d" spans={[{ t: "desc", s: "em" }]} wrap="word" />,
									<list>
										<item key="i" label="x" />
									</list>,
								],
					preview: variant === "card" ? { lines: 2 } : undefined,
					inline: variant === "inline" ? { icon: "shield-alert" } : undefined,
				}}
			/>,
		),
		apply(label) {
			if (activity(visible, label)) return;
			if (label === "expanded") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
