import { vi } from "bun:test";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isTuiTight, setTuiTight } from "@oh-my-pi/pi-tui";
import { __resetDirsFromEnvForTests, getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

export interface SettingsTestState {
	env: Record<string, string | undefined>;
	projectDir: string;
	tuiTight: boolean;
}

export function beginSettingsTest(): SettingsTestState {
	const env: Record<string, string | undefined> = {};
	for (const key in process.env) {
		env[key] = process.env[key];
	}
	for (const key in Bun.env) {
		env[key] = Bun.env[key];
	}
	const state: SettingsTestState = {
		env,
		projectDir: getProjectDir(),
		tuiTight: isTuiTight(),
	};
	resetSettingsForTest();
	return state;
}

export function restoreSettingsTestState(state: SettingsTestState | undefined): void {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (!state) return;

	restoreEnv(state.env);
	setProjectDir(state.projectDir);
	// The agent dir is rebuilt from the restored environment rather than
	// re-installed by value. `setAgentDir()` is not a restore: it forces default
	// (unprofiled) mode, DELETING `OMP_PROFILE`/`PI_PROFILE` and clearing the
	// active profile. A suite that ran under a profile would have that profile
	// stripped here after the env restore had already put it back, leaking
	// profile-less resolution into every later file in the worker. Resolving
	// from the env instead reproduces whichever mode the snapshot was taken in —
	// profile, explicit `PI_CODING_AGENT_DIR`, or plain default — and rebuilds
	// the resolver's own profile state to match.
	__resetDirsFromEnvForTests();
	setTuiTight(state.tuiTight);
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
	for (const key in process.env) {
		if (!(key in snapshot)) {
			restoreEnvValue(key, undefined);
		}
	}
	for (const key in Bun.env) {
		if (!(key in snapshot)) {
			restoreEnvValue(key, undefined);
		}
	}
	for (const key in snapshot) {
		restoreEnvValue(key, snapshot[key]);
	}
}

/** Restores an environment variable without coercing an absent value to `"undefined"`. */
export function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}
