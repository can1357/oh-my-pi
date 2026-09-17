import { type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Minimal agent persona picker for bare `/agent` (no persona active): lists
 * discovered agent definitions and hands the selection back to the host, which
 * routes it through `switchAgentPersona` / the session's PersonaRuntime.
 * UI polish (descriptions, previews) comes later — this mirrors the
 * SelectList-based selectors like QueueModeSelectorComponent.
 */
export class AgentPersonaPickerComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		agents: Array<{ name: string; description: string }>,
		onSelect: (agentName: string) => void,
		onCancel: () => void,
	) {
		super("Agent Persona");

		const items: SelectItem[] = agents.map(agent => ({
			value: agent.name,
			label: agent.name,
			description: agent.description,
		}));

		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		this.#selectList.onSelect = item => {
			onSelect(item.value as string);
		};
		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
