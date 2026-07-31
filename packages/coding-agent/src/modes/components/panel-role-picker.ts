import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import type { PanelRole } from "../../panel/types";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/** Keep the picker compact; type-to-filter covers larger role sets. */
const MAX_VISIBLE_ROLES = 10;

export interface PanelRolePickerOptions {
	/** Saved panel roles keyed by role id, in configured order. */
	roles: Readonly<Record<string, PanelRole>>;
	/** Role id preselected and marked as the default, when configured. */
	defaultRole?: string;
	onSelect: (roleId: string) => void;
	onCancel: () => void;
}

/**
 * Editor-swap picker for saved panel roles. Renders the configured roles in
 * their stored order, marks the default role, and preselects it.
 */
export class PanelRolePickerComponent extends Container {
	#selectList: SelectList;

	constructor(options: PanelRolePickerOptions) {
		super();

		const { roles, defaultRole, onSelect, onCancel } = options;
		const items: SelectItem[] = Object.entries(roles).map(([roleId, role]) => {
			// One-line role summary: strategy, member count, and the member models.
			const models = role.members.map(member => member.model).join(", ");
			const count = `${role.members.length} member${role.members.length === 1 ? "" : "s"}`;
			const isDefault = roleId === defaultRole;
			const summary = `${role.strategy} · ${count} · ${models}`;
			return {
				value: roleId,
				label: isDefault ? `${roleId} ✓` : roleId,
				description: isDefault ? `default · ${summary}` : summary,
			};
		});

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(items, Math.min(items.length, MAX_VISIBLE_ROLES), getSelectListTheme());

		// Preselect the default role
		const defaultIndex = items.findIndex(item => item.value === defaultRole);
		if (defaultIndex !== -1) {
			this.#selectList.setSelectedIndex(defaultIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
