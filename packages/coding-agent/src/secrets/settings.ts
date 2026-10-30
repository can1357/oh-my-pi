/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { effect, register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────────────

// Secret handling
export const cfgSecretsEnabled = register({
	id: "secrets.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: __ompTranslate("Hide Secrets"),
		description: "Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers",
	},
});
// Process-wide fallback for requests outside a session; a session's own requests redact per its
// settings (`withCredentialRedaction` in `sdk.ts`), whichever instance holds the effects.
effect(cfgSecretsEnabled, configureCredentialRedaction);
