/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The account picker for `/usage reset`: provider accounts with their saved
 * rate-limit resets, and the selected account's credits under the list. A
 * reset is a scarce, irreversible credit, so spending takes two activations:
 * the first turns the selected row into a confirm strip (what the reset covers
 * reads in the subtitle), the second spends it. An account whose resets clear
 * different limits gets one row per reset instead, and only the reset the
 * provider offers next can be confirmed. Moving to another account, ⎋, or the
 * strip's `cancel` drops the pending confirmation; ⎋ with nothing pending (or
 * `close`) cancels the picker.
 */
import { batch, type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspPickerAction, TspPickerItem, TspPickerProps, TspSpan } from "@oh-my-pi/pi-wire";
import type { ResetUsageAccount } from "../../../modes/view-model/overlays/reset-usage-selector";
import { formatUsageResetWindow } from "../../../session/usage-display";
import { closeAction, PICKER_KEY, pickerAction } from "./select-sheet";
import { confirmKbd } from "../../keys/hints";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { bindingGlyph, selectNavGlyphs } from "../../styles/panels/common";

export interface ResetUsageSelectorProps {
	readonly accounts: readonly ResetUsageAccount[];
	onSelect(account: ResetUsageAccount): void;
	onCancel(): void;
	/** The clock expiries are measured against (default `Date.now`). */
	now?(): number;
}

const SUBTITLE = "Spend a saved reset to refresh an account's rate limit now";
const actions = (): TspPickerAction[] => [
	pickerAction("confirm", "Spend reset", confirmKbd(), { primary: true }),
	closeAction(),
];
/** The key hint, in the user's bindings. */
const hintText = (): string =>
	`${selectNavGlyphs()} select · ${bindingGlyph("tui.select.confirm", "enter")} spend a reset · ${bindingGlyph("tui.select.cancel", "escape")} cancel`;

const oneLine = (value: string): string => sanitizeText(value.replace(/[\r\n\t]+/g, " "));

/** The account's picker id: provider, credential and credit. */
export function resetAccountKey(account: ResetUsageAccount): string {
	return `${account.provider}:${account.target.credentialId}:${account.credit?.id ?? account.target.creditId ?? ""}`;
}

/** Reset count, usability, expiry and unavailability of an account row, or its error; a reset row's own line. */
function countLabel(account: ResetUsageAccount, now: number): string {
	if (account.error) return oneLine(account.error);
	if (account.creditLine) {
		const reason =
			account.redeemableCount <= 0 && account.unavailableReason ? ` · ${oneLine(account.unavailableReason)}` : "";
		return `${oneLine(account.creditLine)}${reason}`;
	}
	let label = `${account.availableCount} saved reset${account.availableCount === 1 ? "" : "s"}`;
	if (account.redeemableCount !== account.availableCount) label += ` · ${account.redeemableCount} usable now`;
	const expiry = account.expiresAt ? Date.parse(account.expiresAt) : Number.NaN;
	if (!Number.isNaN(expiry)) label += expiry > now ? ` · expires in ${formatDuration(expiry - now)}` : " · expired";
	if (account.redeemableCount <= 0 && account.unavailableReason) label += ` · ${oneLine(account.unavailableReason)}`;
	return label;
}

