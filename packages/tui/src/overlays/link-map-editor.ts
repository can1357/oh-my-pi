/**
 * `/settings` editor for `tui.linkMap`: the entries, sorted by prefix, then Add entry…, Test a path… and Clear
 * all entries. The target form shows the link a sample path under the prefix gets as the target is typed.
 * Saving an entry stays in the editor; Escape from the list closes it.
 */
import { expandTilde } from "@oh-my-pi/pi-utils";
import { formTheme } from "../chrome/form-theme";
import { editorKey } from "../chrome/keybinding-hints";
import { SelectFormField, TextFormField } from "../components/form";
import { Text } from "../components/text";
import { Container, type SelectItem, type SgrMouseEvent } from "../index";
import { fileUriForTerminal } from "../render/hyperlink";
import { isLinkMapKey, matchLinkEntry, parseLinkTarget } from "../render/link-map";
import { TERMINAL } from "../terminal-capabilities";
import { getSelectListTheme } from "../theme/theme";
import { sanitizeDisplayLine } from "./extensions/display-text";
import type { SettingsHost } from "./settings-defs";

const LINK_MAP_PATH = "tui.linkMap";

function linkMapEntries(value: unknown): Record<string, string> {
	const entries: Record<string, string> = {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return entries;
	for (const [key, target] of Object.entries(value)) {
		if (typeof target === "string") entries[key] = target;
	}
	return entries;
}

export function formatLinkMapValue(value: unknown): string {
	const keys = Object.keys(linkMapEntries(value)).sort((a, b) => a.localeCompare(b));
	if (keys.length === 0) return "None";
	return sanitizeDisplayLine(`${keys.length} ${keys.length === 1 ? "entry" : "entries"}: ${keys.join(", ")}`);
}

function acceptableTarget(value: string): boolean {
	return value.trim() === "" || parseLinkTarget(value) !== undefined;
}

function sampleLine(key: string, target: string): string {
	const samplePath = sanitizeDisplayLine(`${key.endsWith("/") ? key : `${key}/`}example.md`);
	const trimmed = target.trim();
	if (trimmed === "") return `${samplePath} → (entry removed)`;
	const prefix = parseLinkTarget(trimmed);
	return `${samplePath} → ${prefix === undefined ? "(invalid target)" : `${prefix}example.md`}`;
}

export class LinkMapSubmenu extends Container {
	#listField: SelectFormField | undefined;
	/** Refreshes the target form's sample line after a keystroke; unset outside that form. */
	#afterInput: (() => void) | undefined;
	readonly #settings: SettingsHost;
	readonly #onChange: (value: Record<string, string>) => void;
	readonly #onClose: () => void;
	readonly #requestRender: (() => void) | undefined;

	/**
	 * @param onChange - called with the whole map after every save; the editor stays open
	 * @param onClose - called when Escape leaves the entry list
	 */
	constructor(
		settings: SettingsHost,
		onChange: (value: Record<string, string>) => void,
		onClose: () => void,
		requestRender?: () => void,
	) {
		super();
		this.#settings = settings;
		this.#onChange = onChange;
		this.#onClose = onClose;
		this.#requestRender = requestRender;
		this.#showList();
	}

	#entries(): Record<string, string> {
		return linkMapEntries(this.#settings.get(LINK_MAP_PATH));
	}

	#save(next: Record<string, string>): void {
		this.#settings.set(LINK_MAP_PATH, next);
		this.#onChange(next);
	}

	#showList(note?: string): void {
		this.clear();
		this.#afterInput = undefined;
		const entries = this.#entries();
		// A `--config` file or a runtime override outranks the global config this editor writes.
		const readOnly = this.#settings.isReadOnly?.(LINK_MAP_PATH) === true;
		const keys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
		const items: SelectItem[] = keys.map(key => ({
			value: `entry:${key}`,
			label: key,
			description:
				isLinkMapKey(key) && parseLinkTarget(entries[key]) !== undefined
					? `→ ${entries[key]}`
					: `→ ${entries[key]} (ignored: not a valid entry)`,
		}));
		if (!readOnly) {
			items.push({
				value: "__add",
				label: "Add entry…",
				description: "A path prefix and the URI prefix its links go to",
			});
		}
		items.push({
			value: "__test",
			label: "Test a path…",
			description: "Show which entry a path matches and its link",
		});
		if (keys.length > 0 && !readOnly) {
			items.push({
				value: "__clear_all",
				label: "Clear all entries",
				description: "Links fall back to PI_LINK_SCHEME or plain file links",
			});
		}
		this.#listField = new SelectFormField({
			theme: formTheme,
			label: "Link Map",
			description:
				note !== undefined
					? sanitizeDisplayLine(note)
					: readOnly
						? "Set by a --config file or a runtime override, so it is shown here but edited there."
						: "Each entry sends file links under a path prefix to a URI prefix; the longest matching prefix wins.",
			items,
			maxVisible: 12,
			selectTheme: getSelectListTheme(),
			hint: `  ${editorKey("tui.select.confirm")} to choose · ${editorKey("tui.select.cancel")} to close`,
			onSubmit: value => {
				if (value === "__clear_all") {
					this.#save({});
					this.#backToList("Cleared every entry.");
				} else if (value === "__add") {
					this.#showPrefix();
				} else if (value === "__test") {
					this.#showTest();
				} else if (value.startsWith("entry:") && !readOnly) {
					this.#showTarget(value.slice("entry:".length));
				}
				this.#requestRender?.();
			},
			onCancel: this.#onClose,
			requestRender: this.#requestRender,
		});
		this.addChild(this.#listField);
	}

	#showText(field: TextFormField, afterInput?: () => void): void {
		this.clear();
		this.#listField = undefined;
		this.#afterInput = afterInput;
		this.addChild(field);
	}

	#backToList(note?: string): void {
		this.#showList(note);
		this.#requestRender?.();
	}

	#showTarget(key: string): void {
		const initialValue = this.#entries()[key] ?? "";
		const sample = new Text(formTheme.hint(sampleLine(key, initialValue)), 0, 0);
		const field = new TextFormField({
			theme: formTheme,
			label: sanitizeDisplayLine(`Link target: ${key}`),
			description:
				"A URI prefix such as file:///Z:/, https://files.contoso.example/ or vscode://vscode-remote/ssh-remote+devbox/. Clear the field to remove this entry.",
			initialValue,
			empty: "submit",
			summary: [sample],
			hint: `  ${editorKey("tui.input.submit")} to save · ${editorKey("tui.select.cancel")} to cancel · Clear field to remove`,
			validate: value =>
				acceptableTarget(value)
					? undefined
					: "Use a URI with a scheme and no query or fragment, such as file:///Z:/",
			onSubmit: value => {
				const next = this.#entries();
				const trimmed = value.trim();
				if (trimmed === "") delete next[key];
				else next[key] = trimmed;
				this.#save(next);
				this.#backToList(trimmed === "" ? `Removed ${key}.` : `Saved ${key} → ${trimmed}`);
			},
			onCancel: () => this.#backToList(),
			requestRender: this.#requestRender,
		});
		this.#showText(field, () => {
			const value = field.getValue();
			sample.setText(formTheme.hint(sampleLine(key, value)));
			// A refused save's error clears once the target is fixed.
			if (field.hasError && acceptableTarget(value)) field.setError(undefined);
		});
	}

	#showPrefix(): void {
		this.#showText(
			new TextFormField({
				theme: formTheme,
				label: "Path prefix",
				description: "An absolute path, ~ or ~/... for your home; <user> stands for your login name.",
				hint: `  ${editorKey("tui.input.submit")} to continue · ${editorKey("tui.select.cancel")} to cancel`,
				validate: value =>
					isLinkMapKey(value.trim())
						? undefined
						: "Start with / or ~ and use no . or .. segment, for example /mnt/projects or ~/src",
				onSubmit: value => {
					this.#showTarget(value.trim());
					this.#requestRender?.();
				},
				onCancel: () => this.#backToList(),
				requestRender: this.#requestRender,
			}),
		);
	}

	#showTest(): void {
		this.#showText(
			new TextFormField({
				theme: formTheme,
				label: "Test a path",
				description: "An absolute or ~/ path, checked against the map links use now, on this terminal.",
				hint: `  ${editorKey("tui.input.submit")} to test · ${editorKey("tui.select.cancel")} to cancel`,
				onSubmit: value => {
					const target = expandTilde(value.trim());
					if (!target.startsWith("/")) {
						this.#backToList("Enter an absolute or ~/ path.");
						return;
					}
					let match: { key: string; uri: string } | undefined;
					try {
						match = matchLinkEntry(target);
					} catch {
						match = undefined;
					}
					const uri = fileUriForTerminal(target, undefined, TERMINAL.id) ?? "no link";
					this.#backToList(`${target} → ${match ? `entry ${match.key}` : "no entry"} → ${uri}`);
				},
				onCancel: () => this.#backToList(),
				requestRender: this.#requestRender,
			}),
		);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#listField?.routeMouse(event, line, col);
	}

	handleInput(data: string): void {
		if (this.#listField) {
			this.#listField.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
		this.#afterInput?.();
	}
}
