/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The account picker `/logout` opens once the provider is chosen.
 *
 * Enter uses the primary sign-out action. For providers with separate local
 * sign-out and disconnect actions, only the explicit disconnect revokes access.
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import type { TspPickerAction, TspSpan } from "@oh-my-pi/pi-wire";
import type { LogoutAccount, LogoutAccountAction } from "../../../modes/view-model/overlays/logout-account-selector";
import { closeAction, PICKER_KEY, pickerAction } from "./select-sheet";
import { confirmKbd } from "../../keys/hints";
import { bindingGlyph, selectNavGlyphs } from "../../styles/panels/common";

export interface LogoutAccountSelectorProps {
	readonly provider: string;
	readonly accounts: readonly LogoutAccount[];
	onSelect(account: LogoutAccount, action: LogoutAccountAction): void;
	onOpenConnection(url: string): void;
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
	const selectedAccount = (): LogoutAccount | undefined => byId.get(selected() ?? "");
	const localLabel = "Sign out on this device";
	const actions = (): TspPickerAction[] => {
		const connection = selectedAccount()?.connection;
		const result = [
			pickerAction("confirm", connection ? localLabel : "Sign out", confirmKbd(), { primary: true, danger: true }),
		];
		if (connection) result.push(pickerAction("disconnect", connection.disconnectLabel, "f5", { danger: true }));
		if (connection?.manage) result.push(pickerAction("manage", connection.manage.label, "f6"));
		result.push(closeAction());
		return result;
	};
	const confirm = (): void => {
		const account = selectedAccount();
		if (account) props.onSelect(account, account.connection ? "sign-out-local" : "disconnect");
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
		...(account.connection ? {} : { badges: [{ text: account.type === "oauth" ? "login" : "api key" }] }),
	}));
	const rows: Record<string, TspSpan[]> = {};
	for (const account of accounts) rows[String(account.credentialId)] = accountRow(account);
	const splitActions = accounts.some(account => account.connection);
	return (
		<col>
			<picker
				key={PICKER_KEY}
				title={`${props.provider} accounts`}
				subtitle={splitActions ? "Sign out here or disconnect on all devices" : "Pick the account to sign out"}
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
				term={() => {
					const connection = selectedAccount()?.connection;
					const manage = connection?.manage;
					const confirmKey = bindingGlyph("tui.select.confirm", "enter");
					const cancelKey = bindingGlyph("tui.select.cancel", "escape");
					return {
						title: `Select ${props.provider} account to log out`.replace(/\s+/g, " "),
						rows,
						empty: [{ t: "No stored accounts to log out", s: "muted" }],
						hint: connection
							? `${selectNavGlyphs()} select · ${confirmKey} ${localLabel} · F5 ${connection.disconnectLabel}${manage ? ` · F6 ${manage.label}` : ""} · ${cancelKey} cancel`
							: `${selectNavGlyphs()} select · ${confirmKey} log out account · ${cancelKey} cancel`,
						...(connection ? { hintWrap: true } : {}),
						...(manage ? { notes: [[{ t: manage.url, s: "link" }]] } : {}),
						wrap: true,
					};
				}}
				onSelect={id => pick(id, false)}
				onActivate={id => pick(id, true)}
				onAction={act => {
					if (act === "confirm") confirm();
					else if (act === "close" || act === "cancel") props.onCancel();
					else if (act === "disconnect") {
						const account = selectedAccount();
						if (account?.connection) props.onSelect(account, "disconnect");
					} else if (act === "manage") {
						const manage = selectedAccount()?.connection?.manage;
						if (manage) props.onOpenConnection(manage.url);
					}
				}}
			/>
		</col>
	);
}