/** The picker row of an account: provider mark, identity, its resets as a fact, unusable ones disabled with the reason. */
function pickerItem(account: ResetUsageAccount, now: number): TspPickerItem {
	const redeemable = account.redeemableCount > 0;
	const detail: TspSpan[] = [{ t: `${oneLine(account.providerLabel)} · #${account.target.credentialId}` }];
	const reason = account.error ?? (redeemable ? undefined : (account.unavailableReason ?? "no resets usable now"));
	if (reason) detail.push({ t: ` · ${oneLine(reason)}`, s: account.error ? "error" : "warning" });
	let resets: TspSpan;
	if (account.error) resets = { t: "unavailable", s: "error" };
	else if (account.creditLine) resets = { t: oneLine(account.creditLine), s: redeemable ? "success" : "dim" };
	else if (!redeemable) resets = { t: `${account.availableCount} saved`, s: "dim" };
	else if (account.redeemableCount === account.availableCount)
		resets = { t: `${account.redeemableCount} usable`, s: "success" };
	else resets = { t: `${account.redeemableCount} of ${account.availableCount} usable`, s: "success" };
	const facts: Record<string, TspSpan[]> = { resets: [resets] };
	const expiry = account.expiresAt ? Date.parse(account.expiresAt) : Number.NaN;
	if (!Number.isNaN(expiry)) {
		facts.expires = [
			expiry > now ? { t: `expires in ${formatDuration(expiry - now)}`, s: "dim" } : { t: "expired", s: "warning" },
		];
	}
	return {
		id: resetAccountKey(account),
		label: oneLine(account.label),
		detail,
		mark: { text: account.providerLabel, seed: account.provider },
		facts,
		...(reason ? { disabled: oneLine(reason) } : {}),
		// Each credit's id, title and coverage on hover.
		...(account.creditLines?.length ? { title: account.creditLines.map(oneLine).join("\n") } : {}),
	};
}

/** The terminal row of an account: `[Provider · #id] label (active)  counts`. */
function terminalRow(account: ResetUsageAccount, now: number): TspSpan[] {
	const redeemable = account.redeemableCount > 0;
	const spans: TspSpan[] = [
		{ t: `[${oneLine(account.providerLabel)} · #${account.target.credentialId}] `, s: "muted" },
		// Unusable accounts stay dim even when selected; the selection colors the rest.
		redeemable ? { t: oneLine(account.label) } : { t: oneLine(account.label), s: "dim" },
	];
	if (account.active) spans.push({ t: " (active)", s: "muted" });
	spans.push({ t: "  ", s: "text" });
	spans.push({ t: countLabel(account, now), s: account.error ? "error" : redeemable ? "success" : "dim" });
	return spans;
}

/** What a reset of `account` spends and covers, without key instructions. */
function confirmationNotes(account: ResetUsageAccount): { subject: string; notes: string[] } {
	const credit = account.credit;
	const id = credit?.id ? oneLine(credit.id) : undefined;
	const title = credit?.title ? `“${credit.title}”` : undefined;
	const subject = title && id ? `${title} (${id})` : (title ?? (id ? `saved reset ${id}` : "1 saved reset"));
	const notes: string[] = [];
	if (account.credit?.program === "juniper_tide") {
		notes.push("This resets Claude's 5h session limit only; weekly limits stay unchanged.");
	} else if (account.credit?.clears?.length) {
		notes.push(`Covers ${account.credit.clears.map(formatUsageResetWindow).join(", ")}.`);
	}
	if (account.credit?.requiresLimit === false) {
		notes.push("Optional early use: this can be spent before the covered limit is reached.");
	}
	return { subject, notes };
}

