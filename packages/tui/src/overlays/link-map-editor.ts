/**
 * `/settings` editor for `tui.linkMap`: the entries, sorted by prefix, then Add entry…, Test a path… and Clear
 * all entries. The target form shows the link a sample path under the prefix gets as the target is typed.
 * Saving an entry stays in the editor; Escape from the list closes it.
 *
 * The editor writes the global config only, one entry at a time. An entry a higher layer supplies (a `--config`
 * file, a runtime override) is listed with that layer's name and can be neither opened nor added again: a value
 * saved for it would not reach links.
 */
import { expandTilde } from "@oh-my-pi/pi-utils";
import { formTheme } from "../chrome/form-theme";
import { editorKey } from "../chrome/keybinding-hints";
import { SelectFormField, TextFormField } from "../components/form";
import { Text } from "../components/text";
import { Container, type SelectItem, type SgrMouseEvent } from "../index";
import { resolveFileLink } from "../render/hyperlink";
import { isLinkMapKey, linkMapPrefixes, matchLinkEntry, parseLinkTarget } from "../render/link-map";
import { TERMINAL } from "../terminal-capabilities";
import { getSelectListTheme } from "../theme/theme";
import { sanitizeDisplayLine } from "./extensions/display-text";
import type { SettingsHost } from "./settings-defs";

const LINK_MAP_PATH = "tui.linkMap";

function sharesLinkMapPrefix(a: string, b: string): boolean {
	const prefixes = linkMapPrefixes(a);
	return linkMapPrefixes(b).some(prefix => prefixes.includes(prefix));
}

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

	/**
	 * Why an entry for `key` cannot be saved, if so: a layer above the global config supplies that entry, under
	 * this key or another one that stands for the same prefix, so the saved one would not reach links. Asked again
	 * at each save, since a layer can change while a form is open.
	 */
	#refusal(key: string): string | undefined {
		const layerOf = (set: string): string | undefined => this.#settings.shadowingLayer(LINK_MAP_PATH, set);
		const same = Object.keys(this.#entries()).filter(listed => sharesLinkMapPrefix(key, listed));
		const set = [key, ...same].find(layerOf);
		return set === undefined
			? undefined
			: sanitizeDisplayLine(`The ${layerOf(set)} sets ${set}, so an entry saved here would not take effect.`);
	}

	/** Why `key` cannot be added, if so: a listed entry already stands for the same prefix, and links use only the first. */
	#duplicate(key: string): string | undefined {
		const same = Object.keys(this.#entries()).find(listed => sharesLinkMapPrefix(key, listed));
		return same ? sanitizeDisplayLine(`${same} is already the entry for that prefix.`) : undefined;
	}

	/** Saves one entry to the global config (`undefined` removes it) and reports the map as it now reads. */
	#saveEntry(key: string, target: string | undefined): void {
		this.#settings.setEntry(LINK_MAP_PATH, key, target);
		this.#onChange(this.#entries());
	}

	#showList(note?: string): void {
		this.clear();
		this.#afterInput = undefined;
		const entries = this.#entries();
		const keys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
		// Entries a layer above the global config supplies, by that layer's name.
		const layers = new Map<string, string>();
		for (const key of keys) {
			const layer = this.#settings.shadowingLayer(LINK_MAP_PATH, key);
			if (layer !== undefined) layers.set(key, layer);
		}
		// The key links use for each prefix: the first valid one in the map's own order, the order entries load in.
		const owner = new Map<string, string>();
		const sameAs = new Map<string, string>();
		for (const key of Object.keys(entries)) {
			if (parseLinkTarget(entries[key]) === undefined) continue;
			const prefixes = linkMapPrefixes(key);
			const first = prefixes.find(prefix => owner.has(prefix));
			if (first !== undefined) {
				const earlier = owner.get(first);
				if (earlier !== undefined) sameAs.set(key, earlier);
			} else {
				for (const prefix of prefixes) owner.set(prefix, key);
			}
		}
		const items: SelectItem[] = keys.map(key => {
			const valid = isLinkMapKey(key) && parseLinkTarget(entries[key]) !== undefined;
			const layer = layers.get(key);
			return {
				value: `entry:${key}`,
				label: sanitizeDisplayLine(key),
				description: sanitizeDisplayLine(
					`→ ${entries[key]}${valid ? "" : " (ignored: not a valid entry)"}${sameAs.has(key) ? ` (ignored: same prefix as ${sameAs.get(key)})` : ""}${layer === undefined ? "" : ` (${layer}, read-only)`}`,
				),
			};
		});
		items.push(
			{
				value: "__add",
				label: "Add entry…",
				description: "A path prefix and the URI prefix its links go to",
			},
			{
				value: "__test",
				label: "Test a path…",
				description: "Show which entry a path matches and its link",
			},
		);
		// Clearing removes the global config's map, so it is offered only when that would change an entry shown.
		if (layers.size < keys.length) {
			items.push({
				value: "__clear_all",
				label: "Clear all entries",
				description:
					layers.size > 0
						? "Removes the entries of the global config; read-only entries stay"
						: "Links fall back to PI_LINK_SCHEME or plain file links",
			});
		}
		this.#listField = new SelectFormField({
			theme: formTheme,
			label: "Link Map",
			description:
				note !== undefined
					? sanitizeDisplayLine(note)
					: "Each entry sends file links under a path prefix to a URI prefix; the longest matching prefix wins.",
			items,
			maxVisible: 12,
			selectTheme: getSelectListTheme(),
			hint: `  ${editorKey("tui.select.confirm")} to choose · ${editorKey("tui.select.cancel")} to close`,
			onSubmit: value => {
				if (value === "__clear_all") {
					this.#settings.unset(LINK_MAP_PATH);
					this.#onChange(this.#entries());
					this.#backToList(layers.size > 0 ? "Cleared the global config's entries." : "Cleared every entry.");
				} else if (value === "__add") {
					this.#showPrefix();
				} else if (value === "__test") {
					this.#showTest();
				} else if (value.startsWith("entry:")) {
					const key = value.slice("entry:".length);
					const layer = layers.get(key);
					const refusal =
						layer === undefined
							? this.#refusal(key)
							: `${key} comes from the ${layer} and cannot be changed here.`;
					if (refusal === undefined) this.#showTarget(key);
					else this.#backToList(refusal);
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
					? this.#refusal(key)
					: "Use a URI with a scheme and no query or fragment, such as file:///Z:/",
			onSubmit: value => {
				const trimmed = value.trim();
				this.#saveEntry(key, trimmed === "" ? undefined : trimmed);
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
				description: "An absolute path, ~ or ~/... for your home; {user} stands for your login name.",
				hint: `  ${editorKey("tui.input.submit")} to continue · ${editorKey("tui.select.cancel")} to cancel`,
				validate: value =>
					isLinkMapKey(value.trim())
						? (this.#refusal(value.trim()) ?? this.#duplicate(value.trim()))
						: "Start with / or ~, for example /mnt/projects or ~/src",
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
					const kind = target.endsWith("/") ? "dir" : "unknown";
					const uri = resolveFileLink({ path: target, kind }, TERMINAL.id) ?? "no link";
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
