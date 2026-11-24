/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Move the session to another directory: a path field with directory
 * suggestions under it. Typing filters them, ↑/↓ choose, Tab accepts the
 * highlighted suggestion into the field, Enter confirms the highlighted
 * suggestion (the typed path when none match), ctrl+g cancels.
 */
import { type JSXNode, signal, untrack } from "@oh-my-pi/pi-tui";
import type {
	MoveDirectoryEntry,
	MoveDirectorySource,
	MoveOverlayResult,
} from "../../../modes/view-model/overlays/move-overlay";
import { ActionButton, applyEdit } from "./common";
import { editLine } from "../settings/line-edit";
import "../../styles/panels/move-overlay";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { actionKbd, actionKeyId, cancelKbd, confirmKbd } from "../../keys/hints";
import { keyTitle } from "../../styles/panels/common";

/** Suggestions listed at most. */
const MAX_RESULTS = 8;

export interface MoveOverlayProps {
	readonly cwd: string;
	readonly source: MoveDirectorySource;
	/** The chosen directory; undefined when cancelled. */
	onDone(result: MoveOverlayResult | undefined): void;
}

export function MoveOverlay(props: MoveOverlayProps): JSXNode {
	const text = signal("");
	const cursor = signal(0);
	const search = (query: string): MoveDirectoryEntry[] => props.source.search(query, props.cwd, MAX_RESULTS);
	const results = signal<readonly MoveDirectoryEntry[]>(search(""));
	const selected = signal<string | null>(untrack(results)[0]?.value ?? null);
	const setText = (value: string, at: number) => {
		text.set(value);
		cursor.set(at);
		const found = search(value);
		results.set(found);
		selected.set(found[0]?.value ?? null);
	};
	const move = (delta: number) => {
		const list = untrack(results);
		const at = list.findIndex(entry => entry.value === untrack(selected));
		if (list.length === 0 || at < 0) return;
		selected.set(list[Math.max(0, Math.min(list.length - 1, at + delta))]!.value);
	};
	const selectResult = (value: string): boolean => {
		if (!untrack(results).some(entry => entry.value === value)) return false;
		selected.set(value);
		return true;
	};
	const accept = () => {
		const value = untrack(selected);
		if (value !== null) setText(value, value.length);
	};
	const confirm = () => {
		const typed = untrack(text).trim();
		const directory = untrack(selected) ?? typed;
		props.onDone(directory ? { directory } : undefined);
	};
	return (
		<card
			role="omp.dialog.move"
			head="Move to directory"
			onKey={key => {
				if (matchesSelectCancel(key) || key.id === "ctrl+g") {
					props.onDone(undefined);
					return true;
				}
				switch (selectKeyId(key)) {
					case "up":
						move(-1);
						return true;
					case "down":
						move(1);
						return true;
					case "tab":
						accept();
						return true;
					case "enter":
						confirm();
						return true;
				}
				const next = editLine({ text: untrack(text), cursor: untrack(cursor) }, key);
				if (!next) return false;
				if (next.text !== untrack(text)) setText(next.text, next.cursor);
				else cursor.set(next.cursor);
				return true;
			}}
			onPaste={paste => {
				const value = untrack(text);
				const at = untrack(cursor);
				const clean = paste.text.replace(/[\r\n]+/g, "");
				setText(`${value.slice(0, at)}${clean}${value.slice(at)}`, at + clean.length);
				return true;
			}}
			onAction={act => {
				if (act === "accept") accept();
				else if (act === "confirm") confirm();
				else if (act === "cancel") props.onDone(undefined);
			}}
		>
			<col role="omp.form.field" gap="sm">
				<input
					prompt="Path: "
					sendable={false}
					text={text}
					cursor={cursor}
					onEdit={edit => {
						const next = applyEdit({ text: untrack(text), cursor: untrack(cursor) }, edit);
						if (!next) return;
						if (next.text !== untrack(text)) setText(next.text, next.cursor);
						else cursor.set(next.cursor);
					}}
				/>
				<text hidden text="" />
			</col>
			<list
				key="results"
				selected={selected}
				onSelect={selectResult}
				onActivate={item => {
					if (selectResult(item)) confirm();
				}}
				empty={() => (text() === "" ? undefined : [{ s: "dim", t: "No matching directories" }])}
			>
				{() =>
					results().map(entry => (
						<item key={entry.value} label={entry.label} detail={[{ s: "path", t: entry.value }]} />
					))
				}
			</list>
			<row align="center" gap="md" wrap>
				<text spans={[{ s: "dim", t: "Type to filter" }]} />
				<row key="hints" role="omp.overlay.hints" gap="md" wrap>
					<row align="center" gap="xs">
						<kbd keys={actionKbd("tui.select.up", "up")} />
						<kbd keys={actionKbd("tui.select.down", "down")} />
						<text spans={[{ s: "muted", t: "navigate" }]} />
					</row>
				</row>
			</row>
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<ActionButton id="accept" label="Accept" title="Accept  ⇥" keys={["tab"]} />
				<spacer grow={1} />
				<ActionButton
					id="cancel"
					label="Cancel"
					title={`Cancel  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`}
					keys={cancelKbd()}
				/>
				<ActionButton
					id="confirm"
					label="Confirm"
					title={`Confirm  ${keyTitle(actionKeyId("tui.select.confirm", "enter"))}`}
					tone="accent"
					keys={confirmKbd()}
				/>
			</row>
		</card>
	);
}
