import type { UsageResetCreditDetail } from "@oh-my-pi/pi-ai";
import { Container, matchesKey, ScrollView, Spacer, Text, TruncatedText } from "../index";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { centeredViewportRange } from "../components/scroll-viewport";
import { formatUsageResetWindow } from "./usage-display";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";

const RESET_SELECTOR_MAX_VISIBLE = 10;

/** One account row with its redeemable rate-limit reset credits. */
export interface ResetUsageAccount {
	label: string;
	provider: string;
	providerLabel: string;
	/** Banked resets, including grants that cannot be spent right now. */
	availableCount: number;
	/** Resets the provider currently permits this account to spend. */
	redeemableCount: number;
	target: {
		credentialId: number;
		provider: string;
		creditId?: string;
		accountId?: string;
		email?: string;
		orgId?: string;
	};
	active: boolean;
	error?: string;
	unavailableReason?: string;
	expiresAt?: string;
	credit?: UsageResetCreditDetail;
}

/**
 * Account picker for `/usage reset`. Lists provider accounts with their saved
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
		const firstRedeemable = accounts.find(account => account.redeemableCount > 0);
		const accountKey = (account: ResetUsageAccount) =>
			`${account.provider}:${account.target.credentialId}:${account.target.creditId ?? ""}`;
		this.#menu = new MenuSelection<ResetUsageAccount>(
			accounts,
			{
				getKey: accountKey,
				getSearchText: account => `${account.label} ${account.providerLabel}`,
				requiresConfirmation: account => account.redeemableCount > 0,
			},
			firstRedeemable ? accountKey(firstRedeemable) : undefined,
		);

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();
		const oneLine = (value: string): string => sanitizeText(value.replace(/[\r\n\t]+/g, " "));

		const items = this.#menu.visibleItems;
		const total = items.length;
		const maxVisible = RESET_SELECTOR_MAX_VISIBLE;
		const { start: startIndex, end: endIndex } = centeredViewportRange(this.#menu.selectedIndex, total, maxVisible);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = items[i];
			if (!account) continue;
			const isSelected = i === this.#menu.selectedIndex;
			const redeemable = account.redeemableCount > 0;
			let countLabel: string;
			if (account.error) {
				countLabel = oneLine(account.error);
			} else {
				countLabel = `${account.availableCount} saved reset${account.availableCount === 1 ? "" : "s"}`;
				if (account.redeemableCount !== account.availableCount) {
					countLabel += ` · ${account.redeemableCount} usable now`;
				}
				if (account.expiresAt) {
					const expiryMs = Date.parse(account.expiresAt);
					if (!Number.isNaN(expiryMs)) {
						countLabel +=
							expiryMs > Date.now() ? ` · expires in ${formatDuration(expiryMs - Date.now())}` : " · expired";
					}
				}
				if (!redeemable && account.unavailableReason) {
					countLabel += ` · ${oneLine(account.unavailableReason)}`;
				}
			}
			const countText = account.error
				? theme.fg("error", countLabel)
				: redeemable
					? theme.fg("success", countLabel)
					: theme.fg("dim", countLabel);
			const activeTag = account.active ? theme.fg("muted", " (active)") : "";
			const safeLabel = oneLine(account.label);
			const providerTag = theme.fg(
				"muted",
				`[${oneLine(account.providerLabel)} · #${account.target.credentialId}] `,
			);
			if (isSelected) {
				const name = redeemable ? theme.fg("accent", safeLabel) : theme.fg("dim", safeLabel);
				rows.push(`${theme.fg("accent", `${theme.nav.cursor} `)}${providerTag}${name}${activeTag}  ${countText}`);
			} else {
				const name = redeemable ? safeLabel : theme.fg("dim", safeLabel);
				rows.push(`  ${providerTag}${name}${activeTag}  ${countText}`);
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
				new TruncatedText(theme.fg("muted", "No provider accounts with saved resets"), 0, 0),
			);
		}

		const pending = items.find(item => this.#menu.isPending(item));
		const hint = pending
			? theme.fg("warning", oneLine(this.#confirmationMessage(pending)))
			: theme.fg(
					"muted",
					`${editorKeys("tui.select.up", "tui.select.down")} select · ${formatKeyHint("enter")} spend a reset · ${editorKey("tui.select.cancel")} cancel`,
				);
		this.#listContainer.addChild(new Text(hint, 0, 0));

		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new Text(theme.fg("warning", oneLine(this.#statusMessage)), 0, 0));
		}
	}

	#confirmationMessage(account: ResetUsageAccount): string {
		const subject = account.credit?.title ? `“${account.credit.title}”` : "1 saved reset";
		const messages = [
			`Press ${formatKeyHint("enter")} again to spend ${subject} for ${account.label} (${account.providerLabel}).`,
		];
		if (account.credit?.program === "juniper_tide") {
			messages.push("This resets Claude's 5h session limit only; weekly limits stay unchanged.");
		} else if (account.credit?.clears?.length) {
			messages.push(`Covers ${account.credit.clears.map(formatUsageResetWindow).join(", ")}.`);
		}
		if (account.credit?.requiresLimit === false) {
			messages.push("Optional early use: this can be spent before the covered limit is reached.");
		}
		messages.push(`${editorKey("tui.select.cancel")} cancels.`);
		return messages.join(" ");
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
			if (account.redeemableCount <= 0) {
				this.#statusMessage = account.unavailableReason
					? `That account's saved resets are unavailable: ${account.unavailableReason}`
					: "That account has no saved resets usable right now.";
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
