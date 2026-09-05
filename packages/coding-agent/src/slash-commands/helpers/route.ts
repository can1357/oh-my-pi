/**
 * Implementation of `/route` slash command.
 *
 * Allows users to:
 * - View multi-provider routing status, configured pools, and provider cooldowns (`/route status`)
 * - Enable / disable dynamic multi-provider routing (`/route on`, `/route off`)
 * - Link any two models together into a pooled group (`/route pool <modelA> <modelB> [alias]`)
 * - Veto two models from ever being pooled together (`/route veto <modelA> <modelB>`)
 * - Remove a model or pool (`/route unpool <poolId-or-model>`)
 */

import { ModelsConfigFile } from "../../config/models-config";
import type { DynamicRoutingConfig, ModelPoolConfig } from "../../routing/types";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, usage } from "./parse";

export async function handleRouteSlashCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const rawArgs = command.args.trim();
	const parts = rawArgs.split(/\s+/).filter(Boolean);
	const action = (parts[0] || "status").toLowerCase();

	const configFile = ModelsConfigFile.relocate(runtime.session.modelRegistry.modelsConfigPath);
	// A command must observe edits made since registry startup, not a cached success.
	configFile.invalidate();
	const configResult = await configFile.tryLoadAsync();
	if (configResult.status === "error") {
		return usage(
			`Cannot update routing: ${configResult.error.message}. Models configuration was not changed.`,
			runtime,
		);
	}
	const currentModelsConfig = configResult.value ?? {};
	const routingConfig: DynamicRoutingConfig = currentModelsConfig.routing ?? {};

	const saveRoutingConfig = async (updated: DynamicRoutingConfig) => {
		const newModelsConfig = {
			...currentModelsConfig,
			routing: updated,
		};
		await Bun.write(configFile.path(), JSON.stringify(newModelsConfig, null, 2));
		configFile.invalidate();
		await runtime.session.modelRegistry.refresh("offline");
	};

	if (action === "status") {
		const isEnabled = !!routingConfig.enabled;
		const poolManager = runtime.session.modelRegistry.poolManager;
		const pools = routingConfig.pools ?? {};
		const vetoes = routingConfig.vetoes ?? [];
		const healthSnapshot = poolManager.getHealthSnapshot();

		const lines: string[] = [
			`=== Dynamic Multi-Provider Routing: ${isEnabled ? "ENABLED" : "DISABLED (Opt-in)"} ===`,
			`Strategy: ${routingConfig.strategy ?? "affinity-fallback (KV cache optimal)"}`,
			`Cooldown duration: ${(routingConfig.cooldownDurationMs ?? 60_000) / 1000}s`,
			"",
		];

		// Active Pools
		const poolEntries = Object.entries(pools);
		if (poolEntries.length === 0) {
			lines.push("Configured Pools: none (Dynamic equivalence is active when enabled)");
		} else {
			lines.push("Configured Pools:");
			for (const [poolId, pool] of poolEntries) {
				const statusStr = pool.enabled === false ? "[DISABLED]" : "[ACTIVE]";
				lines.push(`  • ${poolId} (${pool.name ?? poolId}) ${statusStr}`);
				lines.push(`    Strategy: ${pool.strategy ?? routingConfig.strategy ?? "affinity-fallback"}`);
				lines.push(`    Members: ${pool.members.join(", ")}`);
			}
		}

		// Vetoes
		if (vetoes.length > 0) {
			lines.push("");
			lines.push("Vetoed Pairs (Never Pooled):");
			for (const pair of vetoes) {
				lines.push(`  • ${pair[0]} ↮ ${pair[1]}`);
			}
		}

		// Provider Health / Cooldowns
		const cooling: string[] = [];
		const now = Date.now();
		for (const [targetKey, health] of healthSnapshot.entries()) {
			if (health.coolingUntil > now) {
				const remainingSec = Math.ceil((health.coolingUntil - now) / 1000);
				cooling.push(`  • ${targetKey}: cooling for ${remainingSec}s (${health.lastError ?? "rate limit"})`);
			}
		}

		if (cooling.length > 0) {
			lines.push("");
			lines.push("Active Cooldowns:");
			lines.push(...cooling);
		}

		lines.push("");
		lines.push("Commands:");
		lines.push("  /route on | off                   Toggle dynamic routing");
		lines.push("  /route pool <modelA> <modelB>     Link two models into a shared pool");
		lines.push("  /route veto <modelA> <modelB>     Prevent two models from ever pooling");
		lines.push("  /route unpool <pool-id>           Remove a configured pool");
		lines.push("  /route reset                      Clear active cooldowns");

		await runtime.output(lines.join("\n"));
		return commandConsumed();
	}

	if (action === "on") {
		await saveRoutingConfig({
			...routingConfig,
			enabled: true,
		});
		await runtime.output("Dynamic multi-provider routing is now ENABLED.");
		return commandConsumed();
	}

	if (action === "off") {
		await saveRoutingConfig({
			...routingConfig,
			enabled: false,
		});
		await runtime.output("Dynamic multi-provider routing is now DISABLED.");
		return commandConsumed();
	}

	if (action === "reset") {
		runtime.session.modelRegistry.poolManager.resetHealth();
		await runtime.output("Active provider cooldowns have been reset.");
		return commandConsumed();
	}

	if (action === "pool") {
		const modelA = parts[1];
		const modelB = parts[2];
		const poolName = parts[3];

		if (!modelA || !modelB) {
			return usage("Usage: /route pool <modelA> <modelB> [poolName]", runtime);
		}

		const poolId = poolName ?? `pool-${modelA.replace(/[/:]/g, "-")}-${modelB.replace(/[/:]/g, "-")}`;
		const currentPools = routingConfig.pools ?? {};
		const existingPool = currentPools[poolId];

		const newMembers = new Set<string>(existingPool?.members ?? []);
		newMembers.add(modelA);
		newMembers.add(modelB);

		const updatedPool: ModelPoolConfig = {
			enabled: true,
			name: poolName ?? poolId,
			strategy: existingPool?.strategy ?? routingConfig.strategy ?? "affinity-fallback",
			members: [...newMembers],
		};

		await saveRoutingConfig({
			...routingConfig,
			enabled: true, // Auto-enable routing when user explicitly creates a pool
			pools: {
				...currentPools,
				[poolId]: updatedPool,
			},
		});

		await runtime.output(
			`Linked models into pool "${poolId}":\n  • ${[...newMembers].join("\n  • ")}\nDynamic routing enabled.`,
		);
		return commandConsumed();
	}

	if (action === "veto") {
		const modelA = parts[1];
		const modelB = parts[2];
		if (!modelA || !modelB) {
			return usage("Usage: /route veto <modelA> <modelB>", runtime);
		}

		const currentVetoes = routingConfig.vetoes ?? [];
		const exists = currentVetoes.some(
			pair => (pair[0] === modelA && pair[1] === modelB) || (pair[0] === modelB && pair[1] === modelA),
		);

		if (!exists) {
			currentVetoes.push([modelA, modelB]);
			await saveRoutingConfig({
				...routingConfig,
				vetoes: currentVetoes,
			});
		}

		await runtime.output(`Veto recorded: ${modelA} will never be pooled with ${modelB}.`);
		return commandConsumed();
	}

	if (action === "unpool") {
		const target = parts[1];
		if (!target) {
			return usage("Usage: /route unpool <poolId-or-model>", runtime);
		}

		const currentPools = { ...(routingConfig.pools ?? {}) };
		if (target in currentPools) {
			delete currentPools[target];
			await saveRoutingConfig({
				...routingConfig,
				pools: currentPools,
			});
			await runtime.output(`Pool "${target}" removed.`);
			return commandConsumed();
		}

		// Also check if user passed a model to remove from any pool
		let modified = false;
		for (const pConfig of Object.values(currentPools)) {
			if (pConfig.members.includes(target)) {
				pConfig.members = pConfig.members.filter(m => m !== target);
				modified = true;
			}
		}

		if (modified) {
			await saveRoutingConfig({
				...routingConfig,
				pools: currentPools,
			});
			await runtime.output(`Model "${target}" removed from configured pools.`);
			return commandConsumed();
		}

		await runtime.output(`No pool or member found matching "${target}".`);
		return commandConsumed();
	}

	return usage("Usage: /route [status|on|off|pool|veto|unpool|reset]", runtime);
}
