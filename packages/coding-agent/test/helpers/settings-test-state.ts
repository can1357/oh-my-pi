import { vi } from "bun:test";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests, getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";

export interface SettingsTestState {
	agentDir: string;
	env: Record<string, string | undefined>;
	projectDir: string;
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
		agentDir: getAgentDir(),
		env,
		projectDir: getProjectDir(),
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
	setAgentDir(state.agentDir);
	restoreEnvValue("PI_CODING_AGENT_DIR", state.env.PI_CODING_AGENT_DIR);
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

/** The variables `setAgentDir` rewrites: the agent dir, and the two profile variables it deletes. */
const AGENT_DIR_ENV = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/**
 * Point the agent dir, and so the session root and blob store, at `dir` until
 * `cleanup` is disposed, which restores the variables `setAgentDir` rewrites
 * and rebuilds the directory resolver from them.
 */
export function useAgentDir(cleanup: AsyncDisposableStack, dir: string): void {
	const saved = AGENT_DIR_ENV.map(key => [key, process.env[key]] as const);
	cleanup.defer(() => {
		for (const [key, value] of saved) restoreEnvValue(key, value);
		__resetDirsFromEnvForTests();
	});
	setAgentDir(dir);
}
