import type {
	AuthAccountPolicies,
	AuthAccountPolicy,
	AuthAccountSelector,
	OAuthAccountIdentity,
} from "@oh-my-pi/pi-ai/auth-storage";
import { matchesAuthAccountSelector } from "@oh-my-pi/pi-ai/auth-storage";
import {
	DEFAULT_ACCOUNT_PRIORITY,
	type AccountPriorityHost,
	type AccountPriorityProvider,
} from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { cfgAuthAccountPolicies } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { toSessionPinAccounts } from "../slash-commands/helpers/session-pin";
import type { AuthStorage } from "./auth-storage";
import { cfgRetryUsageReservePct } from "./settings";

export interface AccountPriorityAssignment {
	account: OAuthAccountIdentity;
	priority: number;
}

export function accountPolicySelector(account: OAuthAccountIdentity): AuthAccountSelector {
	const selector: { email?: string; accountId?: string; projectId?: string; orgId?: string } = {};
	for (const field of ["email", "accountId", "projectId", "orgId"] as const) {
		const value = account[field];
		if (typeof value === "string" && value.length > 0) selector[field] = value;
	}
	return selector;
}

export function applyAccountPriorityAssignments(
	existing: AuthAccountPolicies,
	provider: string,
	assignments: readonly AccountPriorityAssignment[],
): AuthAccountPolicy[] {
	const allDefault = assignments.every(assignment => assignment.priority === DEFAULT_ACCOUNT_PRIORITY);
	const covered = new Set<number>();
	const next: AuthAccountPolicy[] = [];
	for (const entry of existing) {
		if (entry.provider !== provider) {
			next.push(entry);
			continue;
		}
		const assignmentIndex = assignments.findIndex(
			(assignment, index) => !covered.has(index) && matchesAuthAccountSelector(entry.account, assignment.account),
		);
		const hasMatchingAssignment = assignmentIndex !== -1;
		if (!hasMatchingAssignment) continue;
		const assignment = assignments[assignmentIndex]!;
		covered.add(assignmentIndex);
		if (allDefault) {
			if (entry.reservePct === undefined) continue;
			next.push({ provider: entry.provider, account: entry.account, reservePct: entry.reservePct });
		} else {
			next.push({ ...entry, priority: assignment.priority });
		}
	}
	if (!allDefault) {
		for (const [index, assignment] of assignments.entries()) {
			if (covered.has(index)) continue;
			next.push({ provider, account: accountPolicySelector(assignment.account), priority: assignment.priority });
		}
	}
	return next;
}

export function pruneAccountPolicies(
	existing: AuthAccountPolicies,
	provider: string,
	removed?: OAuthAccountIdentity,
): AuthAccountPolicy[] {
	return existing.filter(entry => {
		if (entry.provider !== provider) return true;
		if (removed === undefined) return false;
		return !matchesAuthAccountSelector(entry.account, removed);
	});
}

export function createAccountPriorityHost(
	authStorage: AuthStorage,
	settings: Settings,
	providerLabel: (providerId: string) => string,
): AccountPriorityHost {
	return {
		providers() {
			const providerIds = new Set<string>();
			for (const row of authStorage.credentials.list()) {
				if (row.credential.type === "oauth") providerIds.add(row.provider);
			}
			const providers: AccountPriorityProvider[] = [];
			for (const id of providerIds) {
				const accounts = toSessionPinAccounts(authStorage.oauth.accounts(id));
				if (accounts.length < 2) continue;
				const policies = cfgAuthAccountPolicies.get(settings).filter(policy => policy.provider === id);
				const anyPriority = policies.some(policy => policy.priority !== undefined);
				providers.push({
					id,
					label: providerLabel(id),
					accounts: accounts.map(account => ({
						key: String(account.credentialId),
						label: account.label,
						priority:
							policies.find(policy => matchesAuthAccountSelector(policy.account, account))?.priority ??
							(anyPriority ? 0 : DEFAULT_ACCOUNT_PRIORITY),
					})),
				});
			}
			providers.sort((left, right) => left.label.localeCompare(right.label));
			return providers;
		},
		save(providerId, priorities) {
			const assignments = authStorage.oauth.accounts(providerId).map(account => ({
				account,
				priority: priorities.get(String(account.credentialId)) ?? DEFAULT_ACCOUNT_PRIORITY,
			}));
			const next = applyAccountPriorityAssignments(cfgAuthAccountPolicies.get(settings), providerId, assignments);
			authStorage.setAccountPolicies({
				accountPolicies: next,
				defaultReservePct: cfgRetryUsageReservePct.get(settings),
			});
			cfgAuthAccountPolicies.set(settings, next);
		},
	};
}
