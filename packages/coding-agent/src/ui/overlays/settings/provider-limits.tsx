/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The in-flight request limits editor (`providers.maxInFlightRequests`): a
 * provider list (each with its cap, plus "Clear all limits" once any is set)
 * and, for the picked provider, a number field. The settings page has no
 * control for a per-provider map, so the window shows this as an
 * `omp.prefs.editor` child; its keys are the program's.
 */
import { type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import type { SettingsHost } from "../../../config/settings-defs";
import { editLine, type LineState } from "./line-edit";
import { listKeyId, matchesSelectCancel } from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { bindingGlyph } from "../../styles/panels/common";

const CLEAR_ALL = "__clear_all";
/** Rows the provider list shows before it scrolls. */
const LIST_ROWS = 12;

/** An open limits editor. */
export interface ProviderLimitsEditor {
	/** The editor as form fields (a Tern terminal draws them; the window paints them in place of its rows). */
	readonly view: JSXNode;
	key(key: KeyEvent): void;
}

interface Choice {
	readonly value: string;
	readonly label: string;
	readonly detail: string;
}

/** A labelled form field around `control`. */
function Field(props: {
	label: string;
	description: string;
	control: JSXNode;
	error: () => string;
	hint: string;
}): JSXNode {
	return (
		<col role="omp.form.field" gap="sm">
			<text spans={[{ s: "strong", t: props.label }]} />
			<text spans={[{ s: "muted", t: props.description }]} />
			{props.control}
			{() => {
				const error = props.error();
				return error ? <text spans={[{ s: "error", t: error }]} /> : <text text="" hidden />;
			}}
			<text spans={[{ s: "muted", t: props.hint }]} />
		</col>
	);
}

export function createProviderLimitsEditor(
	settings: SettingsHost,
	providers: readonly string[],
	callbacks: { onChange(value: Record<string, number>): void; onClose(): void },
): ProviderLimitsEditor {
	const limits = (): Record<string, number> =>
		settings.normalizeProviderLimits(settings.get("providers.maxInFlightRequests"));
	const choices = (): Choice[] => {
		const current = limits();
		const ids = [...new Set([...providers, ...Object.keys(current)])].sort((a, b) => a.localeCompare(b));
		const out: Choice[] = ids.map(id => ({
			value: id,
			label: id,
			detail: current[id] === undefined ? "Unlimited" : `Limit: ${current[id]}`,
		}));
		if (Object.keys(current).length > 0)
			out.push({ value: CLEAR_ALL, label: "Clear all limits", detail: "Make every provider unlimited" });
		return out;
	};
	const list = signal(choices());
	const selected = signal(0);
	const provider = signal<string | null>(null);
	const line = signal<LineState>({ text: "", cursor: 0 });
	const error = signal("");

	const apply = (next: Record<string, number>): void => {
		const normalized = settings.validateProviderLimits(next);
		settings.set("providers.maxInFlightRequests", normalized);
		callbacks.onChange(normalized);
		callbacks.onClose();
	};

	const submit = (id: string): void => {
		const value = line().text.trim();
		const next = { ...limits() };
		if (value === "") delete next[id];
		else {
			const limit = Number(value);
			if (!Number.isFinite(limit) || limit <= 0) {
				error.set("Limit must be a positive number.");
				return;
			}
			next[id] = Math.max(1, Math.floor(limit));
		}
		apply(next);
	};

	const key = (key: KeyEvent): void => {
		const editing = provider();
		if (editing !== null) {
			if (matchesSelectCancel(key)) {
				provider.set(null);
				error.set("");
				list.set(choices());
			} else if (getKeybindings().matches(key, "tui.input.submit")) submit(editing);
			else {
				const next = editLine(line(), key);
				if (next) {
					line.set(next);
					error.set("");
				}
			}
			return;
		}
		const items = list();
		switch (listKeyId(key)) {
			case "escape":
				callbacks.onClose();
				return;
			case "up":
				selected.set((selected() - 1 + items.length) % items.length);
				return;
			case "down":
				selected.set((selected() + 1) % items.length);
				return;
			case "enter":
			case "ctrl+j": {
				const choice = items[selected()];
				if (!choice) return;
				if (choice.value === CLEAR_ALL) {
					apply({});
					return;
				}
				const text = limits()[choice.value]?.toString() ?? "";
				line.set({ text, cursor: text.length });
				provider.set(choice.value);
				return;
			}
		}
	};

	const view = (
		<col>
			{() => {
				const editing = provider();
				if (editing !== null)
					return (
						<Field
							label={`Max In-Flight Requests: ${editing}`}
							description="Enter a positive number. Decimals round down. Clear the field to make this provider unlimited."
							control={
								<input text={() => line().text} cursor={() => line().cursor} prompt="> " sendable={false} />
							}
							error={error}
							hint={`  ${bindingGlyph("tui.input.submit", "enter")} to save · ${bindingGlyph("tui.select.cancel", "escape")} to cancel · Clear field to unset`}
						/>
					);
				return (
					<Field
						label="Max In-Flight Requests"
						description="Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited."
						control={
							<col role="omp.select">
								<list
									key="list"
									empty="No items"
									max={() => ({ lines: Math.min(list().length || 1, LIST_ROWS) })}
									selected={() => list()[selected()]?.value ?? null}
								>
									{() =>
										list().map(choice => (
											<item
												key={choice.value}
												label={[{ t: choice.label }]}
												detail={[{ s: "muted", t: choice.detail }]}
											/>
										))
									}
								</list>
							</col>
						}
						error={error}
						hint={`  ${bindingGlyph("tui.select.confirm", "enter")} to edit provider · ${bindingGlyph("tui.select.cancel", "escape")} to go back`}
					/>
				);
			}}
		</col>
	);
	return { view, key };
}
