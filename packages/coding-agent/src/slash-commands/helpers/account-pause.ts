import { type AuthAccountPolicyConfig, loadAuthAccountPolicyConfig } from "@oh-my-pi/pi-ai/auth-broker";
import { type AuthAccountSelector, matchesAuthAccountSelector } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { SessionPinAccount } from "../../modes/view-model/overlays/session-account-selector";
import { isRecord } from "@oh-my-pi/pi-utils";
import { cfgAuthAccountPolicies } from "../../config/model-settings";
import { getByPath, type Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { cfgRetryUsageReservePct } from "../../session/settings";
import { errorMessage } from "./parse";
import {
	matchSessionPinAccounts,
	resumeSelector,
	toPausedSessionPinAccounts,
	toSessionPinAccounts,
} from "./session-pin";

type PolicyEntry = Record<string, unknown>;

/** Whether a raw `auth.accountPolicies` entry names `account` of `provider`. */
function policyNamesAccount(entry: unknown, provider: string, account: SessionPinAccount): entry is PolicyEntry {
	return (
		isRecord(entry) &&
		entry.provider === provider &&
		isRecord(entry.account) &&
		matchesAuthAccountSelector(entry.account as AuthAccountSelector, account)
	);
}

/**
 * Selector a new policy entry uses to name `account`: its first base identity
 * (email, account id, project id) plus its organization, widened by the account
 * id when that still names several of `accounts`. Undefined when nothing names
 * it uniquely.
 */
function accountSelector(
	account: SessionPinAccount,
	accounts: readonly SessionPinAccount[],
): AuthAccountSelector | undefined {
	const base: AuthAccountSelector | undefined = account.email
		? { email: account.email }
		: account.accountId
			? { accountId: account.accountId }
			: account.projectId
				? { projectId: account.projectId }
				: undefined;
	if (!base) return undefined;
	let selector: AuthAccountSelector = account.orgId ? { ...base, orgId: account.orgId } : base;
	const namesOne = (candidate: AuthAccountSelector) =>
		accounts.filter(other => matchesAuthAccountSelector(candidate, other)).length === 1;
	if (namesOne(selector)) return selector;
	if (!account.accountId || selector.accountId !== undefined) return undefined;
	selector = { ...selector, accountId: account.accountId };
	return namesOne(selector) ? selector : undefined;
}

function overrideNote(settings: Settings): string | undefined {
	const provenance = cfgAuthAccountPolicies.provenance(settings);
	if (provenance === "global" || provenance === "default") return undefined;
	if (provenance === "project") {
		return "Project settings override auth.accountPolicies here, so this change does not apply in this project until you edit them.";
	}
	if (provenance === "overlay") {
		return "A --config / PI_CONFIG_FILES overlay overrides auth.accountPolicies in this process.";
	}
	return "Another settings source overrides auth.accountPolicies in this process.";
}

/**
 * `/usage pause|resume [<provider>/]<account>`: hide a stored OAuth account from
 * every credential read, or bring it back, by setting `paused` on its
 * `auth.accountPolicies` entry in the global config. The login stays stored; the
 * settings sync applies the change to this and every other running process.
 */
export async function handleUsagePauseCommand(
	verb: "pause" | "resume",
	arg: string,
	session: AgentSession,
	settings: Settings,
	output: (text: string) => void | Promise<void>,
): Promise<void> {
	const oauthProviders = getOAuthProviders();
	let provider = session.model?.provider;
	let selector = arg.trim();
	const slash = selector.indexOf("/");
	if (slash > 0) {
		const named = selector.slice(0, slash);
		if (oauthProviders.some(candidate => candidate.id === named)) {
			provider = named;
			selector = selector.slice(slash + 1).trim();
		}
	}
	if (!provider) {
		await output("Select a model first, or name the account as <provider>/<account>.");
		return;
	}
	const providerName = oauthProviders.find(candidate => candidate.id === provider)?.name ?? provider;

	// Work from config.yml as it is now: another window may have paused or resumed an account
	// since this process last read it, and a whole-list write from that stale copy would undo it.
	try {
		await settings.reloadFromDisk();
	} catch (error) {
		await output(`Could not reload settings: ${errorMessage(error)}`);
		return;
	}
	const authStorage = session.modelRegistry.authStorage;
	await authStorage.credentials.reload();
	const visible = toSessionPinAccounts(authStorage.oauth.accounts(provider, session.sessionId));
	const accounts = [
		...visible,
		...toPausedSessionPinAccounts(authStorage.oauth.pausedAccounts(provider), visible.length),
	];
	// Visible and paused rows together are every stored account, but which of them is paused is
	// judged from the settings just read: this process's credential view follows them a moment later.
	const effectivePolicies: readonly unknown[] = cfgAuthAccountPolicies.get(settings);
	const pausedIds = new Set(
		accounts
			.filter(candidate =>
				effectivePolicies.some(entry => policyNamesAccount(entry, provider, candidate) && entry.paused === true),
			)
			.map(candidate => candidate.credentialId),
	);
	if (accounts.length === 0) {
		await output(`No stored OAuth accounts for ${providerName}. Use /login to add one.`);
		return;
	}

	if (!selector) {
		const lines = [`OAuth accounts for ${providerName}:`];
		for (const account of accounts) {
			const marker = pausedIds.has(account.credentialId) ? " (paused)" : account.active ? " (active)" : "";
			lines.push(`${account.position + 1}. ${account.label}${marker}`);
		}
		lines.push("", "Pause one with `/usage pause <number|email>`; resume with `/usage resume <number|email>`.");
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(`No ${providerName} account matches "${selector}".`);
		return;
	}
	if (matches.length > 1) {
		await output(
			`"${selector}" matches several ${providerName} accounts: ${matches
				.map(account => `${account.position + 1}. ${account.label}`)
				.join(", ")}. Use the account number.`,
		);
		return;
	}
	const account = matches[0]!;
	const isPaused = pausedIds.has(account.credentialId);
	if (verb === "pause" && isPaused) {
		await output(`${account.label} is already paused.`);
		return;
	}
	if (verb === "resume" && !isPaused) {
		await output(`${account.label} is not paused.`);
		return;
	}

	// Edit the global layer only; `getGlobalSettings()` returns a deep clone, so entries are edited in place.
	const current = getByPath(settings.getGlobalSettings(), cfgAuthAccountPolicies.segments);
	if (current !== undefined && !Array.isArray(current)) {
		await output("auth.accountPolicies in config.yml is not a list; fix it before pausing accounts.");
		return;
	}
	let next: unknown[] = current ?? [];
	const named = next.filter(entry => policyNamesAccount(entry, provider, account));

	if (verb === "pause") {
		const existing = named[0];
		if (existing) {
			existing.paused = true;
		} else {
			const accountPolicySelector = accountSelector(account, accounts);
			if (!accountPolicySelector) {
				await output(
					`${account.label} has no unique email, account id, or project id that auth.accountPolicies can name; it cannot be paused.`,
				);
				return;
			}
			next.push({ provider, account: accountPolicySelector, paused: true });
		}
	} else {
		const pausing = named.filter(entry => entry.paused === true);
		if (pausing.length === 0) {
			const source =
				cfgAuthAccountPolicies.provenance(settings) === "project"
					? "project settings (.omp/config.yml)"
					: "another settings source";
			await output(`${account.label} is paused by ${source}; remove \`paused\` there to resume it.`);
			return;
		}
		for (const entry of pausing) delete entry.paused;
		// An entry left naming only its account existed just to pause it.
		const emptied = new Set<unknown>(
			pausing.filter(entry => Object.keys(entry).every(key => key === "provider" || key === "account")),
		);
		next = next.filter(entry => !emptied.has(entry));
	}

	let validated: AuthAccountPolicyConfig;
	try {
		validated = await loadAuthAccountPolicyConfig({
			accountPolicies: next,
			usageReservePct: cfgRetryUsageReservePct.get(settings),
		});
	} catch (error) {
		await output(`Could not ${verb} ${account.label}: ${errorMessage(error)}`);
		return;
	}
	try {
		if (validated.accountPolicies.length === 0) cfgAuthAccountPolicies.unset(settings);
		else cfgAuthAccountPolicies.set(settings, validated.accountPolicies);
		await settings.flush();
	} catch (error) {
		await output(`Could not ${verb} ${account.label}: ${errorMessage(error)}`);
		return;
	}
	// A save that lost a race with another writer keeps the file's version; report what was committed.
	const committed = getByPath(settings.getGlobalSettings(), cfgAuthAccountPolicies.segments);
	const committedPaused =
		Array.isArray(committed) &&
		committed.some(entry => policyNamesAccount(entry, provider, account) && entry.paused === true);
	if (committedPaused !== (verb === "pause")) {
		await output(`Could not ${verb} ${account.label}: config.yml changed while saving; run the command again.`);
		return;
	}

	// Name the account so the command resolves it later from any model: provider-qualified when it
	// is not the current model's provider, and by a selector no sibling shares.
	const resumeTarget = `${provider === session.model?.provider ? "" : `${provider}/`}${resumeSelector(account, accounts)}`;

	const lines: string[] = [];
	if (verb === "pause") {
		const othersVisible = accounts.some(
			other => other.credentialId !== account.credentialId && !pausedIds.has(other.credentialId),
		);
		lines.push(
			`Paused ${account.label} for ${providerName}: OMP will not use it until /usage resume ${resumeTarget}.` +
				(othersVisible ? "" : ` No other ${providerName} account is available now.`),
		);
	} else {
		lines.push(`Resumed ${account.label} for ${providerName}.`);
	}
	const note = overrideNote(settings);
	if (note) lines.push(note);
	await output(lines.join("\n"));
}
