/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgSharpshooterModel = register({
	id: "sharpshooter.model",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Sharpshooter",
		label: "Sharpshooter Model",
		description: "Model selector for extraction/consolidation, empty = smol role",
	},
});

export const cfgSharpshooterIntervalMinutes = register({
	id: "sharpshooter.intervalMinutes",
	type: "number",
	default: 5,
});

export const cfgSharpshooterInjectionTokenLimit = register({
	id: "sharpshooter.injectionTokenLimit",
	type: "number",
	default: 15000,
});
