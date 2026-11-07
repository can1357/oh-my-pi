/**
 * Runs `omp token` or `omp usage` in-process while an outer settings instance drives
 * effects, with credential discovery failing against the auth broker named by
 * OMP_AUTH_BROKER_URL. Prints whether the outer instance drives effects again and
 * what a `!command` that needs about 1 s resolves to afterwards.
 */
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import Token from "@oh-my-pi/pi-coding-agent/commands/token";
import { bindEffects, effectsSettings } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import "@oh-my-pi/pi-coding-agent/session/settings";

const mode = process.argv[2];
const outer = Settings.isolated({ "providers.commandTimeoutSeconds": 30 });
const releaseOuter = bindEffects(outer);
let error: string | undefined;
try {
	if (mode === "usage") {
		await runUsageCommand({ action: "invalidate" });
	} else {
		await new Token(["custom-proxy"], { bin: "omp", version: "test", commands: new Map() }).run();
	}
} catch (caught) {
	error = String(caught);
}
const restored = effectsSettings() === outer;
const value = await resolveConfigValue("!sleep 1; printf %s after-command");
releaseOuter();
process.stdout.write(`${JSON.stringify({ error, restored, value })}\n`);
