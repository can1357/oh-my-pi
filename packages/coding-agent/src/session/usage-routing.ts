import { randomUUID } from "node:crypto";
import type {
	UsageRouteAccountEvaluation,
	UsageRouteCandidate,
	UsageRouteIntent,
	UsageRoutingOwner,
	UsageRoutingScope,
	UsageRouteTarget,
} from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { filterAvailableModelsByEnabledPatterns, resolveModelOverride } from "../config/model-resolver";
import { cfgDisabledProviders, cfgEnabledModels } from "../config/model-settings";
import type { Settings } from "../config/settings";
import {
	findRetryFallbackCandidates,
	getRetryFallbackChains,
	resolveRetryFallbackChainKey,
} from "./retry-fallback-chains";

/** Owns one governor scope per live session instance, not per persisted transcript. */
export class SessionUsageRouting {
	readonly #id = randomUUID();
	#revision = 0;
	#signature = "";
	#scope: UsageRoutingScope | undefined;
	readonly #modelSelectors = new Set<string>();
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
		const buildTargets = (selectors: readonly string[]): UsageRouteTarget[] => {
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
				targets.push({
					selector,
					provider: model.provider,
					modelId: model.id,
					baseUrl: model.baseUrl,
					accountIds: model.accountAccess ? Object.keys(model.accountAccess) : undefined,
				});
			}
			return targets;
		};
		const roles = Object.entries(this.settings.getModelRoles()).flatMap(([role, primary]) => {
			if (!primary) return [];
			const first = resolveModelOverride([primary], this.registry, this.settings).model;
			const selectors = [
				primary,
				...findRetryFallbackCandidates(context, role, primary, first, { allowMissingPrimary: true }).map(
					item => item.raw,
				),
			];
			return [{ role, targets: buildTargets(selectors) }];
		});
		const modelContext = {
			...context,
			chains: Object.fromEntries(Object.entries(chains).filter(([key]) => key === "default" || key.includes("/"))),
			getModelRole: () => undefined,
		};
		const models = [...this.#modelSelectors].map(selector => {
			const first = resolveModelOverride([selector], this.registry, this.settings).model;
			const key = resolveRetryFallbackChainKey(modelContext, selector, first);
			const entries = key
				? findRetryFallbackCandidates(modelContext, key, selector, first, { allowMissingPrimary: true })
				: [];
			return { selector, targets: buildTargets([selector, ...entries.map(item => item.raw)]) };
		});
		const signature = JSON.stringify({ roles, models });
		if (force || signature !== this.#signature) {
			this.#signature = signature;
			this.#scope = { id: this.#id, revision: ++this.#revision, roles, models };
			this.registry.authStorage.governor.setRoutingScope(this.#scope);
		}
		return this.#scope;
	}

	async evaluate(
		owner: string | UsageRoutingOwner,
		sessionId: string,
		signal?: AbortSignal,
	): Promise<{ scope: UsageRoutingScope; accounts: readonly UsageRouteAccountEvaluation[] } | undefined> {
		const actualOwner: UsageRoutingOwner = typeof owner === "string" ? { kind: "role", role: owner } : owner;
		if (actualOwner.kind === "model") this.#modelSelectors.add(actualOwner.selector);
		const scope = this.refresh();
		const plan =
			actualOwner.kind === "role"
				? scope?.roles.find(item => item.role === actualOwner.role)
				: scope?.models?.find(item => item.selector === actualOwner.selector);
		if (!scope || !plan) return undefined;
		try {
			const result = await this.registry.authStorage.governor.evaluateRoutes(
				{
					scopeId: scope.id,
					revision: scope.revision,
					role: actualOwner.kind === "role" ? actualOwner.role : "",
					owner: actualOwner,
					sessionId,
					targets: plan.targets,
				},
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

	/** Rank verified cached destinations for an actual resolved source credential. */
	async candidates(
		owner: UsageRoutingOwner,
		sessionId: string,
		current: { provider: string; id: string; baseUrl?: string },
		credentialId: number | undefined,
		intent: UsageRouteIntent,
		signal?: AbortSignal,
	): Promise<UsageRouteCandidate[]> {
		const auth = this.registry.authStorage;
		const origin = auth.keys.source(current.provider);
		const selected = auth.sessions.selected(current.provider, sessionId);
		if (selected?.explicit || (origin?.kind !== "oauth" && origin?.kind !== "api_key")) return [];
		const evaluation = await this.evaluate(owner, sessionId, signal);
		const plan =
			owner.kind === "role"
				? evaluation?.scope.roles.find(item => item.role === owner.role)
				: evaluation?.scope.models?.find(item => item.selector === owner.selector);
		if (!evaluation || !plan || signal?.aborted) return [];
		const index = plan.targets.findIndex(
			target =>
				target.provider === current.provider && target.modelId === current.id && target.baseUrl === current.baseUrl,
		);
		if (index < 0) return [];
		const source = evaluation.accounts.find(
			account => account.selector === plan.targets[index].selector && account.credentialId === credentialId,
		);
		if (intent === "proactive") {
			if (
				!source ||
				source.eligibility !== "eligible" ||
				source.allowance === "unknown" ||
				source.state === "unknown" ||
				source.state === "stale"
			)
				return [];
			if (source.state === "open" && source.allowance === "included" && source.protectedFor.length === 0) return [];
		}
		const ranked = plan.targets.slice(index + 1).flatMap((target, position) => {
			const targetSource = auth.keys.source(target.provider);
			if (targetSource?.kind !== "oauth" && targetSource?.kind !== "api_key") return [];
			return evaluation.accounts.flatMap(account => {
				if (
					account.selector !== target.selector ||
					account.eligibility !== "eligible" ||
					account.allowance !== "included" ||
					account.state !== "open" ||
					account.quotaKeys.length === 0
				)
					return [];
				if (
					intent === "proactive" &&
					source?.state === "open" &&
					source.allowance === "included" &&
					(account.quotaKeys.some(key => source.quotaKeys.includes(key)) ||
						account.protectedFor.length >= source.protectedFor.length)
				)
					return [];
				return [
					{
						candidate: {
							scopeId: evaluation.scope.id,
							revision: evaluation.scope.revision,
							owner,
							target,
							credentialId: account.credentialId,
							intent,
						},
						position,
						protection: account.protectedFor.length,
						expiry: account.resetTieBreakExpiresAtMs ?? Infinity,
					},
				];
			});
		});
		ranked.sort(
			(a, b) =>
				a.protection - b.protection ||
				a.expiry - b.expiry ||
				a.position - b.position ||
				a.candidate.credentialId - b.candidate.credentialId,
		);
		return ranked.map(item => item.candidate);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#unsubscribeSettings();
		this.#disposed = true;
		this.#unsubscribe();
		if (this.#scope) this.registry.authStorage.governor.removeRoutingScope(this.#id);
	}
}
