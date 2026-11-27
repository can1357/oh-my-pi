/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The account picker `/logout` opens once the provider is chosen.
 *
 * A row click highlights an account; activating it (Enter, a second click,
 * `Sign out`) logs it out, revoking it at the provider when one supports it.
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import type { TspPickerAction, TspSpan } from "@oh-my-pi/pi-wire";
import type { LogoutAccount } from "../../../modes/view-model/overlays/logout-account-selector";
import { closeAction, PICKER_KEY, pickerAction } from "./select-sheet";
import { confirmKbd } from "../../keys/hints";
import { bindingGlyph, selectNavGlyphs } from "../../styles/panels/common";

export interface LogoutAccountSelectorProps {
	readonly provider: string;
	readonly accounts: readonly LogoutAccount[];
	onSelect(account: LogoutAccount): void;
	onCancel(): void;
}

/** The terminal row of an account: label, `(active)`, then its detail. */
function accountRow(account: LogoutAccount): TspSpan[] {
	const spans: TspSpan[] = [{ t: account.label }];
	if (account.active) spans.push({ t: " (active)", s: "muted" });
	if (account.detail) spans.push({ t: `  ${account.detail}`, s: "dim" });
	return spans;
}

export function LogoutAccountSelector(props: LogoutAccountSelectorProps): JSXNode {
	const accounts = props.accounts;
	const byId = new Map(accounts.map(account => [String(account.credentialId), account]));
	const active = accounts.find(account => account.active);
	const selected = signal<string | null>(
		active ? String(active.credentialId) : accounts[0] ? String(accounts[0].credentialId) : null,
	);
	const actions = (): TspPickerAction[] => [
		pickerAction("confirm", "Sign out", confirmKbd(), { primary: true, danger: true }),
		closeAction(),
	];
	const confirm = (): void => {
		const account = byId.get(selected() ?? "");
		if (account) props.onSelect(account);
	};
	const pick = (id: string, logout: boolean): void => {
		if (!byId.has(id)) return;
		selected.set(id);
		if (logout) confirm();
	};
	const items = accounts.map(account => ({
		id: String(account.credentialId),
		label: account.label,
		...(account.detail ? { detail: account.detail } : {}),
		badges: [{ text: account.type === "oauth" ? "login" : "api key" }],
	}));
	const rows: Record<string, TspSpan[]> = {};
	for (const account of accounts) rows[String(account.credentialId)] = accountRow(account);
	return (
		<col>
			<picker
				key={PICKER_KEY}
				title={`${props.provider} accounts`}
				subtitle="Pick the account to sign out"
				icon="key-round"
				noun="accounts"
				size="md"
				layout="cards"
				preview="none"
				query={null}
				items={items}
				current={accounts.filter(account => account.active).map(account => String(account.credentialId))}
				selected={selected}
				empty="No stored accounts to log out"
				actions={actions}
				term={{
					title: `Select ${props.provider} account to log out`.replace(/\s+/g, " "),
					rows,
					empty: [{ t: "No stored accounts to log out", s: "muted" }],
					hint: `${selectNavGlyphs()} select · ${bindingGlyph("tui.select.confirm", "enter")} log out account · ${bindingGlyph("tui.select.cancel", "escape")} cancel`,
					wrap: true,
				}}
				onSelect={id => pick(id, false)}
				onActivate={id => pick(id, true)}
				onAction={act => {
					if (act === "confirm") confirm();
					else if (act === "close" || act === "cancel") props.onCancel();
				}}
			/>
		</col>
	);
}
