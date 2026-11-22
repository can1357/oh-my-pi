/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The agent's sandbox access request in the composer's place, like the
 * tool-approval prompt: the request (title, the agent's intent, the command,
 * omp's own statement of the effect, what the agent does if denied) over the
 * choices Allow for this session, Always allow (when the backing list can be
 * saved), Deny and Reply with instructions, with Deny / Allow buttons.
 *
 * Reply opens a text field in the choices' place: submitting sends the reply,
 * an empty reply or Esc goes back to the choices. Esc on the choices denies.
 * Typing on the choices starts a reply, so text meant for the composer plus
 * Enter never grants. Enter and the granting choices are ignored for
 * {@link APPROVE_ARM_MS} after the dialog opens, so a key or click already in
 * flight cannot grant.
 */
import {
	type JSXNode,
	type KeyEvent,
	type PasteEvent,
	signal,
	type TextEdit,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { APPROVE_ARM_MS } from "../../../modes/view-model/overlays/approval-dialog";
import {
	MAX_ALTERNATIVE_ROWS,
	MAX_EFFECT_ROWS,
	MAX_INTENT_ROWS,
	SANDBOX_ACCESS_CHOICE_LABELS,
	type SandboxAccessChoice,
	type SandboxAccessView,
	sandboxAccessChoices,
	sandboxAccessFields,
} from "../../../modes/view-model/overlays/sandbox-access-dialog";
import type { SandboxAccessAnswer } from "../../../sandbox/types";
import { actionKeyId, cancelKbd, kbdOf } from "../../keys/hints";
import "../../styles/panels/sandbox-access-dialog";
import { keyTitle } from "../../styles/panels/common";
import { ActionButton, applyEdit, feedField, type LineValue } from "./common";

export interface SandboxAccessDialogProps {
	readonly view: SandboxAccessView;
	/** The highlighted choice on open (default: Allow for this session); the host passes `deny` over a composer draft. */
	readonly initialChoice?: SandboxAccessChoice;
	/** Clock (ms), for the arming delay. */
	readonly now?: () => number;
	/** The user's answer; called once. */
	onAnswer(answer: SandboxAccessAnswer): void;
}

/** What the terminal look reads beside the nodes. */
export type SandboxAccessTerm = {
	readonly title: string;
	readonly intent: readonly string[];
	readonly command?: string;
	readonly effect: readonly string[];
	readonly alternative: readonly string[];
	readonly replying: boolean;
};

const REPLY_PLACEHOLDER = "Tell the agent what to do instead";
const strong = (text: string): TspSpan[] => [{ s: "strong", t: text }];

export function SandboxAccessDialog(props: SandboxAccessDialogProps): JSXNode {
	const now = props.now ?? Date.now;
	const openedAt = now();
	const fields = sandboxAccessFields(props.view);
	const choices = sandboxAccessChoices(props.view.canAlways);
	const initial = props.initialChoice;
	const selected = signal<SandboxAccessChoice>(initial && choices.includes(initial) ? initial : "session");
	/** The reply while the user writes instructions. */
	const reply = signal<LineValue | undefined>(undefined);
	let field: UiNode | undefined;
	let answered = false;
	const finish = (answer: SandboxAccessAnswer): void => {
		if (answered) return;
		answered = true;
		props.onAnswer(answer);
	};
	const armed = () => now() - openedAt >= APPROVE_ARM_MS;
	const openReply = (line: LineValue = { text: "", cursor: 0 }): void => {
		selected.set("instruct");
		reply.set(line);
	};
	const back = (): void => reply.set(undefined);
	/** Take choice `id`; a granting one only once armed, one this dialog does not offer never. */
	const choose = (id: string): void => {
		const choice = choices.find(candidate => candidate === id);
		if (choice === undefined) return;
		if (choice === "deny") finish({ decision: "deny" });
		else if (choice === "instruct") openReply();
		else if (armed()) finish({ decision: choice });
	};
	const send = (): void => {
		const line = untrack(reply);
		if (!line) return;
		const instructions = line.text.trim();
		if (instructions) finish({ decision: "instruct", instructions });
		else back();
	};
	const edit = (change: TextEdit): void => {
		const current = untrack(reply);
		const next = current && applyEdit(current, change);
		if (next) reply.set(next);
	};
	const move = (delta: number): void => {
		const at = choices.indexOf(untrack(selected));
		selected.set(choices[(at + delta + choices.length) % choices.length]!);
	};
	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		if (untrack(reply)) {
			if (getKeybindings().matches(key, "tui.input.submit")) send();
			else if (matchesSelectCancel(key)) back();
			else if (field) feedField(field, { key }, edit);
			return true;
		}
		if (matchesSelectCancel(key)) {
			finish({ decision: "deny" });
			return true;
		}
		switch (selectKeyId(key)) {
			case "up":
				move(-1);
				return true;
			case "down":
				move(1);
				return true;
			case "enter":
				if (armed()) choose(untrack(selected));
				return true;
		}
		// Typing (a message meant for the composer, or a reply) goes to the reply: text never grants.
		if (key.text) {
			openReply({ text: key.text, cursor: key.text.length });
			return true;
		}
		return false;
	};
	const onPaste = (paste: PasteEvent): boolean => {
		if (untrack(reply)) {
			if (field) feedField(field, { paste }, edit);
			return true;
		}
		// The field is not drawn yet: it opens holding the paste, flattened to one line as the field would.
		const text = paste.text.replace(/\r\n?|\n/g, " ");
		openReply({ text, cursor: text.length });
		return true;
	};
	const submitKey = getKeybindings().keysFor("tui.input.submit")[0] ?? "enter";
	const cancelKey = actionKeyId("tui.select.cancel", "escape");
	return (
		<col
			role="omp.editor.ask.sandbox"
			gap="md"
			term={(): SandboxAccessTerm => ({ ...fields, replying: reply() !== undefined })}
			onKey={onKey}
			onPaste={onPaste}
			onAction={act => {
				if (act === "send") send();
				else if (act === "back") back();
				else choose(act);
			}}
		>
			<text key="title" role="omp.approval.title" tone="accent" text={fields.title} truncate="end" />
			<col key="intent" role="omp.sandbox.access.intent" gap="xs">
				<text spans={strong("Intent")} />
				<text text={fields.intent.join("\n") || "(none given)"} wrap="word" lines={MAX_INTENT_ROWS} />
			</col>
			{fields.command !== undefined && (
				<col key="command" role="omp.sandbox.access.command" gap="xs">
					<text spans={strong("Command")} />
					<text spans={[{ s: "mono", t: fields.command }]} truncate="end" />
				</col>
			)}
			<col key="effect" role="omp.sandbox.access.effect" gap="xs">
				<text spans={strong("Effect")} />
				<text text={fields.effect.join("\n")} wrap="word" lines={MAX_EFFECT_ROWS} />
			</col>
			{fields.alternative.length > 0 && (
				<col key="alternative" role="omp.sandbox.access.alternative" gap="xs">
					<text spans={strong("If denied")} />
					<text text={fields.alternative.join("\n")} wrap="word" lines={MAX_ALTERNATIVE_ROWS} />
				</col>
			)}
			{() =>
				reply() === undefined ? (
					<list
						key="choices"
						role="omp.approval.choices"
						selected={selected}
						onSelect={choose}
						onActivate={choose}
					>
						{choices.map(id => (
							<item
								key={id}
								role="omp.approval.choice"
								tone={id === "deny" ? "error" : "accent"}
								label={SANDBOX_ACCESS_CHOICE_LABELS[id]}
							/>
						))}
					</list>
				) : (
					<col key="reply" role="omp.sandbox.access.reply" gap="xs">
						<text spans={strong(SANDBOX_ACCESS_CHOICE_LABELS.instruct)} />
						<input
							prompt="> "
							placeholder={REPLY_PLACEHOLDER}
							sendable={false}
							text={() => reply()?.text ?? ""}
							cursor={() => reply()?.cursor ?? 0}
							onEdit={edit}
							ref={node => {
								field = node ?? undefined;
							}}
						/>
					</col>
				)
			}
			{() =>
				reply() === undefined ? (
					<row key="actions" role="omp.actions" align="center" gap="sm">
						<spacer grow={1} />
						<ActionButton
							id="deny"
							label="Deny"
							title={`Deny this request  ${keyTitle(cancelKey)}`}
							tone="error"
							keys={cancelKbd()}
						/>
						<ActionButton
							id="session"
							label={SANDBOX_ACCESS_CHOICE_LABELS.session}
							title="Allow this access until the session ends"
							tone="accent"
						/>
					</row>
				) : (
					<row key="reply-actions" role="omp.actions" align="center" gap="sm">
						<spacer grow={1} />
						<ActionButton
							id="back"
							label="Back"
							title={`Back to the choices  ${keyTitle(cancelKey)}`}
							keys={cancelKbd()}
						/>
						<ActionButton
							id="send"
							label="Send"
							title={`Send the reply  ${keyTitle(submitKey)}`}
							tone="accent"
							keys={kbdOf(submitKey)}
						/>
					</row>
				)
			}
		</col>
	);
}
