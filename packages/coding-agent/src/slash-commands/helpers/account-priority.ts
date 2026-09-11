import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { matchSessionPinAccounts, toSessionPinAccounts, type SessionPinAccount } from "./session-pin";

export function resolveTargetProvider(
	providerArg: string | undefined,
	session: AgentSession,
): { providerId: string; providerName: string } | { error: string } {
	const trimmed = providerArg?.trim().toLowerCase();
	const allProviders = getOAuthProviders();
	if (trimmed) {
		const matched = allProviders.find(p => p.id.toLowerCase() === trimmed || p.name.toLowerCase() === trimmed);
		if (matched) {
			return { providerId: matched.id, providerName: matched.name };
		}
		return { providerId: trimmed, providerName: trimmed };
	}

	const currentProvider = session.model?.provider;
	if (!currentProvider) {
		return { error: "No model selected. Specify a provider: /account priority <provider> [order...]" };
	}
	const matched = allProviders.find(p => p.id === currentProvider);
	return { providerId: currentProvider, providerName: matched?.name ?? currentProvider };
}

export function formatAccountPriorityList(providerName: string, accounts: readonly SessionPinAccount[]): string {
	if (accounts.length === 0) {
		return `No stored accounts for ${providerName}. Use /login to add one.`;
	}
	const lines = [`Account priority for ${providerName}:`];
	for (const account of accounts) {
		const priorityStr = account.priority !== undefined ? ` (Priority ${account.priority})` : " (unprioritized)";
		const activeStr = account.active ? " [active]" : "";
		lines.push(`${account.position + 1}. ${account.label}${priorityStr}${activeStr}`);
	}
	lines.push(
		"",
		`Set priority: /account priority ${providerName.toLowerCase()} <order...> (e.g. /account priority ${providerName.toLowerCase()} 2 1)`,
		`Clear priority: /account priority ${providerName.toLowerCase()} clear`,
	);
	return lines.join("\n");
}

export async function handleAccountPriorityCommand(args: string, session: AgentSession): Promise<string> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let providerToken: string | undefined;
	let orderTokens: string[] = [];

	if (tokens.length > 0) {
		const candidate = tokens[0]!;
		const allProviders = getOAuthProviders();
		const isProvider = allProviders.some(
			p => p.id.toLowerCase() === candidate.toLowerCase() || p.name.toLowerCase() === candidate.toLowerCase(),
		);
		if (isProvider || !/^\d+$/.test(candidate)) {
			providerToken = candidate;
			orderTokens = tokens.slice(1);
		} else {
			orderTokens = tokens;
		}
	}

	const resolved = resolveTargetProvider(providerToken, session);
	if ("error" in resolved) return resolved.error;
	const { providerId, providerName } = resolved;

	const authStorage = session.modelRegistry.authStorage;
	await authStorage.reload();
	const rawAccounts = authStorage.listOAuthAccounts(providerId, session.sessionId);
	const accounts = toSessionPinAccounts(rawAccounts);

	if (accounts.length === 0) {
		return `No stored OAuth accounts for ${providerName}. Use /login to add one.`;
	}

	if (
		orderTokens.length === 1 &&
		(orderTokens[0]?.toLowerCase() === "clear" || orderTokens[0]?.toLowerCase() === "reset")
	) {
		const currentPriorities = (settings.get("auth.accountPriority") as Record<string, string[]>) ?? {};
		const updated = { ...currentPriorities };
		delete updated[providerId];
		settings.set("auth.accountPriority", updated);
		authStorage.setAccountPriority(providerId, undefined);
		return `Reset account priority for ${providerName} to default order.`;
	}

	if (orderTokens.length === 0) {
		return formatAccountPriorityList(providerName, accounts);
	}

	const selectors = orderTokens
		.flatMap(t => t.split(","))
		.map(t => t.trim())
		.filter(Boolean);
	const matchedAccounts: SessionPinAccount[] = [];
	const seenCredentialIds = new Set<number>();

	for (const selector of selectors) {
		const matches = matchSessionPinAccounts(accounts, selector);
		if (matches.length === 0) {
			return `No ${providerName} account matches "${selector}". Run /account priority ${providerId} to see available accounts.`;
		}
		if (matches.length > 1) {
			return `"${selector}" matches multiple ${providerName} accounts: ${matches
				.map(a => `${a.position + 1}. ${a.label}`)
				.join(", ")}. Use account numbers (1-${accounts.length}).`;
		}
		const matched = matches[0]!;
		if (!seenCredentialIds.has(matched.credentialId)) {
			seenCredentialIds.add(matched.credentialId);
			matchedAccounts.push(matched);
		}
	}

	const prioritySelectors = matchedAccounts.map(acct => acct.email ?? acct.accountId ?? String(acct.credentialId));

	const currentPriorities = (settings.get("auth.accountPriority") as Record<string, string[]>) ?? {};
	const updated = { ...currentPriorities, [providerId]: prioritySelectors };
	settings.set("auth.accountPriority", updated);
	authStorage.setAccountPriority(providerId, prioritySelectors);

	const refreshedAccounts = toSessionPinAccounts(authStorage.listOAuthAccounts(providerId, session.sessionId));
	const lines = [`Updated account priority for ${providerName}:`];
	for (const acct of refreshedAccounts) {
		const p = acct.priority !== undefined ? ` (Priority ${acct.priority})` : " (unprioritized)";
		const a = acct.active ? " [active]" : "";
		lines.push(`${acct.position + 1}. ${acct.label}${p}${a}`);
	}
	return lines.join("\n");
}

export async function handleAccountListCommand(args: string, session: AgentSession): Promise<string> {
	const resolved = resolveTargetProvider(args.trim() || undefined, session);
	if ("error" in resolved) return resolved.error;
	const { providerId, providerName } = resolved;

	const authStorage = session.modelRegistry.authStorage;
	await authStorage.reload();
	const accounts = toSessionPinAccounts(authStorage.listOAuthAccounts(providerId, session.sessionId));
	return formatAccountPriorityList(providerName, accounts);
}
