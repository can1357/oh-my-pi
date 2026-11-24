/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A titled card over a list of options, shown in the composer's place (the
 * debug tools menu): `card` > `spacer`, `omp.select` (`list` of `item`s, then
 * the search status once the options outgrow the visible rows). The terminal
 * look: `../../styles/panels/select-card`.
 *
 * Keys are the list's own: ↑/↓ wrap, PgUp/PgDn jump a page, Home/End go to
 * the ends, Enter picks, the selector cancel key cancels. With more options
 * than rows, typed text filters them (the search text edits like a line; the
 * highlight stays on its option while it still matches). A click on an option
 * picks it. Focus the `list`.
 */
import { batch, computed, For, type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { sanitizeStatusText } from "../../../modes/view-model/chrome/shared";
import { fuzzyFilter } from "../../../utils/fuzzy";
import "../../styles/panels/select-card";
import { editLine, type LineState } from "../settings/line-edit";

/** One option of a {@link SelectCard}. */
export interface SelectCardItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** What a {@link SelectCard} shows. */
export interface SelectCardProps {
	readonly title: string;
	/** The card's `role` (default `omp.overlay`). */
	readonly role?: string;
	readonly items: readonly SelectCardItem[];
	/** Rows of the list before it scrolls and type-to-search turns on. */
	readonly maxVisible: number;
	/** The user picked `value`. */
	onPick(value: string): void;
	onCancel(): void;
}

/** A select card (see the module docs). */
export function SelectCard(props: SelectCardProps): JSXNode {
	const all = props.items;
	const maxVisible = Math.max(1, Math.trunc(props.maxVisible));
	const searchable = all.length > maxVisible;
	const search = signal<LineState>({ text: "", cursor: 0 });
	const visible = computed<readonly SelectCardItem[]>(() => {
		const query = search().text.trim();
		if (!query) return all;
		return fuzzyFilter([...all], query, item =>
			sanitizeStatusText(`${item.label} ${item.value}${item.description ? ` ${item.description}` : ""}`),
		);
	});
	const selected = signal<string | null>(all[0]?.value ?? null);
	const at = (): number => visible().findIndex(item => item.value === selected());
	const moveTo = (index: number): void => {
		const items = visible();
		if (items.length === 0) return;
		selected.set(items[Math.max(0, Math.min(index, items.length - 1))]!.value);
	};
	const step = (delta: number, wrap: boolean): void => {
		const total = visible().length;
		if (total === 0) return;
		const next = at() + delta;
		moveTo(wrap ? (next + total) % total : next);
	};
	const pick = (): void => {
		const value = selected();
		if (value !== null && visible().some(item => item.value === value)) props.onPick(value);
	};
	const setQuery = (next: LineState): void =>
		batch(() => {
			const changed = next.text !== search().text;
			search.set(next);
			// The highlight stays on its option while it still matches, else moves to the best match.
			if (changed && at() < 0) selected.set(visible()[0]?.value ?? null);
		});
	/** The search field's share of a key: false while the list does not search or the key would only pad an empty query. */
	const searchKey = (key: KeyEvent): boolean => {
		if (!searchable) return false;
		const line = search();
		if (line.text.length === 0) {
			if (key.id === "backspace") return false;
			if (key.text !== undefined && key.text.trim().length === 0) return false;
		}
		const next = editLine(line, key);
		if (!next) return false;
		setQuery(next);
		return true;
	};
	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		if (matchesSelectCancel(key)) {
			props.onCancel();
			return true;
		}
		// Typed text filters even when it collides with a navigation binding.
		if (key.text !== undefined && key.text.length > 0 && searchKey(key)) return true;
		switch (selectKeyId(key)) {
			case "up":
				step(-1, true);
				return true;
			case "down":
				step(1, true);
				return true;
			case "pageUp":
				step(-maxVisible, false);
				return true;
			case "pageDown":
				step(maxVisible, false);
				return true;
			case "home":
				moveTo(0);
				return true;
			case "end":
				moveTo(visible().length - 1);
				return true;
			case "enter":
				pick();
				return true;
		}
		searchKey(key);
		return true;
	};
	const click = (value: string): void => {
		if (!visible().some(item => item.value === value)) return;
		selected.set(value);
		props.onPick(value);
	};
	const status = (): string => {
		const query = sanitizeStatusText(search().text);
		return query ? `Search: ${query}` : "Type to search";
	};

	return (
		<card role={props.role ?? "omp.overlay"} head={sanitizeStatusText(props.title)} onKey={onKey}>
			<spacer size="sm" />
			<col role="omp.select">
				<list
					key="list"
					selected={selected}
					filter={() => search().text.trim() || undefined}
					empty={() => (search().text.trim() ? "No matching items" : "No items")}
					max={{ lines: maxVisible }}
					onSelect={click}
					onActivate={click}
				>
					<For each={visible}>
						{item => (
							<item
								key={item.value}
								label={[{ t: sanitizeStatusText(item.label) }]}
								detail={
									item.description ? [{ s: "muted", t: sanitizeStatusText(item.description) }] : undefined
								}
							/>
						)}
					</For>
				</list>
				{() =>
					searchable || search().text.length > 0 ? (
						<text key="status" spans={[{ s: "muted", t: status() }]} wrap="none" />
					) : null
				}
			</col>
		</card>
	);
}
