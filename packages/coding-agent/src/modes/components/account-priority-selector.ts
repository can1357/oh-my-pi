import { type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import type { SessionPinAccount } from "../../slash-commands/helpers/session-pin";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;

/** Account priority picker opened by `/account priority`. Selecting moves account to top priority. */
export class AccountPrioritySelectorComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		providerName: string,
		accounts: readonly SessionPinAccount[],
		onSelect: (account: SessionPinAccount) => void,
		onCancel: () => void,
	) {
		super(`Select top priority ${providerName} account (Enter moves to #1)`);
		const accountsByValue = new Map<string, SessionPinAccount>();
		const items: SelectItem[] = accounts.map(account => {
			const value = String(account.credentialId);
			accountsByValue.set(value, account);
			const priorityDesc = account.priority !== undefined ? `Priority ${account.priority}` : "unprioritized";
			const activeDesc = account.active ? " (active)" : "";
			return {
				value,
				label: account.label,
				description: `${priorityDesc}${activeDesc}`,
			};
		});

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), ACCOUNT_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
		);
		this.#selectList.onSelect = item => {
			const account = accountsByValue.get(item.value);
			if (account) onSelect(account);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
	}

	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
