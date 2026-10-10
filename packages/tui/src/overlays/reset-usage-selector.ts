import type { UsageResetCredit, UsageResetCreditDetail } from "@oh-my-pi/pi-ai";
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
import { node, span, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";

const RESET_SELECTOR_MAX_VISIBLE = 10;

const oneLine = (value: string): string => sanitizeText(value.replace(/[\r\n\t]+/g, " "));

function formatCreditExpiry(expiresAt: string | undefined, absolute = false): string | undefined {
	const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
	if (!Number.isFinite(expiryMs)) return undefined;
	const remainingMs = expiryMs - Date.now();
	const relative = remainingMs > 0 ? `expires in ${formatDuration(remainingMs)}` : "expired";
	if (!absolute) return relative;
	const date = new Date(expiryMs);
	return `${relative} (${date.toLocaleDateString()} ${date.toLocaleTimeString()})`;
}

/** Reset count, usability, expiry and unavailability of an account row, or its error. */
function accountCountLabel(account: ResetUsageAccount): string {
	if (account.error) return oneLine(account.error);
	let countLabel = `${account.availableCount} saved reset${account.availableCount === 1 ? "" : "s"}`;
	if (account.redeemableCount !== account.availableCount) {
		countLabel += ` · ${account.redeemableCount} usable now`;
	}
	if (account.provider === "openai-codex" && account.credit && account.credits?.length) {
		const index = account.credits.findIndex(credit => credit.id === account.target.creditId);
		if (index >= 0) countLabel += ` · selected ${index + 1}/${account.credits.length}`;
	}
	const expiry = formatCreditExpiry(account.expiresAt);
	if (expiry) countLabel += ` · ${expiry}`;
	if (account.redeemableCount <= 0 && account.unavailableReason) {
		countLabel += ` · ${oneLine(account.unavailableReason)}`;
	}
	return countLabel;
}

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
	/** Codex's usable credits in expiry order; target, credit and expiresAt already match the selected credit. */
	credits?: readonly UsageResetCredit[];
}

