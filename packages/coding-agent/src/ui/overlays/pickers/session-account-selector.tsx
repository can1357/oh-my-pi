/** @jsxImportSource @oh-my-pi/pi-tui */
/** The account picker `/session pin` opens for the current model provider. */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { SessionPinAccount } from "../../../modes/view-model/overlays/session-account-selector";
import { SelectSheet } from "./select-sheet";

export interface SessionAccountSelectorProps {
	readonly provider: string;
	readonly accounts: readonly SessionPinAccount[];
	onSelect(account: SessionPinAccount): void;
	onCancel(): void;
}

/** What tells two accounts of one provider apart besides their label: the organization, project or host. */
function accountDetail(account: SessionPinAccount): string {
	const parts = [account.orgName ?? account.orgId, account.projectId, account.enterpriseUrl].filter(
		(part): part is string => typeof part === "string" && part.trim().length > 0 && !account.label.includes(part),
	);
	return parts.join(" · ");
}

export function SessionAccountSelector(props: SessionAccountSelectorProps): JSXNode {
	const byId = new Map(props.accounts.map(account => [String(account.credentialId), account]));
	const active = props.accounts.find(account => account.active);
	return (
		<SelectSheet
			title={`${props.provider} account`}
			subtitle="Pin the account this session sends its requests with"
			icon="key-round"
			noun="accounts"
			items={props.accounts.map(account => ({
				id: String(account.credentialId),
				label: account.label,
				detail: accountDetail(account),
				mark: { text: account.email ?? account.label, seed: account.label },
			}))}
			initial={active ? String(active.credentialId) : undefined}
			current={active ? [String(active.credentialId)] : []}
			confirmLabel="Pin"
			// Natively the active account carries the current check; the terminal list says it in words.
			term={{
				title: `Select a ${props.provider.replace(/\s+/g, " ")} account for this session`,
				hint: null,
				labels: Object.fromEntries(
					props.accounts.map(account => [
						String(account.credentialId),
						{ label: account.label, detail: account.active ? "active for this session" : undefined },
					]),
				),
			}}
			onPick={id => {
				const account = byId.get(id);
				if (account) props.onSelect(account);
			}}
			onCancel={props.onCancel}
		/>
	);
}
