/**
 * Share a saved session as an encrypted link without launching the agent.
 *
 * `omp share <session>` accepts a session id (prefix) or a path to a session
 * `.jsonl` and uploads the sealed snapshot exactly like the `/share` slash
 * command, honoring `share.serverUrl`, `share.store`, and
 * `share.redactSecrets`.
 */

import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { shareHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { shareSession } from "../export/share";
import { buildSecretObfuscator } from "../secrets";
import { resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";

export default class Share extends Command {
	static description = commandHelp.description;
	static args = {
		session: Args.string({
			description: "Session id (prefix) or path to a session .jsonl",
			required: true,
		}),
	};
	static flags = {
		gist: Flags.boolean({
			description: "Upload to a secret GitHub gist instead of the share server",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Share);

		const sessionArg = args.session ?? "";
		let sessionPath = sessionArg;
		if (!sessionArg.includes("/") && !sessionArg.includes("\\") && !sessionArg.endsWith(".jsonl")) {
			const match = await resolveResumableSession(sessionArg, process.cwd());
			if (!match) {
				process.stderr.write(`Session "${sessionArg}" not found.\n`);
				process.exitCode = 1;
				return;
			}
			sessionPath = match.session.path;
		}

		const sm = await SessionManager.open(sessionPath);
		// Settings resolve against the session's own project so its
		// share.redactSecrets/secrets.enabled policy governs, not the invoking cwd's.
		const settings = await Settings.loadReadOnly({ cwd: sm.getCwd() });
		// Same leak boundary as /share: a share blob leaves the machine, so honor
		// share.redactSecrets with the full obfuscator built against the session's
		// own project directory (its secrets.yml, not the invoking cwd's).
		const obfuscator =
			settings.get("share.redactSecrets") && settings.get("secrets.enabled")
				? await buildSecretObfuscator(sm.getCwd(), getAgentDir())
				: undefined;

		const result = await shareSession(sm, {
			serverUrl: settings.get("share.serverUrl"),
			store: flags.gist ? "gist" : settings.get("share.store"),
			obfuscator,
		});
		const lines = [`Share URL: ${result.url}`];
		if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
		if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
		console.log(lines.join("\n"));
	}
}
