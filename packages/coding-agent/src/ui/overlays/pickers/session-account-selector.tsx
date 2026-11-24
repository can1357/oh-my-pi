/** @jsxImportSource @oh-my-pi/pi-tui */
/** The account picker `/session pin` opens for the current model provider. */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { SessionPinAccount } from "../../../modes/view-model/overlays/session-account-selector";
import { SelectSheet } from "./select-sheet";

export interface SessionAccountSelectorProps {
	readonly provider: string;
	readonly accounts: readonly SessionPinAccount[];
	/** Paused accounts, listed after the pinnable ones and never pinned; `resume` is the `/usage resume` argument naming each. */
	readonly paused?: readonly { readonly account: SessionPinAccount; readonly resume: string }[];
	onSelect(account: SessionPinAccount): void;
	/** The user chose a paused account. */
	onPausedPick?(account: SessionPinAccount): void;
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
	const paused = props.paused ?? [];
	const pausedById = new Map(paused.map(row => [`paused:${row.account.credentialId}`, row]));
	const active = props.accounts.find(account => account.active);
	return (
		<SelectSheet
			title={`${props.provider} account`}
			subtitle="Pin the account this session sends its requests with"
			icon="key-round"
			noun="accounts"
			items={[
				...props.accounts.map(account => ({
					id: String(account.credentialId),
					label: account.label,
					detail: accountDetail(account),
					mark: { text: account.email ?? account.label, seed: account.label },
				})),
				// The terminal list still lets the keyboard reach a disabled row, so onPick routes paused ids.
				...paused.map(({ account, resume }) => ({
					id: `paused:${account.credentialId}`,
					label: account.label,
					detail: `paused — /usage resume ${resume}`,
					mark: { text: account.email ?? account.label, seed: account.label },
					disabled: `Paused; resume with /usage resume ${resume}`,
				})),
			]}
			initial={active ? String(active.credentialId) : undefined}
			current={active ? [String(active.credentialId)] : []}
			confirmLabel="Pin"
			// Natively the active account carries the current check; the terminal list says it in words.
			term={{
				title: `Select a ${props.provider.replace(/\s+/g, " ")} account for this session`,
				hint: null,
				labels: Object.fromEntries([
					...props.accounts.map(account => [
						String(account.credentialId),
						{ label: account.label, detail: account.active ? "active for this session" : undefined },
					]),
					...paused.map(({ account, resume }) => [
						`paused:${account.credentialId}`,
						{ label: account.label, detail: `paused — /usage resume ${resume}` },
					]),
				]),
			}}
			onPick={id => {
				const pausedRow = pausedById.get(id);
				if (pausedRow) {
					props.onPausedPick?.(pausedRow.account);
					return;
				}
				const account = byId.get(id);
				if (account) props.onSelect(account);
			}}
			onCancel={props.onCancel}
		/>
	);
}
