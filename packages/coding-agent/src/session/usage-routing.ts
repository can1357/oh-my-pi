import { randomUUID } from "node:crypto";
import type { UsageRouteAccountEvaluation, UsageRoutingScope, UsageRouteTarget } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { filterAvailableModelsByEnabledPatterns, resolveModelOverride } from "../config/model-resolver";
import { cfgDisabledProviders, cfgEnabledModels } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { findRetryFallbackCandidates, getRetryFallbackChains } from "./retry-fallback-chains";

/** Owns one governor scope per live session instance, not per persisted transcript. */
export class SessionUsageRouting {
	readonly #id = randomUUID();
	#revision = 0;
	#signature = "";
	#scope: UsageRoutingScope | undefined;
	#disposed = false;
	readonly #unsubscribe: () => void;

	readonly #unsubscribeSettings: () => void;
	constructor(
		readonly settings: Settings,
		readonly registry: ModelRegistry,
	) {
		const mirror = registry.subscribeMirror(() => this.refresh(true));
		this.#unsubscribe = mirror.unsubscribe;
		this.refresh();
		this.#unsubscribeSettings = settings.onLayersChange(() => this.refresh(true));
	}

	refresh(force = false): UsageRoutingScope | undefined {
		if (this.#disposed) return undefined;
		const chains = getRetryFallbackChains(this.settings);
		const context = {
			chains,
			getModelRole: (role: string) => this.settings.getModelRole(role),
			modelLookup: this.registry,
		};
		const disabled = cfgDisabledProviders.get(this.settings);
		const patterns = cfgEnabledModels.get(this.settings);
		const allowed = patterns?.length
			? filterAvailableModelsByEnabledPatterns(this.registry.getAll(), patterns, this.settings)
			: undefined;
		const roles = Object.entries(this.settings.getModelRoles()).flatMap(([role, primary]) => {
			if (!primary) return [];
			const first = resolveModelOverride([primary], this.registry, this.settings).model;
			const selectors = [
				primary,
				...findRetryFallbackCandidates(context, role, primary, first, { allowMissingPrimary: true }).map(
					item => item.raw,
				),
			];
			const targets: UsageRouteTarget[] = [];
			for (const selector of selectors) {
				const model = resolveModelOverride([selector], this.registry, this.settings).model;
				if (
					!model ||
					disabled.includes(model.provider) ||
					(allowed &&
						!allowed.some(
							candidate =>
								candidate.provider === model.provider &&
								candidate.id === model.id &&
								candidate.baseUrl === model.baseUrl,
						))
				)
					continue;
				targets.push({ selector, provider: model.provider, modelId: model.id, baseUrl: model.baseUrl });
			}
			return [{ role, targets }];
		});
		const signature = JSON.stringify(roles);
		if (force || signature !== this.#signature) {
			this.#signature = signature;
			this.#scope = { id: this.#id, revision: ++this.#revision, roles };
			this.registry.authStorage.governor.setRoutingScope(this.#scope);
		}
		return this.#scope;
	}

	async evaluate(
		role: string,
		sessionId: string,
		signal?: AbortSignal,
	): Promise<{ scope: UsageRoutingScope; accounts: readonly UsageRouteAccountEvaluation[] } | undefined> {
		const scope = this.refresh();
		const plan = scope?.roles.find(item => item.role === role);
		if (!scope || !plan) return undefined;
		try {
			const result = await this.registry.authStorage.governor.evaluateRoutes(
				{ scopeId: scope.id, revision: scope.revision, role, sessionId, targets: plan.targets },
				signal,
			);
			if (
				this.refresh()?.revision !== scope.revision ||
				result.scopeId !== scope.id ||
				result.revision !== scope.revision
			)
				return undefined;
			return { scope, accounts: result.accounts };
		} catch {
			return undefined;
		}
	}

	/** Choose only when both the current account and every possible destination are known. */
	async choose(
		role: string,
		sessionId: string,
		current: { provider: string; id: string; baseUrl?: string },
		signal: AbortSignal,
	): Promise<string | undefined> {
		const auth = this.registry.authStorage;
		const origin = auth.keys.source(current.provider);
		const selected = auth.sessions.selected(current.provider, sessionId);
		if (!selected || selected.explicit || (origin?.kind !== "oauth" && origin?.kind !== "api_key")) return undefined;
		const evaluation = await this.evaluate(role, sessionId, signal);
		const plan = evaluation?.scope.roles.find(item => item.role === role);
		if (!evaluation || !plan || signal.aborted) return undefined;
		const currentIndex = plan.targets.findIndex(
			target =>
				target.provider === current.provider && target.modelId === current.id && target.baseUrl === current.baseUrl,
		);
		if (currentIndex < 0) return undefined;
		const currentTarget = plan.targets[currentIndex];
		const currentAccount = evaluation.accounts.find(
			account => account.selector === currentTarget.selector && account.credentialId === selected.credentialId,
		);
		if (
			!currentAccount ||
			currentAccount.eligibility !== "eligible" ||
			currentAccount.allowance === "unknown" ||
			currentAccount.state === "unknown" ||
			currentAccount.state === "stale"
		)
			return undefined;
		if (
			currentAccount.state === "open" &&
			currentAccount.allowance === "included" &&
			currentAccount.protectedFor.length === 0
		)
			return undefined;
		const candidates = plan.targets.slice(currentIndex + 1).flatMap((target, index) => {
			const source = auth.keys.source(target.provider);
			if (source?.kind !== "oauth" && source?.kind !== "api_key") return [];
			const chosen = auth.sessions.selected(target.provider, sessionId);
			const accounts = evaluation.accounts.filter(
				account => account.selector === target.selector && account.eligibility !== "ineligible",
			);
			const possible = chosen ? accounts.filter(account => account.credentialId === chosen.credentialId) : accounts;
			if (
				possible.length === 0 ||
				possible.some(
					account =>
						account.eligibility !== "eligible" ||
						account.allowance !== "included" ||
						account.state !== "open" ||
						account.quotaKeys.length === 0,
				)
			)
				return [];
			// Do not move a healthy request onto the same quota just to rename its model.
			if (
				currentAccount.state === "open" &&
				currentAccount.allowance === "included" &&
				possible.some(account => account.quotaKeys.some(key => currentAccount.quotaKeys.includes(key)))
			)
				return [];
			const protection = Math.max(...possible.map(account => account.protectedFor.length));
			if (
				currentAccount.state === "open" &&
				currentAccount.allowance === "included" &&
				protection >= currentAccount.protectedFor.length
			)
				return [];
			return [
				{
					selector: target.selector,
					index,
					protection,
					expiry: Math.min(...possible.map(account => account.resetTieBreakExpiresAtMs ?? Infinity)),
				},
			];
		});
		candidates.sort((a, b) => a.protection - b.protection || a.expiry - b.expiry || a.index - b.index);
		return candidates[0]?.selector;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#unsubscribeSettings();
		this.#disposed = true;
		this.#unsubscribe();
		if (this.#scope) this.registry.authStorage.governor.removeRoutingScope(this.#id);
	}
}
