/**
 * Runs `omp token` or `omp usage` in-process while an OUTER settings instance drives
 * effects with a 30 s `!command` limit and the command's own agent dir says 0.2 s.
 *
 * Settings that drive effects win over an operation's own scope, so a command that
 * does not bind its own settings runs the broker-token helper under the outer 30 s
 * limit instead of the user's 0.2 s. Whether the helper finishes decides whether the
 * broker is contacted at all, which the caller counts.
 */
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import Token from "@oh-my-pi/pi-coding-agent/commands/token";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import "@oh-my-pi/pi-coding-agent/session/settings";

const mode = process.argv[2];
const releaseOuter = bindEffects(Settings.isolated({ "providers.commandTimeoutSeconds": 30 }));
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
releaseOuter();
process.stdout.write(`${JSON.stringify({ error })}\n`);
