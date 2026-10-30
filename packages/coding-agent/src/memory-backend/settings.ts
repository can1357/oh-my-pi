/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { register } from "../config/registry";

// Memory backend selector — picks between local memories pipeline,
// Mnemopi local SQLite, Hindsight remote memory, Sharpshooter project
// decisions, or off. The legacy
// `memories.enabled` flag is migration input only; see config/settings.ts.
// Protocol hosts (RPC/ACP) start with memory off: embedders opt in through their own settings layer.
export const cfgMemoryBackend = register({
	id: "memory.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "local", "hindsight", "mnemopi", "sharpshooter"] as const,
	default: "off",
	ui: {
		tab: "memory",
		group: "General",
		label: __ompTranslate("Memory Backend"),
		description: "Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter",
		options: [
			{ value: "off", label: __ompTranslate("Off"), description: __ompTranslate("No memory subsystem runs") },
			{
				value: "local",
				label: __ompTranslate("Local"),
				description: __ompTranslate("Local rollout summarisation pipeline (memory_summary.md)"),
			},
			{
				value: "hindsight",
				label: "Hindsight",
				description: __ompTranslate("Vectorize Hindsight remote memory service"),
			},
			{
				value: "mnemopi",
				label: "Mnemopi",
				description: __ompTranslate("Local SQLite recall/retain backend with optional embeddings"),
			},
			{
				value: "sharpshooter",
				label: "Sharpshooter",
				description: __ompTranslate(
					"Friction-gated project decision files (architecture/product/style), consolidated in the background",
				),
			},
		],
	},
});
