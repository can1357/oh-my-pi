import type { ModelRegistry } from "../config/model-registry";
import { clearProviderCooldown, listProviderCooldowns } from "./provider-exhaustion";

export const PROVIDERS_USAGE = "Usage: omp providers [probe [<provider>|--all] | clear <provider>]";

/** Shared CLI/slash behavior. Listing and clearing never need credentials or the network. */
export async function providersCommand(args: string[], registry: () => Promise<ModelRegistry>): Promise<string> {
	if (args.length === 0) {
		const records = listProviderCooldowns();
		return records.length === 0
			? "No provider cooldowns."
			: [
					"provider\tclass\treason\tuntil\tnext probe\tattempts",
					...records.map(record =>
						[
							record.provider,
							record.class,
							record.reason,
							new Date(record.until).toISOString(),
							new Date(record.nextProbeAt).toISOString(),
							record.probeAttempts,
						].join("\t"),
					),
				].join("\n");
	}
	const [action, target] = args;
	if (args.length > 2 || (target?.startsWith("-") && target !== "--all")) throw new Error(PROVIDERS_USAGE);
	if (action === "clear" && target && target !== "--all") {
		const cleared = clearProviderCooldown(target);
		return `Warning: ${target}: ${cleared ? "cooldown cleared" : "no cooldown"}; availability was not probed.`;
	}
	if (action !== "probe") throw new Error(PROVIDERS_USAGE);
	const provider = target === "--all" ? undefined : target;
	const records = listProviderCooldowns().filter(
		record => !provider || record.provider.toLowerCase() === provider.toLowerCase(),
	);
	if (records.length === 0) return provider ? `${provider}: no cooldown.` : "No provider cooldowns.";
	const lines: string[] = [];
	const reported = new Set<string>();
	await (
		await registry()
	).runAvailabilityProbes({
		force: true,
		provider,
		onResult: (name, result) => {
			reported.add(name);
			const descriptions = {
				available: "available; cooldown cleared",
				unavailable: "still unavailable; cooldown retained",
				leased: "probe already leased; skipped",
				stale: "state changed during probe; newer state retained",
				auth: "authentication cooldown; re-login required",
			};
			lines.push(`${name}: ${descriptions[result]}.`);
		},
	});
	const remaining = new Set(listProviderCooldowns().map(record => record.provider));
	for (const record of records) {
		if (!reported.has(record.provider))
			lines.push(
				`${record.provider}: ${remaining.has(record.provider) ? "cooldown retained" : "cooldown cleared"}.`,
			);
	}
	return lines.join("\n");
}
