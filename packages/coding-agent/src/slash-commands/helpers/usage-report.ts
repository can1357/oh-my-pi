import { stripVTControlCharacters } from "node:util";
import type { DisabledCredentialSummary, UsageReport } from "@oh-my-pi/pi-ai";
import {
	collectStoredAccounts,
	formatUsageBreakdown,
	hasRenderableUsageBreakdown,
	selectReportableAccounts,
} from "../../usage/usage-breakdown";
import type { SlashCommandRuntime } from "../types";

/**
 * Build the `/usage` ACP-mode text. Prefers provider-reported limits when the
 * session exposes `fetchUsageReports`; otherwise falls back to the local
 * session-manager tallies.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime): Promise<string> {
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
		getUsageReportingModelSelectors?: (reports: readonly UsageReport[]) => string[];
	};
	const authStorage = runtime.session.modelRegistry.authStorage;
	const accounts = selectReportableAccounts(
		collectStoredAccounts(authStorage),
		providerId => authStorage.usageProviderFor(providerId) !== undefined,
	);
	let disabled: DisabledCredentialSummary[] = [];
	try {
		disabled = await authStorage.listDisabledCredentials();
	} catch {}
	const reports = (await provider.fetchUsageReports?.()) ?? [];
	if (hasRenderableUsageBreakdown(reports, accounts, disabled)) {
		const currentProvider = runtime.session.model?.provider;
		const activeAccount = currentProvider
			? authStorage.getOAuthAccountIdentity(currentProvider, runtime.session.sessionId)
			: undefined;
		const body = stripVTControlCharacters(
			formatUsageBreakdown(reports, accounts, Date.now(), undefined, disabled, {
				resolveActiveAccount: providerId => (providerId === currentProvider ? activeAccount : undefined),
				usageModelSelectors: provider.getUsageReportingModelSelectors?.(reports) ?? [],
			}),
		);
		let fence = "```";
		for (const run of body.matchAll(/`+/g)) {
			if (run[0].length >= fence.length) fence = "`".repeat(run[0].length + 1);
		}
		return [fence, body, fence].join("\n");
	}

	const stats = runtime.session.sessionManager.getUsageStatistics();
	const orchestrationTokens = stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead;
	return [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Total tokens: ${stats.totalTokens}`,
		...(orchestrationTokens > 0 ? [`Orchestration tokens: ${orchestrationTokens}`] : []),
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
	].join("\n");
}
