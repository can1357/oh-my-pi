/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_STREAM_URL } from "@oh-my-pi/pi-wire";

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
const EMPTY_STRING_ARRAY: string[] = [];

// Live streaming (omp stream)
export const cfgStreamServerUrl = register({
	id: "stream.serverUrl",
	type: "string",
	default: DEFAULT_STREAM_URL,
	ui: {
		tab: "interaction",
		group: "Stream",
		label: "Stream Server",
		description:
			"Live stream server used by `omp stream` (https://host[:port]); viewers watch at <base>/<your Stencil username>",
	},
});

export const cfgStreamRedactPatterns = register({
	id: "stream.redactPatterns",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Stream",
		label: "Extra Redaction Patterns",
		description:
			"Additional regular expressions redacted from every streamed row, on top of env/secrets.yml values and built-in credential shapes",
	},
});
