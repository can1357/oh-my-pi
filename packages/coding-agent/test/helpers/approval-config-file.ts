import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/**
 * Settings read from a global `config.yml` under `dir` holding `data`, as a user writes it by hand: the
 * only place a `tools.approval` entry that every write refuses can live. The ambient `PI_CONFIG_FILES`
 * overlays stay out; `overrides` are runtime overrides keyed by setting id.
 */
export async function loadHandWrittenConfig(
	dir: string,
	data: Record<string, unknown>,
	overrides?: Readonly<Record<string, unknown>>,
): Promise<Settings> {
	const agentDir = path.join(dir, `hand-written-${Snowflake.next()}`);
	await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(data));
	// The constructor reads PI_CONFIG_FILES as the load starts, so it is back before any await and a
	// test file sharing this process never sees it unset.
	const ambient = process.env.PI_CONFIG_FILES;
	delete process.env.PI_CONFIG_FILES;
	let loading: Promise<Settings>;
	try {
		loading = Settings.loadReadOnly({ agentDir, cwd: dir, ...(overrides ? { overrides } : {}) });
	} finally {
		if (ambient !== undefined) process.env.PI_CONFIG_FILES = ambient;
	}
	return await loading;
}
