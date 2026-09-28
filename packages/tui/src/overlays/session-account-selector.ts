import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;

/** Stored account identity rendered and matched by the session account picker. */
export interface SessionPinAccount {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
	active: boolean;
	label: string;
}

/** Account picker opened by `/session pin` for the current model provider. */
export class SessionAccountSelectorComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		providerName: string,
		accounts: readonly SessionPinAccount[],
		onSelect: (account: SessionPinAccount) => void,
		onCancel: () => void,
	) {
		super(`Select a ${providerName} account for this session`);
		const accountsByValue = new Map<string, SessionPinAccount>();
		const items: SelectItem[] = accounts.map(account => {
			const value = String(account.credentialId);
			accountsByValue.set(value, account);
			return {
				value,
				label: account.label,
				description: account.active ? "active for this session" : undefined,
			};
		});

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), ACCOUNT_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
		);
		const activeIndex = accounts.findIndex(account => account.active);
		if (activeIndex >= 0) this.#selectList.setSelectedIndex(activeIndex);
		this.#selectList.onSelect = item => {
			const account = accountsByValue.get(item.value);
			if (account) onSelect(account);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
	}

	/** Forward keyboard navigation and cancellation when the wrapper owns focus. */
	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	/** Route mouse selection through the title rows into the account list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
