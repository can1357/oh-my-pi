/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The tool-approval prompt: the call (its first prompt line as title, the
 * rest as scrolling details, command segments tinted by whether a rule
 * allowed them), the choices (remember across sessions, per-grant scopes,
 * once, for the session, deny), and Deny/Approve buttons; `Details` swaps in
 * the full prompt when there is one.
 *
 * Enter and the approve keys are ignored for {@link APPROVE_ARM_MS} after the
 * prompt opens, so a key already in flight cannot answer it. With a draft
 * host, typing edits the composer draft; submitting it steers and denies the
 * call. An explicit Deny leaves the draft in place.
 */
import {
	type Accessor,
	type JSXNode,
	type KeyEvent,
	type PasteEvent,
	onCleanup,
	type ScrollRequest,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { APPROVE_ARM_MS } from "../../../modes/view-model/overlays/approval-dialog";
import "../../styles/panels/approval-dialog";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import {
	appApproveKeys,
	appToolsExpandKeys,
	matchesAnyKey,
	matchesSelectCancel,
	selectKeyId,
} from "../../../config/keybindings/matchers";
import { actionKeyId, cancelKbd, kbdOf } from "../../keys/hints";
import { keyTitle } from "../../styles/panels/common";
import { ActionButton } from "./common";

/** A scope a grant choice approves (this session, or always once remembered). */
export interface ApprovalGrant {
	readonly label: string;
	readonly alwaysLabel: string;
}

/** What the user chose to approve. */
export type ApprovalChoice =
	| { readonly kind: "once" }
	| { readonly kind: "session" }
	| { readonly kind: "grant"; readonly index: number; readonly remember: boolean };

export interface ApprovalDialogOptions {
	/** The whole call, shown by Details. */
	readonly fullPrompt?: string;
	readonly grants?: readonly ApprovalGrant[];
	/** Approve every call of this kind for the session. */
	readonly session?: { readonly label: string };
	/** The composer draft typing goes to (deny and steer). */
	readonly draft?: {
		readonly hasDraft: Accessor<boolean>;
		handleInput(key: KeyEvent): void;
		handlePaste(paste: PasteEvent): void;
	};
	/** Deny after this many ms without input (every key restarts the countdown). */
	readonly timeout?: number;
	/** The countdown ran out; the dialog denies right after. */
	onTimeout?(): void;
	/** The countdown started (the dialog opened with a timeout). */
	onTimeoutStart?(): void;
	/** Input restarted the countdown. */
	onTimeoutReset?(): void;
	/** Clock (ms), for the arming delay. */
	readonly now?: () => number;
}

export interface ApprovalDialogProps {
	readonly prompt: string;
	readonly options?: ApprovalDialogOptions;
	onApprove(choice: ApprovalChoice): void;
	/** Deny without sending or clearing the draft. */
	onDeny(): void;
}

/** Prompt lines as shown: escapes stripped, tabs expanded, trailing blank lines dropped. */
function promptLines(text: string): string[] {
	const lines = replaceTabs(stripEscapes(text)).split("\n");
	while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
	return lines;
}

/** A command segment line (`  ✓ cmd (allowed: …)`, `  ? cmd (requires approval)`) as spans. */
function segmentSpans(line: string): TspSpan[] | undefined {
	const match = /^(\s*)([✓?])\s(.*)$/.exec(line);
	if (!match) return undefined;
	const [, indent, mark, rest] = match;
	const spans: TspSpan[] = [];
	if (indent) spans.push({ t: indent });
	if (mark === "✓") {
		spans.push({ s: "success", t: "✓" }, { t: " " }, { s: "dim", t: rest! });
		return spans;
	}
	const why = rest!.lastIndexOf(" (");
	spans.push({ s: "warning", t: "?" }, { t: " " });
	if (why > 0) spans.push({ s: "accent strong", t: rest!.slice(0, why) }, { s: "warning", t: rest!.slice(why) });
	else spans.push({ s: "accent strong", t: rest! });
	return spans;
}

/** Details rows shown before they scroll. */
const DETAIL_ROWS = 8;

export function ApprovalDialog(props: ApprovalDialogProps): JSXNode {
	const options = props.options ?? {};
	const now = options.now ?? Date.now;
	const openedAt = now();
	const summary = promptLines(props.prompt);
	const title = summary[0] ?? "";
	const full = options.fullPrompt === undefined ? undefined : promptLines(options.fullPrompt).slice(1);
	const grants = options.grants ?? [];
	const expanded = signal(false);
	const remember = signal(false);
	const scroll = signal<ScrollRequest>({ by: "start", n: 0 });
	const ids = [
		...(grants.length > 0 ? ["remember"] : []),
		...grants.map((_, i) => `grant${i}`),
		"once",
		...(options.session ? ["session"] : []),
		"deny",
	];
	const selected = signal("once");
	const drafting = () => options.draft?.hasDraft() ?? false;
	const current = () => (drafting() ? "deny" : selected());
	const onceLabel = grants.length > 0 ? "Approve Once" : "Approve";
	const expandKey = actionKeyId("app.tools.expand", "ctrl+o");
	const labelOf = (id: string): string => {
		if (id === "remember") {
			const glyph = currentTheme().symbols.symbol(remember() ? "checkbox.checked" : "checkbox.unchecked");
			return `${glyph} Remember across sessions`;
		}
		if (id.startsWith("grant")) {
			const grant = grants[Number(id.slice(5))]!;
			return remember() ? grant.alwaysLabel : grant.label;
		}
		if (id === "once") return onceLabel;
		if (id === "session") return options.session!.label;
		return "Deny";
	};
	const armed = () => now() - openedAt >= APPROVE_ARM_MS;
	const choose = (id: string) => {
		if (!ids.includes(id)) return;
		if (id === "remember") remember.set(!untrack(remember));
		else if (id === "deny") props.onDeny();
		else if (!armed()) return;
		else if (id === "once") props.onApprove({ kind: "once" });
		else if (id === "session") props.onApprove({ kind: "session" });
		else props.onApprove({ kind: "grant", index: Number(id.slice(5)), remember: untrack(remember) });
	};
	/** A row picked by pointer: input like a key, so the remember toggle restarts the countdown. */
	const pick = (id: string) => {
		if (id === "remember" && ids.includes(id)) resetCountdown();
		choose(id);
	};
	const move = (delta: number) => {
		const at = ids.indexOf(untrack(selected));
		selected.set(ids[(at + delta + ids.length) % ids.length]!);
	};
	/** First details row the terminal shows (it clamps to the details). */
	const offset = signal(0);
	const scrollBy = (by: ScrollRequest["by"]) => {
		scroll.set({ by, n: untrack(scroll).n + 1 });
		const page = DETAIL_ROWS - 1;
		offset.set(
			Math.max(0, Math.min(untrack(offset) + (by === "page-down" ? page : -page), details().length - DETAIL_ROWS)),
		);
	};
	const toggle = () => {
		if (!full) return;
		expanded.set(!untrack(expanded));
		offset.set(0);
	};
	const details = (): string[] => (expanded() && full ? full : summary.slice(1));
	// The countdown: restarted by every key, it denies when it runs out.
	const timeout = options.timeout !== undefined && options.timeout > 0 ? options.timeout : undefined;
	let timer: Timer | undefined;
	const startCountdown = (): void => {
		if (timeout === undefined) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			options.onTimeout?.();
			props.onDeny();
		}, timeout);
	};
	const resetCountdown = () => {
		if (timeout === undefined) return;
		startCountdown();
		options.onTimeoutReset?.();
	};
	if (timeout !== undefined) {
		options.onTimeoutStart?.();
		startCountdown();
		onCleanup(() => clearTimeout(timer));
	}
	return (
		<col
			role="omp.editor.ask.approval"
			gap="md"
			term={() => ({
				title: `${title}${options.timeout !== undefined ? ` (${Math.round(options.timeout / 1000)}s)` : ""}`,
				drafting: drafting(),
				draftHost: options.draft !== undefined,
				expandable: full !== undefined,
				expanded: expanded(),
				offset: offset(),
			})}
			onKey={key => {
				if (key.kind === "release") return false;
				resetCountdown();
				if (matchesAnyKey(key, appApproveKeys())) {
					if (armed()) props.onApprove({ kind: "once" });
					return true;
				}
				if (matchesAnyKey(key, appToolsExpandKeys())) {
					if (!full) return false;
					toggle();
					return true;
				}
				const draft = options.draft;
				const editing = draft?.hasDraft();
				const bindings = getKeybindings();
				if (matchesSelectCancel(key) && !(editing && bindings.matches(key, "app.clear"))) {
					props.onDeny();
					return true;
				}
				if (draft && editing) {
					draft.handleInput(key);
					return true;
				}
				switch (selectKeyId(key)) {
					case "up":
						move(-1);
						return true;
					case "down":
						move(1);
						return true;
					case "pageUp":
						scrollBy("page-up");
						return true;
					case "pageDown":
						scrollBy("page-down");
						return true;
					case "enter":
						if (armed()) choose(untrack(selected));
						return true;
				}
				if (draft && !bindings.matches(key, "tui.input.submit")) {
					draft.handleInput(key);
					return true;
				}
				return false;
			}}
			onPaste={paste => {
				if (!options.draft) return false;
				resetCountdown();
				options.draft.handlePaste(paste);
				return true;
			}}
			onAction={act => {
				if (act === "approve") {
					if (armed()) props.onApprove({ kind: "once" });
				} else if (act === "deny") props.onDeny();
				else if (act === "expand") toggle();
			}}
		>
			<text key="title" role="omp.approval.title" tone="accent" text={title} />
			{() =>
				details().length > 0 && (
					<list key="details-scroll" max={{ lines: DETAIL_ROWS }}>
						<col key="details" role="omp.approval.details" scroll={scroll}>
							{() => {
								const cut = !(expanded() && full);
								return details().map((line, i) => {
									const spans = segmentSpans(line);
									return spans ? (
										<text key={String(i)} spans={spans} truncate={cut ? "end" : undefined} />
									) : (
										<text key={String(i)} text={line} truncate={cut ? "end" : undefined} />
									);
								});
							}}
						</col>
					</list>
				)
			}
			<list key="choices" role="omp.approval.choices" selected={current} onSelect={pick} onActivate={pick}>
				{ids.map(id => (
					<item
						key={id}
						role="omp.approval.choice"
						tone={id === "deny" ? "error" : "accent"}
						label={() => labelOf(id)}
					/>
				))}
			</list>
			<row key="actions" role="omp.actions" align="center" gap="sm">
				{options.timeout !== undefined && <elapsed format="short" age={-options.timeout} />}
				<spacer grow={1} />
				{full && (
					<ActionButton
						id="expand"
						label={() => (expanded() ? "Less" : "Details")}
						title={() => `${expanded() ? "Summarize" : "Show every detail of"} this call  ${keyTitle(expandKey)}`}
						keys={kbdOf(expandKey)}
					/>
				)}
				<ActionButton
					id="deny"
					label="Deny"
					title={`Deny this call  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`}
					tone="error"
					keys={cancelKbd()}
				/>
				<ActionButton
					id="approve"
					label={onceLabel}
					title={`Approve this call  ${keyTitle(appApproveKeys()[0] ?? "ctrl+enter")}`}
					tone="accent"
					keys={kbdOf(appApproveKeys()[0] ?? "ctrl+enter")}
				/>
			</row>
		</col>
	);
}
