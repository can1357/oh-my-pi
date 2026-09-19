import { Container, matchesKey, ScrollView, Spacer, TruncatedText } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { centeredViewportRange } from "../components/scroll-viewport";

const RESET_SELECTOR_MAX_VISIBLE = 10;

/** One account row with its redeemable rate-limit reset credits. */
export interface ResetUsageAccount {
	label: string;
	availableCount: number;
	target: {
		credentialId?: number;
		accountId?: string;
		email?: string;
	};
	active: boolean;
	error?: string;
}

/**
 * Account picker for `/usage reset`. Lists Codex accounts with their saved
 * rate-limit reset counts; selecting one redeems a reset. Because a reset is a
 * scarce, irreversible credit, Enter requires a second press to confirm.
 */
export class ResetUsageSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	#menu: MenuSelection<ResetUsageAccount>;
	#statusMessage: string | undefined;
	#onSelectCallback: (account: ResetUsageAccount) => void;
	#onCancelCallback: () => void;

	constructor(accounts: ResetUsageAccount[], onSelect: (account: ResetUsageAccount) => void, onCancel: () => void) {
		super("Spend a saved rate-limit reset");
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		const firstRedeemable = accounts.find(account => account.availableCount > 0);
		this.#menu = new MenuSelection<ResetUsageAccount>(
			accounts,
			{
				getKey: account =>
					`${account.target.credentialId ?? ""}:${account.target.accountId ?? ""}:${account.target.email ?? ""}:${account.label}`,
				getSearchText: account => account.label,
				requiresConfirmation: account => account.availableCount > 0,
			},
			firstRedeemable
				? `${firstRedeemable.target.credentialId ?? ""}:${firstRedeemable.target.accountId ?? ""}:${firstRedeemable.target.email ?? ""}:${firstRedeemable.label}`
				: undefined,
		);

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();

		const items = this.#menu.visibleItems;
		const total = items.length;
		const maxVisible = RESET_SELECTOR_MAX_VISIBLE;
		const { start: startIndex, end: endIndex } = centeredViewportRange(this.#menu.selectedIndex, total, maxVisible);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = items[i];
			if (!account) continue;
			const isSelected = i === this.#menu.selectedIndex;
			const redeemable = account.availableCount > 0;
			const countLabel = account.error
				? account.error
				: `${account.availableCount} saved reset${account.availableCount === 1 ? "" : "s"}`;
			const countText = account.error
				? theme.fg("error", countLabel)
				: redeemable
					? theme.fg("success", countLabel)
					: theme.fg("dim", countLabel);
			const activeTag = account.active ? theme.fg("muted", " (active)") : "";
			if (isSelected) {
				const name = redeemable ? theme.fg("accent", account.label) : theme.fg("dim", account.label);
				rows.push(`${theme.fg("accent", `${theme.nav.cursor} `)}${name}${activeTag}  ${countText}`);
			} else {
				const name = redeemable ? `  ${account.label}` : theme.fg("dim", `  ${account.label}`);
				rows.push(`${name}${activeTag}  ${countText}`);
			}
		}

		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		}

		if (total === 0) {
			this.#listContainer.addChild(
				new TruncatedText(theme.fg("muted", "No Codex accounts with saved resets"), 0, 0),
			);
		}

		const pending = items.find(item => this.#menu.isPending(item));
		const hint = pending
			? theme.fg("warning", `Press Enter again to spend 1 reset for ${pending.label}, Esc to cancel`)
			: theme.fg("muted", "↑/↓ select · ↵ spend a reset · Esc cancel");
		this.#listContainer.addChild(new TruncatedText(hint, 0, 0));

		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", this.#statusMessage), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			if (this.#menu.cancelConfirmation()) {
				this.#statusMessage = undefined;
				this.#updateList();
				return;
			}
			this.#onCancelCallback();
			return;
		}

		if (matchesSelectUp(keyData)) {
			this.#menu.cancelConfirmation();
			this.#menu.move(-1, true);
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesSelectDown(keyData)) {
			this.#menu.cancelConfirmation();
			this.#menu.move(1, true);
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesKey(keyData, "pageUp")) {
			this.#menu.cancelConfirmation();
			this.#menu.move(-RESET_SELECTOR_MAX_VISIBLE, false);
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesKey(keyData, "pageDown")) {
			this.#menu.cancelConfirmation();
			this.#menu.move(RESET_SELECTOR_MAX_VISIBLE, false);
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const account = this.#menu.selectedItem;
			if (!account) return;
			if (account.availableCount <= 0) {
				this.#statusMessage = "That account has no saved resets to spend.";
				this.#updateList();
				return;
			}
			const result = this.#menu.requestActivation();
			if (result.kind === "pending") {
				this.#statusMessage = undefined;
				this.#updateList();
				return;
			}
			if (result.kind === "confirmed") {
				this.#onSelectCallback(result.item);
				return;
			}
		}
	}
}
