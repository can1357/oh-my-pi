import * as os from "node:os";
import * as path from "node:path";

/** Paths to Claude Code's user data and configuration file. */
export interface ClaudePaths {
	configDir: string;
	configFile: string;
}

/** Resolves Claude Code's user paths, honoring `CLAUDE_CONFIG_DIR` in `env`. */
export function resolveClaudePaths(
	home: string = os.homedir(),
	env: Readonly<Record<string, string | undefined>> = process.env,
): ClaudePaths {
	const override = env.CLAUDE_CONFIG_DIR?.trim();
	if (override) {
		const configDir = path.resolve(override);
		return { configDir, configFile: path.join(configDir, ".claude.json") };
	}
	return { configDir: path.join(home, ".claude"), configFile: path.join(home, ".claude.json") };
}