export function ResetUsageSelector(props: ResetUsageSelectorProps): JSXNode {
	const now = props.now?.() ?? Date.now();
	const accounts = props.accounts;
	const byKey = new Map(accounts.map(account => [resetAccountKey(account), account]));
	const keys = accounts.map(resetAccountKey);
	const first = accounts.find(account => account.redeemableCount > 0);
	const selected = signal<string | null>(first ? resetAccountKey(first) : null);
	/** The account awaiting its second activation. */
	const pending = signal<string | null>(null);
	/** Why the last activation could not spend. */
	const status = signal<string | null>(null);
	const items = accounts.map(account => pickerItem(account, now));
	const rows: Record<string, TspSpan[]> = {};
	for (const account of accounts) rows[resetAccountKey(account)] = terminalRow(account, now);

	const moveTo = (key: string): void =>
		batch(() => {
			pending.set(null);
			status.set(null);
			selected.set(key);
		});
	const activate = (): void => {
		const account = byKey.get(selected() ?? "");
		if (!account) return;
		if (account.redeemableCount <= 0) {
			if (account.creditLine) {
				status.set(
					`That reset can't be spent now${account.unavailableReason ? `: ${account.unavailableReason}` : "."}`,
				);
			} else {
				status.set(
					account.unavailableReason
						? `That account's saved resets are unavailable: ${account.unavailableReason}`
						: "That account has no saved resets usable right now.",
				);
			}
			return;
		}
		const key = resetAccountKey(account);
		if (pending() !== key) {
			batch(() => {
				pending.set(key);
				status.set(null);
			});
			return;
		}
		// Spent: the sheet closes; what it shows meanwhile stays as it was.
		props.onSelect(account);
	};
	const pick = (key: string, spend: boolean): void => {
		if (!byKey.has(key)) return;
		if (selected() !== key) moveTo(key);
		if (spend) activate();
	};
	const step = (delta: number, wrap: boolean): void => {
		if (keys.length === 0) return;
		const at = keys.indexOf(selected() ?? "");
		let next = at + delta;
		if (next < 0 || next >= keys.length)
			next = wrap ? (delta < 0 ? keys.length - 1 : 0) : Math.max(0, Math.min(keys.length - 1, next));
		moveTo(keys[next]!);
	};
	const onKey = (key: KeyEvent): boolean => {
		if (matchesSelectCancel(key)) {
			if (pending() !== null) {
				pending.set(null);
				status.set(null);
			} else props.onCancel();
			return true;
		}
		switch (selectKeyId(key)) {
			// Moving always drops a pending confirmation, even when the selection stays.
			case "up":
				step(-1, true);
				return true;
			case "down":
				step(1, true);
				return true;
			case "pageUp":
				step(-10, false);
				return true;
			case "pageDown":
				step(10, false);
				return true;
			default:
				return false;
		}
	};

	const confirm = (): TspPickerProps["confirm"] => {
		const account = byKey.get(pending() ?? "");
		if (!account) return null;
		const { subject } = confirmationNotes(account);
		return { text: `Spend ${subject} on ${oneLine(account.label)}?`, act: "confirm", label: "Spend" };
	};
	const subtitle = (): TspPickerProps["subtitle"] => {
		const message = status();
		if (message) return [{ t: oneLine(message), s: "warning" }];
		const account = byKey.get(pending() ?? "");
		const notes = account ? confirmationNotes(account).notes : [];
		return notes.length > 0 ? oneLine(notes.join(" ")) : SUBTITLE;
	};
	const term = () => {
		const account = byKey.get(pending() ?? "");
		let hint: string | TspSpan[] = hintText();
		if (account) {
			const { subject, notes } = confirmationNotes(account);
			const message = [
				`Press ${bindingGlyph("tui.select.confirm", "enter")} again to spend ${subject} for ${account.label} (${account.providerLabel}).`,
				...notes,
				`${bindingGlyph("tui.select.cancel", "escape")} cancels.`,
			].join(" ");
			hint = [{ t: oneLine(message), s: "warning" }];
		}
		// The selected account's credits, one per line: id, title, what each clears.
		const notes: TspSpan[][] = (byKey.get(selected() ?? "")?.creditLines ?? []).map(line => [
			{ t: oneLine(line), s: "dim" },
		]);
		const message = status();
		return {
			title: "Spend a saved rate-limit reset",
			rows,
			empty: [{ t: "No provider accounts with saved resets", s: "muted" }],
			hint,
			hintWrap: true,
			notes: message
				? [...notes, "", [{ t: oneLine(message), s: "warning" }]]
				: notes.length > 0
					? notes
					: undefined,
		};
	};

	return (
		<col>
			<picker
				key={PICKER_KEY}
				title="Rate-limit resets"
				subtitle={subtitle}
				icon="refresh"
				noun="accounts"
				size="md"
				layout="cards"
				preview="none"
				query={null}
				columns={[
					{ id: "expires", priority: 1 },
					{ id: "resets", priority: 2 },
				]}
				items={items}
				current={accounts.filter(account => account.active).map(resetAccountKey)}
				selected={selected}
				empty="No provider accounts with saved resets"
				actions={actions}
				confirm={confirm}
				term={term}
				onKey={onKey}
				onSelect={key => pick(key, false)}
				onActivate={key => pick(key, true)}
				onAction={act => {
					if (act === "confirm") activate();
					else if (act === "cancel" && pending() !== null) {
						pending.set(null);
						status.set(null);
					} else if (act === "close" || act === "cancel") props.onCancel();
				}}
			/>
		</col>
	);
}
