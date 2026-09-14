import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getAgentDir,
	getProfileRootDir,
	removeWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreEnvValue, restoreSettingsTestState } from "./helpers/settings-test-state";

const PROFILE = "settings-test-state-profile";

describe("restoreSettingsTestState", () => {
	const originalOmpProfile = process.env.OMP_PROFILE;
	const originalPiProfile = process.env.PI_PROFILE;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let tempAgentDir = "";

	afterEach(async () => {
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		__resetDirsFromEnvForTests();
		if (tempAgentDir) {
			await removeWithRetries(tempAgentDir);
			tempAgentDir = "";
		}
	});

	// The consumer contract: a suite that overrides the agent dir under an active
	// profile must leave the profile installed for every later file in the
	// worker. `setAgentDir()` is not a restore — it forces unprofiled mode,
	// deleting both profile variables and clearing the resolver's active profile
	// — so restoring by agent-dir VALUE strands later suites on the default
	// profile with this suite's since-deleted temp dir as their agent root.
	it("reinstates an active profile that the suite's setAgentDir cleared", async () => {
		process.env.OMP_PROFILE = PROFILE;
		process.env.PI_PROFILE = PROFILE;
		delete process.env.PI_CODING_AGENT_DIR;
		__resetDirsFromEnvForTests();
		expect(getActiveProfile()).toBe(PROFILE);
		const profileAgentDir = getAgentDir();

		const state = beginSettingsTest();
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-test-state-"));
		setAgentDir(tempAgentDir);
		expect(getActiveProfile()).toBeUndefined();
		expect(process.env.OMP_PROFILE).toBeUndefined();

		restoreSettingsTestState(state);

		expect(process.env.OMP_PROFILE).toBe(PROFILE);
		expect(process.env.PI_PROFILE).toBe(PROFILE);
		expect(getActiveProfile()).toBe(PROFILE);
		expect(getAgentDir()).toBe(profileAgentDir);
		expect(profileAgentDir).toBe(path.join(getProfileRootDir(PROFILE), "agent"));
	});

	// The unprofiled counterpart: with no profile in the environment, an explicit
	// `PI_CODING_AGENT_DIR` is the baseline and must come back as the agent root,
	// not the suite's temp override.
	it("reinstates an explicit unprofiled agent dir", async () => {
		const baseline = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-test-state-baseline-"));
		try {
			delete process.env.OMP_PROFILE;
			delete process.env.PI_PROFILE;
			process.env.PI_CODING_AGENT_DIR = baseline;
			__resetDirsFromEnvForTests();

			const state = beginSettingsTest();
			tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-test-state-"));
			setAgentDir(tempAgentDir);

			restoreSettingsTestState(state);

			expect(getActiveProfile()).toBeUndefined();
			expect(getAgentDir()).toBe(baseline);
		} finally {
			await removeWithRetries(baseline);
		}
	});
});
