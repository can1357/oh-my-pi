import { Container, matchesKey, ScrollView, TruncatedText } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { centeredViewportRange } from "../components/scroll-viewport";

const LOGOUT_SELECTOR_MAX_VISIBLE = 10;

export interface LogoutAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

/** Account picker for `/logout` after the provider has been selected. */
export class LogoutAccountSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	#menu: MenuSelection<LogoutAccount>;
	#onSelectCallback: (account: LogoutAccount) => void;
	#onCancelCallback: () => void;

	constructor(
		providerName: string,
		accounts: LogoutAccount[],
		onSelect: (account: LogoutAccount) => void,
		onCancel: () => void,
	) {
		super(`Select ${providerName} account to log out`);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		const active = accounts.find(account => account.active);
		this.#menu = new MenuSelection<LogoutAccount>(
			accounts,
			{
				getKey: account => String(account.credentialId),
				getSearchText: account => `${account.label} ${account.detail} ${account.provider}`,
			},
			active ? String(active.credentialId) : undefined,
		);

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();

		const items = this.#menu.visibleItems;
		const total = items.length;
		const maxVisible = LOGOUT_SELECTOR_MAX_VISIBLE;
		const { start: startIndex, end: endIndex } = centeredViewportRange(this.#menu.selectedIndex, total, maxVisible);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = items[i];
			if (!account) continue;
			const activeTag = account.active ? theme.fg("muted", " (active)") : "";
			const detail = account.detail ? theme.fg("dim", `  ${account.detail}`) : "";
			if (i === this.#menu.selectedIndex) {
				rows.push(`${theme.fg("accent", `${theme.nav.cursor} ${account.label}`)}${activeTag}${detail}`);
			} else {
				rows.push(`  ${account.label}${activeTag}${detail}`);
			}
		}

		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		}

		if (total === 0) {
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", "No stored accounts to log out"), 0, 0));
		}

		this.#listContainer.addChild(
			new TruncatedText(theme.fg("muted", "↑/↓ select · ↵ log out account · Esc cancel"), 0, 0),
		);
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (matchesSelectUp(keyData)) {
			this.#menu.move(-1, true);
			this.#updateList();
		} else if (matchesSelectDown(keyData)) {
			this.#menu.move(1, true);
			this.#updateList();
		} else if (matchesKey(keyData, "pageUp")) {
			this.#menu.move(-LOGOUT_SELECTOR_MAX_VISIBLE, false);
			this.#updateList();
		} else if (matchesKey(keyData, "pageDown")) {
			this.#menu.move(LOGOUT_SELECTOR_MAX_VISIBLE, false);
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const account = this.#menu.selectedItem;
			if (!account) return;
			this.#onSelectCallback(account);
		}
	}
}
