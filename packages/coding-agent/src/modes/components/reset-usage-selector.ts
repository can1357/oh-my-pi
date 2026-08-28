import { Container, matchesKey, ScrollView, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { ResetUsageAccount } from "../../slash-commands/helpers/reset-usage";
import { OverlayPanel } from "./overlay-box";

const RESET_SELECTOR_MAX_VISIBLE = 10;

/**
 * Account picker for `/usage reset`. Lists Codex accounts with their saved
 * rate-limit reset counts; selecting one redeems a reset. Because a reset is a
 * scarce, irreversible credit, Enter requires a second press to confirm.
 */
export class ResetUsageSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	#accounts: ResetUsageAccount[];
	#selectedIndex = 0;
	#pendingIndex: number | null = null;
	#statusMessage: string | undefined;
	#onSelectCallback: (account: ResetUsageAccount) => void;
	#onCancelCallback: () => void;

	constructor(accounts: ResetUsageAccount[], onSelect: (account: ResetUsageAccount) => void, onCancel: () => void) {
		super("Spend a saved rate-limit reset");
		this.#accounts = accounts;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		const firstRedeemable = accounts.findIndex(account => account.availableCount > 0);
		this.#selectedIndex = firstRedeemable >= 0 ? firstRedeemable : 0;

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();

		const total = this.#accounts.length;
		const maxVisible = RESET_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible
				? 0
				: Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, total);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = this.#accounts[i];
			if (!account) continue;
			const isSelected = i === this.#selectedIndex;
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

		const pending = this.#pendingIndex !== null ? this.#accounts[this.#pendingIndex] : undefined;
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
			if (this.#pendingIndex !== null) {
				this.#pendingIndex = null;
				this.#statusMessage = undefined;
				this.#updateList();
				return;
			}
			this.#onCancelCallback();
			return;
		}

		if (matchesSelectUp(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === 0 ? this.#accounts.length - 1 : this.#selectedIndex - 1;
			}
			this.#pendingIndex = null;
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesSelectDown(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === this.#accounts.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#pendingIndex = null;
			this.#statusMessage = undefined;
			this.#updateList();
		} else if (matchesKey(keyData, "pageUp")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - RESET_SELECTOR_MAX_VISIBLE);
			}
			this.#pendingIndex = null;
			this.#updateList();
		} else if (matchesKey(keyData, "pageDown")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.min(this.#accounts.length - 1, this.#selectedIndex + RESET_SELECTOR_MAX_VISIBLE);
			}
			this.#pendingIndex = null;
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const account = this.#accounts[this.#selectedIndex];
			if (!account) return;
			if (account.availableCount <= 0) {
				this.#statusMessage = "That account has no saved resets to spend.";
				this.#updateList();
				return;
			}
			if (this.#pendingIndex === this.#selectedIndex) {
				this.#onSelectCallback(account);
				return;
			}
			this.#pendingIndex = this.#selectedIndex;
			this.#statusMessage = undefined;
			this.#updateList();
		}
	}
}