function canCycleCredits(
	account: ResetUsageAccount | undefined,
): account is ResetUsageAccount & { credits: readonly UsageResetCredit[] } {
	return account?.provider === "openai-codex" && account.redeemableCount > 0 && (account.credits?.length ?? 0) > 1;
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
	#nativeItems: readonly NativeNode[] | undefined;
	#nativeHints: NativeNode | undefined;
	#nativeRoot: NativeNode | undefined;

	constructor(accounts: ResetUsageAccount[], onSelect: (account: ResetUsageAccount) => void, onCancel: () => void) {
		super("Spend a saved rate-limit reset", "omp.overlay.reset-usage");
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		// Own the selection state: never mutate the caller's account rows or targets.
		accounts = accounts.map(account => ({
			...account,
			target: { ...account.target },
			...(account.credits ? { credits: [...account.credits] } : {}),
		}));
		const firstRedeemable = accounts.find(account => account.redeemableCount > 0);
		const accountKey = (account: ResetUsageAccount) => `${account.provider}:${account.target.credentialId}`;
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
		this.#nativeRoot = undefined;
		this.#nativeItems = undefined;
		this.#nativeHints = undefined;
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
			const redeemable = account.redeemableCount > 0;
			const countLabel = accountCountLabel(account);
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

		const creditDetails = this.#selectedCreditDetails(this.#menu.selectedItem);
		if (creditDetails) this.#listContainer.addChild(new Text(theme.fg("muted", creditDetails), 0, 0));

		const pending = items.find(item => this.#menu.isPending(item));
		const cycleHint = canCycleCredits(this.#menu.selectedItem)
			? `${formatKeyHint("tab")}/${formatKeyHint("shift+tab")} Codex reset · `
			: "";
		const hint = pending
			? theme.fg("warning", oneLine(this.#confirmationMessage(pending)))
			: theme.fg(
					"muted",
					`${editorKeys("tui.select.up", "tui.select.down")} select · ${cycleHint}${formatKeyHint("enter")} spend a reset · ${editorKey("tui.select.cancel")} cancel`,
				);
		this.#listContainer.addChild(new Text(hint, 0, 0));

		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new Text(theme.fg("warning", oneLine(this.#statusMessage)), 0, 0));
		}
	}

	#selectedCreditDetails(account: ResetUsageAccount | undefined): string | undefined {
		if (account?.provider !== "openai-codex" || !account.credit || !account.credits?.length) return undefined;
		const index = account.credits.findIndex(credit => credit.id === account.target.creditId);
		const details = [`Reset ${index + 1}/${account.credits.length}`];
		if (account.credit.title) details.push(`“${oneLine(account.credit.title)}”`);
		details.push(formatCreditExpiry(account.credit.expiresAt, true) ?? "expiry unknown");
		return details.join(" · ");
	}

	#cycleCredit(direction: -1 | 1): void {
		const account = this.#menu.selectedItem;
		if (!canCycleCredits(account)) return;
		const credits = account.credits;
		const index = credits.findIndex(credit => credit.id === account.target.creditId);
		const credit = credits[(index + direction + credits.length) % credits.length]!;
		this.#menu.cancelConfirmation();
		account.credit = credit;
		account.expiresAt = credit.expiresAt;
		account.target.creditId = credit.id;
		this.#statusMessage = undefined;
		this.#updateList();
	}

	#confirmationMessage(account: ResetUsageAccount): string {
		const subject =
			this.#selectedCreditDetails(account) ??
			(account.credit?.title ? `“${account.credit.title}”` : "1 saved reset");
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
		} else if (matchesKey(keyData, "tab")) {
			this.#cycleCredit(1);
		} else if (matchesKey(keyData, "shift+tab")) {
			this.#cycleCredit(-1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#activateSelection();
		}
	}

	#activateSelection(): void {
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
		}
	}

	override describe(): NativeNode {
		if (this.#nativeRoot) return this.#nativeRoot;
		this.#nativeItems ??= this.#menu.visibleItems.map(account => {
			const redeemable = account.redeemableCount > 0;
			const detail = [span(`${oneLine(account.providerLabel)} · #${account.target.credentialId}`, "muted")];
			if (account.active) detail.push(span(" (active)", "muted"));
			return node(
				"item",
				{
					label: redeemable ? oneLine(account.label) : [span(oneLine(account.label), "dim")],
					detail,
					value: [span(accountCountLabel(account), account.error ? "error" : redeemable ? "success" : "dim")],
				},
				undefined,
				this.#menu.adapter.getKey(account),
			);
		});
		const pending = this.#menu.visibleItems.find(item => this.#menu.isPending(item));
		const children: NativeNode[] = [
			node(
				"list",
				{
					selected: this.#menu.selectedKey ?? null,
					empty: [span("No provider accounts with saved resets", "muted")],
					max: { lines: RESET_SELECTOR_MAX_VISIBLE },
				},
				this.#nativeItems,
				"list",
			),
			pending
				? text([span(oneLine(this.#confirmationMessage(pending)), "warning")])
				: (this.#nativeHints ??= hintsRow([
						actionHint(["tui.select.up", "tui.select.down"], "select"),
						canCycleCredits(this.#menu.selectedItem)
							? { keys: ["tab", "shift+tab"], label: "Codex reset" }
							: undefined,
						{ keys: ["enter"], label: "spend a reset" },
						actionHint("tui.select.cancel", "cancel"),
					])),
		];
		const creditDetails = this.#selectedCreditDetails(this.#menu.selectedItem);
		if (creditDetails) children.splice(1, 0, text([span(creditDetails, "muted")]));
		if (this.#statusMessage) children.push(text([span(oneLine(this.#statusMessage), "warning")]));
		this.#nativeRoot = overlayCard(this.nativeRole, this.title, children);
		return this.#nativeRoot;
	}

	/**
	 * A click (or double-click) on an account highlights it and presses Enter:
	 * moving to another account drops a pending confirmation, so spending a
	 * reset still takes a second activation of the same account.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if ((event.type !== "select" && event.type !== "activate") || event.key !== "list") return;
		if (this.#menu.selectedKey !== event.item) {
			this.#menu.cancelConfirmation();
			this.#menu.setSelectedKey(event.item);
			if (this.#menu.selectedKey !== event.item) return;
			this.#statusMessage = undefined;
		}
		this.#activateSelection();
	}
}
