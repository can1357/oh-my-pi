/**
 * Regression for #14075: `--model github-copilot/<id>` resolved against the
 * registry before the credential-scoped Copilot cache row was hydrated, so a
 * cached model absent from the bundled catalog fuzzy-matched its nearest
 * bundled sibling and the session silently ran a different model.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { COPILOT_API_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { __resetDirsFromEnvForTests, getModelDbPath, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDirRoot: string | undefined;

beforeEach(async () => {
	agentDirRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-14075-agent-dir-"));
	const agentDir = path.join(agentDirRoot, "agent");
	await fsp.mkdir(agentDir);
	setAgentDir(agentDir);
});

afterEach(async () => {
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	__resetDirsFromEnvForTests();
	if (agentDirRoot) {
		// runRootCommand and writeModelCache opened <agentDir>/models.db; Windows cannot delete an open database.
		closeModelCache();
		await fsp.rm(agentDirRoot, { recursive: true, force: true });
	}
});

it("--model resolves a cached-only Copilot model exactly instead of its bundled sibling", async () => {
	const apiKey = "ghu_test_token";
	const sibling = getBundledModel("github-copilot", "claude-fable-5");
	if (!sibling) throw new Error("Expected bundled Copilot claude-fable-5");
	// A model Copilot serves live but the bundled catalog does not know yet.
	const servedId = "claude-fable-5.5";
	expect(getBundledModel("github-copilot", servedId)).toBeUndefined();
	const served = buildModel({
		...(sibling as ModelSpec<Api>),
		id: servedId,
		name: "Claude Fable 5.5",
		headers: { ...COPILOT_API_HEADERS },
	});
	writeModelCache(
		resolveModelCacheProviderId("github-copilot", { apiKey }),
		Date.now(),
		[served],
		true,
		"",
		getModelDbPath(),
		[sibling],
		{ ...COPILOT_API_HEADERS },
	);

	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("github-copilot", apiKey);
	const rawArgs = ["--model", `github-copilot/${servedId}`, "--print", "hello"];
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = path.join(agentDirRoot ?? os.tmpdir(), "sessions");

	let observedOptions: CreateAgentSessionOptions | undefined;
	try {
		await runRootCommand(parsed, rawArgs, {
			discoverAuthStorage: async () => authStorage,
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			createAgentSession: async options => {
				observedOptions = options;
				throw new Error("stop after session options");
			},
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
	} finally {
		authStorage.close();
	}

	expect(observedOptions?.model && `${observedOptions.model.provider}/${observedOptions.model.id}`).toBe(
		`github-copilot/${servedId}`,
	);
});
