/** Global link-map editor with live previews and read-only higher-layer entries. */
import { expandTilde } from "@oh-my-pi/pi-utils";
import { formTheme } from "../chrome/form-theme";
import { editorKey } from "../chrome/keybinding-hints";
import { SelectFormField, TextFormField } from "../components/form";
import { Text } from "../components/text";
import { Container, type SelectItem, type SgrMouseEvent } from "../index";
import { resolveFileLink } from "../render/hyperlink";
import { isLinkMapKey, linkMapPrefixes, matchLinkEntry, parseLinkMap, parseLinkTarget } from "../render/link-map";
import { TERMINAL } from "../terminal-capabilities";
import { getSelectListTheme } from "../theme/theme";
import { sanitizeDisplayLine } from "./extensions/display-text";
import type { SettingsHost } from "./settings-defs";

const LINK_MAP_PATH = "tui.linkMap";

function activeEntries(value: unknown): Record<string, string> {
	return Object.fromEntries(Object.entries(parseLinkMap(value, "read")).filter(([, target]) => target !== ""));
}

export function formatLinkMapValue(value: unknown): string {
	const keys = Object.keys(activeEntries(value)).sort((a, b) => a.localeCompare(b));
	if (keys.length === 0) return "None";
	return sanitizeDisplayLine(`${keys.length} ${keys.length === 1 ? "entry" : "entries"}: ${keys.join(", ")}`);
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
	#afterInput: (() => void) | undefined;
	readonly #settings: SettingsHost;
	readonly #onChange: (value: Record<string, string>) => void;
	readonly #onClose: () => void;
	readonly #requestRender: (() => void) | undefined;

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

	#cleanEntries(): Record<string, string> {
		return activeEntries(this.#settings.get(LINK_MAP_PATH));
	}

	#validateEntry(action: "open" | "add" | "save", key: string, value = ""): string | undefined {
		const entries = this.#cleanEntries();
		const layer = this.#settings.shadowingLayer(LINK_MAP_PATH, key);
		if (layer !== undefined) {
			return sanitizeDisplayLine(
				action === "open"
					? `${key} comes from the ${layer} and cannot be changed here.`
					: `The ${layer} sets ${key}, so an entry saved here would not take effect.`,
			);
		}
		const prefixes = linkMapPrefixes(key);
		for (const listed of Object.keys(entries)) {
			if (listed === key || !linkMapPrefixes(listed).some(prefix => prefixes.includes(prefix))) continue;
			const layer = this.#settings.shadowingLayer(LINK_MAP_PATH, listed);
			if (layer !== undefined) {
				return sanitizeDisplayLine(`The ${layer} sets ${listed}, so an entry saved here would not take effect.`);
			}
		}
		if (action === "open") return undefined;
		const trimmed = value.trim();
		if (action === "save") {
			if (trimmed === "") return undefined;
			if (isLinkMapKey(key) && prefixes.length === 0) return "This prefix cannot be expanded for the current login.";
		} else if (!isLinkMapKey(key)) {
			return "Start with / or ~, for example /mnt/projects or ~/src";
		}
		const prospective =
			action === "save" && Object.hasOwn(entries, key)
				? Object.fromEntries(
						Object.entries(entries).map(([listed, target]) => [listed, listed === key ? trimmed : target]),
					)
				: { ...entries, [key]: action === "add" ? "https://example.com/" : trimmed };
		try {
			parseLinkMap(prospective, "write");
			return undefined;
		} catch (err) {
			return sanitizeDisplayLine((err as Error).message);
		}
	}

	#showList(note?: string): void {
		this.clear();
		this.#afterInput = undefined;
		const entries = this.#cleanEntries();
		const keys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
		const layers = new Map<string, string>();
		const items: SelectItem[] = keys.map(key => {
			const layer = this.#settings.shadowingLayer(LINK_MAP_PATH, key);
			if (layer !== undefined) layers.set(key, layer);
			return {
				value: `entry:${key}`,
				label: sanitizeDisplayLine(key),
				description: sanitizeDisplayLine(`→ ${entries[key]}${layer === undefined ? "" : ` (${layer}, read-only)`}`),
			};
		});
		items.push(
			{ value: "__add", label: "Add entry…", description: "A path prefix and the URI prefix its links go to" },
			{ value: "__test", label: "Test a path…", description: "Show which entry a path matches and its link" },
		);
		if (layers.size < keys.length)
			items.push({
				value: "__clear_all",
				label: "Clear all entries",
				description: "Removes the global config's value; higher-layer entries stay",
			});
		this.#listField = new SelectFormField({
			theme: formTheme,
			label: "Link Map",
			description: sanitizeDisplayLine(
				note ??
					"Each entry sends file links under a path prefix to a URI prefix; the longest matching prefix wins.",
			),
			items,
			maxVisible: 12,
			selectTheme: getSelectListTheme(),
			hint: `  ${editorKey("tui.select.confirm")} to choose · ${editorKey("tui.select.cancel")} to close`,
			onSubmit: value => {
				if (value === "__clear_all") {
					this.#settings.unset(LINK_MAP_PATH);
					this.#onChange(this.#cleanEntries());
					const remaining = Object.keys(this.#cleanEntries()).length;
					this.#backToList(remaining > 0 ? "Cleared the global config's entries." : "Cleared every entry.");
				} else if (value === "__add") {
					this.#showPrefix();
				} else if (value === "__test") {
					this.#showTest();
				} else if (value.startsWith("entry:")) {
					const key = value.slice("entry:".length);
					const refusal = this.#validateEntry("open", key);
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
		const initialValue = this.#cleanEntries()[key] ?? "";
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
			validate: value => this.#validateEntry("save", key, value),
			onSubmit: value => {
				const trimmed = value.trim();
				this.#settings.setEntry(LINK_MAP_PATH, key, trimmed === "" ? undefined : trimmed);
				this.#onChange(this.#cleanEntries());
				this.#backToList(trimmed === "" ? `Removed ${key}.` : `Saved ${key} → ${trimmed}`);
			},
			onCancel: () => this.#backToList(),
			requestRender: this.#requestRender,
		});
		this.#showText(field, () => {
			const value = field.getValue();
			sample.setText(formTheme.hint(sampleLine(key, value)));
			if (field.hasError) field.setError(this.#validateEntry("save", key, value));
		});
	}

	#showPrefix(): void {
		this.#showText(
			new TextFormField({
				theme: formTheme,
				label: "Path prefix",
				description: "An absolute path, ~ or ~/... for your home; {user} stands for your login name.",
				hint: `  ${editorKey("tui.input.submit")} to continue · ${editorKey("tui.select.cancel")} to cancel`,
				validate: value => this.#validateEntry("add", value.trim()),
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
		if (data !== "\r" && data !== "\n") this.#afterInput?.();
	}
}
