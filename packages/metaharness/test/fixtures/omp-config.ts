import * as path from "node:path";
import type { ConsumerRequest, ConsumerResult } from "./omp-config-consumer";

const CONSUMER = path.join(import.meta.dir, "omp-config-consumer.ts");

/**
 * Resolve `<home>/.omp/agent` with omp's own config readers, in a separate process whose
 * environment is `env` plus `HOME` — the environment a harness hands the omp it launches.
 */
export async function consumeOmpConfig(
	home: string,
	providers: string[],
	env: Record<string, string>,
): Promise<ConsumerResult> {
	const request: ConsumerRequest = { agentDir: path.join(home, ".omp", "agent"), providers };
	const child = Bun.spawn([process.execPath, CONSUMER, JSON.stringify(request)], {
		cwd: home,
		env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", TMPDIR: Bun.env.TMPDIR ?? "/tmp", ...env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`omp config consumer exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout) as ConsumerResult;
}

/**
 * Hostile values for one marker path. Each, if any reader treats it as code — a shell that
 * reads it as script text, or an omp config value that starts with `!` — writes `marker`.
 */
export function hostileValues(marker: string) {
	const command = `printf PWNED > ${marker}`;
	return {
		/** A `!` command inside YAML quotes: raw interpolation makes it a quoted `apiKey`. */
		quotedCommand: `'!${command}; printf resolved-token'`,
		/** A bare `!` command: what omp runs even from a correctly serialized `apiKey`. */
		bareCommand: `!${command}; printf resolved-token`,
		/** Ends a `<<'<delimiter>'` heredoc, runs the command, then reopens the heredoc. */
		heredoc: (prefix: string, delimiter: string) => `${prefix}\n${delimiter}\n${command}\n: <<'${delimiter}' #`,
		/** A provider id that, interpolated as a YAML key, adds a command `apiKey` to `openrouter`. */
		providerWithApiKey: `openrouter:\n    apiKey: '!${command}; printf injected-key'\n  innocuous`,
		/** A gateway URL that, interpolated as a YAML value, adds a command header. */
		urlWithHeader: `http://gateway.test\n    headers:\n      X-Review: '!${command}; printf injected-header'`,
	};
}
