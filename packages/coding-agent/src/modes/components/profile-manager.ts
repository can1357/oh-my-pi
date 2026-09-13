/**
 * Profile Manager opened by `/profile` (bare): a bottom-anchored floating
 * overlay listing configured profiles plus "Off" and a "+ Create Profile"
 * action row. Enter activates the selected profile; E edits its roles;
 * D deletes it; N starts creation — all without leaving the TUI.
 *
 * Follows OMP overlay conventions: OverlayPanel chrome, SelectList
 * navigation with mouse routing, dim footer hint line, and child-rebuild on
 * state change (same pattern as the settings selector's multi-select).
 */
import {
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	Spacer,
	Text,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

const PROFILE_SELECTOR_MAX_VISIBLE = 12;

export interface ProfilePickerEntry {
	/** Profile name, or "off"/"+create" for action rows. */
	name: string;
	/** Description shown on the row (profile description or role count). */
	description?: string;
	/** Config layers defining this profile; empty for action rows. */
	definedIn: Array<"global" | "project" | "overlay">;
}

/** What the selected manager row means to the caller. */
export type ProfileManagerAction =
	| { kind: "select"; name: string }
	| { kind: "edit"; name: string; scope: "global" | "project" }
	| { kind: "delete"; name: string; scope: "global" | "project" }
	| { kind: "create" }
	| { kind: "cancel" };

const CREATE_ROW = "+create";
const OFF_ROW = "off";

function isActionRow(name: string): boolean {
	return name === CREATE_ROW || name === OFF_ROW;
}

/**
 * Floating profile manager. `onAction` receives the resolved intent for the
 * active row/key and is responsible for persisting changes and refreshing or
 * dismissing the overlay.
 */
export class ProfileManagerComponent extends OverlayPanel {
	#list!: SelectList; // created by #rebuild(), which the constructor always runs
	#entries: readonly ProfilePickerEntry[];
	#currentProfile: string;
	#onAction: (action: ProfileManagerAction) => void;

	constructor(
		entries: readonly ProfilePickerEntry[],
		currentProfile: string,
		onAction: (action: ProfileManagerAction) => void,
	) {
		super("Profiles");
		this.#entries = entries;
		this.#currentProfile = currentProfile;
		this.#onAction = onAction;
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		if (this.#promptForm) {
			this.addChild(this.#promptForm);
			return;
		}
		const profileEntries = this.#entries.filter(entry => !isActionRow(entry.name));
		const items: SelectItem[] = [];
		for (const entry of profileEntries) {
			const active = entry.name === this.#currentProfile;
			const scopeTag =
				entry.definedIn.length > 1
					? ` ${theme.fg("dim", `[${entry.definedIn.join("+")}]`)}`
					: entry.definedIn.length === 1 && entry.definedIn[0] !== "global"
						? ` ${theme.fg("dim", `[${entry.definedIn[0]}]`)}`
						: "";
			items.push({
				value: entry.name,
				label: `${active ? theme.fg("accent", "●") : " "} ${entry.name}${scopeTag}`,
				description: entry.description,
			});
		}
		items.push({
			value: CREATE_ROW,
			label: theme.fg("accent", "+ Create Profile"),
			description: "Define a new named model-role overlay",
		});
		const offActive = this.#currentProfile === "";
		items.push({
			value: OFF_ROW,
			label: `${offActive ? theme.fg("dim", "●") : " "} Off`,
			description: "Disable profiles — use base modelRoles",
		});

		this.#list = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), PROFILE_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
		);
		const preferredValue = this.#pendingSelection ?? (this.#currentProfile || OFF_ROW);
		this.#pendingSelection = undefined;
		const preferredIndex = Math.max(
			0,
			items.findIndex(item => item.value === preferredValue),
		);
		this.#list.setSelectedIndex(preferredIndex);
		this.#selectedValue = items[preferredIndex]?.value;
		this.#list.onSelect = item => this.#activate(item.value);
		this.#list.onSelectionChange = item => {
			this.#selectedValue = item.value;
		};
		this.#list.onCancel = () => this.#onAction({ kind: "cancel" });
		this.addChild(this.#list);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter select · E edit · D delete · N new · Esc close"), 0, 0));
	}

	#pendingSelection: string | undefined;
	#selectedValue: string | undefined;

	#selectedName(): string | undefined {
		return this.#selectedValue;
	}

	#activate(value: string): void {
		if (value === CREATE_ROW) {
			this.#onAction({ kind: "create" });
			return;
		}
		if (value === OFF_ROW) {
			this.#onAction({ kind: "select", name: "off" });
			return;
		}
		this.#onAction({ kind: "select", name: value });
	}
	/** Refresh rows after an external mutation (create/delete/edit/switch). */
	update(entries: readonly ProfilePickerEntry[], currentProfile: string): void {
		// Keep the cursor on the row the user was on when the list changes.
		this.#pendingSelection = this.#selectedValue;
		this.#entries = entries;
		this.#currentProfile = currentProfile;
		this.#rebuild();
	}

	#promptForm: ProfileFormPanel | undefined;

	/**
	 * Enter prompt mode: the form replaces the list as the interactive body
	 * (the host redirects focus). `closePrompt` restores the list view.
	 */
	showPrompt(form: ProfileFormPanel): void {
		this.#promptForm = form;
		this.#rebuild();
	}

	closePrompt(): void {
		this.#promptForm = undefined;
		this.#rebuild();
	}

	/** Move the cursor to a named profile row (used after creation). */
	selectProfile(name: string): void {
		this.#pendingSelection = name;
		this.#rebuild();
	}

	/**
	 * Scope a mutation should target for a row: the effective definition.
	 * Project wins over global when both define the same name (project has
	 * higher precedence), so the row the user sees is the one that is edited.
	 */
	#mutationScope(name: string): "global" | "project" {
		const entry = this.#entries.find(candidate => candidate.name === name);
		if (entry?.definedIn.includes("project")) return "project";
		return "global";
	}

	handleInput(keyData: string): void {
		if (this.#promptForm) {
			this.#promptForm.handleInput(keyData);
			return;
		}
		const selected = this.#selectedName();
		if (matchesKey(keyData, "e") && selected && !isActionRow(selected)) {
			this.#onAction({ kind: "edit", name: selected, scope: this.#mutationScope(selected) });
			return;
		}
		if (matchesKey(keyData, "d") && selected && !isActionRow(selected)) {
			this.#onAction({ kind: "delete", name: selected, scope: this.#mutationScope(selected) });
			return;
		}
		if (matchesKey(keyData, "n")) {
			this.#onAction({ kind: "create" });
			return;
		}
		this.#list.handleInput(keyData);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#list, event, line, col);
	}
}

/**
 * Minimal bordered body used for inline manager prompts (name entry,
 * role values). Carries an Esc-cancel hook so hosts can abort cleanly.
 */
export class ProfileFormPanel extends OverlayPanel {
	onCancel?: () => void;

	showError(message: string): void {
		this.addChild(new Text(theme.fg("error", truncateToWidth(message, 100)), 0, 0));
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			this.onCancel?.();
			return;
		}
		for (const child of this.children) {
			if (child instanceof Input) {
				child.handleInput(keyData);
				return;
			}
		}
	}
}
