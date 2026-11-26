import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * Exercises `OmpLocal._collect_provider_keys` in agent/omp_local.py — the code
 * that decides which host env vars a task container receives in --no-gateway
 * (direct-auth) mode. The module imports `harbor`, which is only present where
 * benchmarks run, so the driver below stubs the harbor modules it touches and
 * then loads the real file.
 */

const AGENT_DIR = path.resolve(import.meta.dir, "../agent");
const PYTHON = Bun.which("python3") ?? Bun.which("python");

const DRIVER = String.raw`
import importlib.util
import json
import os
import sys
import types
import typing

if not hasattr(typing, "override"):
    typing.override = lambda fn: fn

def _identity(fn):
    return fn

mods = {}
for name in (
    "harbor",
    "harbor.agents",
    "harbor.agents.installed",
    "harbor.agents.installed.base",
    "harbor.environments",
    "harbor.environments.base",
    "harbor.environments.apple_container",
    "harbor.models",
    "harbor.models.agent",
    "harbor.models.agent.context",
    "harbor.trial",
    "harbor.trial.trial",
):
    mods[name] = types.ModuleType(name)
    sys.modules[name] = mods[name]

mods["harbor.agents.installed.base"].BaseInstalledAgent = type("BaseInstalledAgent", (), {})
mods["harbor.agents.installed.base"].with_prompt_template = _identity
mods["harbor.environments.base"].BaseEnvironment = type("BaseEnvironment", (), {})
mods["harbor.environments.apple_container"].AppleContainerEnvironment = type("AppleContainerEnvironment", (), {})
mods["harbor.models.agent.context"].AgentContext = type("AgentContext", (), {})
mods["harbor.trial.trial"].Trial = type("Trial", (), {})

# The file reads env at import time; strip it so the module and each case see
# exactly the env they set.
os.environ.clear()
spec = importlib.util.spec_from_file_location("omp_local", os.path.join(sys.argv[2], "omp_local.py"))
module = importlib.util.module_from_spec(spec)
sys.modules["omp_local"] = module
spec.loader.exec_module(module)

out = []
for case in json.loads(sys.argv[1]):
    os.environ.clear()
    os.environ.update(case.get("host", {}))
    agent = module.OmpLocal.__new__(module.OmpLocal)
    agent._forward_env = case.get("forward", {})
    out.append(module.OmpLocal._collect_provider_keys(agent, case["provider"]))
print(json.dumps(out))
`;

interface Case {
	provider: string;
	host?: Record<string, string>;
	forward?: Record<string, string>;
}

function collect(cases: Case[]): Record<string, string>[] {
	if (!PYTHON) throw new Error("python3 is required to exercise agent/omp_local.py");
	const result = Bun.spawnSync([PYTHON, "-c", DRIVER, JSON.stringify(cases), AGENT_DIR]);
	if (result.exitCode !== 0) {
		throw new Error(`python driver failed (${result.exitCode}): ${result.stderr.toString()}`);
	}
	return JSON.parse(result.stdout.toString()) as Record<string, string>[];
}

describe("OmpLocal._collect_provider_keys (direct-auth env forwarding)", () => {
	it("forwards COPILOT_GITHUB_TOKEN, not GITHUB_TOKEN, for github-copilot", () => {
		// omp reads only COPILOT_GITHUB_TOKEN for github-copilot and refuses a
		// generic GitHub token, so forwarding GITHUB_TOKEN leaves the container
		// unauthenticated.
		const [got] = collect([
			{
				provider: "github-copilot",
				host: { COPILOT_GITHUB_TOKEN: "copilot-token", GITHUB_TOKEN: "generic-token" },
			},
		]);
		expect(got).toEqual({ COPILOT_GITHUB_TOKEN: "copilot-token" });
	});

	it("forwards only the alias omp would pick for huggingface", () => {
		// omp's env fallback for huggingface is HUGGINGFACE_HUB_TOKEN then
		// HF_TOKEN (first non-blank wins, trimming whitespace); forwarding both
		// lets the shadowed token leak permissions, and spaces must not block
		// the fallback.
		const [both, fallback, whitespace] = collect([
			{
				provider: "huggingface",
				host: { HUGGINGFACE_HUB_TOKEN: "hub-token", HF_TOKEN: "hf-token" },
			},
			{
				provider: "huggingface",
				host: { HF_TOKEN: "hf-token" },
			},
			{
				provider: "huggingface",
				host: { HUGGINGFACE_HUB_TOKEN: "   ", HF_TOKEN: "hf-token" },
			},
		]);
		expect(both).toEqual({ HUGGINGFACE_HUB_TOKEN: "hub-token" });
		expect(fallback).toEqual({ HF_TOKEN: "hf-token" });
		expect(whitespace).toEqual({ HF_TOKEN: "hf-token" });
	});

	it("drops host huggingface tokens when --env supplies a non-blank credential under either name", () => {
		// --env lands in _forward_env and must win; without suppression a host
		// HUGGINGFACE_HUB_TOKEN would silently shadow --env HF_TOKEN, while
		// empty or whitespace-only --env values must not block the host token.
		const [envHf, envHub, envBlank, envWhitespace] = collect([
			{
				provider: "huggingface",
				host: { HUGGINGFACE_HUB_TOKEN: "hub-token", HF_TOKEN: "hf-token" },
				forward: { HF_TOKEN: "user-token" },
			},
			{
				provider: "huggingface",
				host: { HF_TOKEN: "hf-token" },
				forward: { HUGGINGFACE_HUB_TOKEN: "user-token" },
			},
			{
				provider: "huggingface",
				host: { HUGGINGFACE_HUB_TOKEN: "hub-token" },
				forward: { HF_TOKEN: "" },
			},
			{
				provider: "huggingface",
				host: { HUGGINGFACE_HUB_TOKEN: "hub-token" },
				forward: { HF_TOKEN: "   " },
			},
		]);
		expect(envHf).toEqual({});
		expect(envHub).toEqual({});
		expect(envBlank).toEqual({ HUGGINGFACE_HUB_TOKEN: "hub-token" });
		expect(envWhitespace).toEqual({ HUGGINGFACE_HUB_TOKEN: "hub-token" });
	});

	it("forwards only omp's winning anthropic alias, handles cleared aliases, and honors Foundry", () => {
		// omp's anthropic env hook picks ANTHROPIC_FOUNDRY_API_KEY when Foundry
		// mode is enabled, otherwise ANTHROPIC_OAUTH_TOKEN then ANTHROPIC_API_KEY.
		const [both, envOverride, oauthCleared, foundryActive, foundryNoKey, foundryDisabled] = collect([
			{
				provider: "anthropic",
				host: { ANTHROPIC_API_KEY: "api-key", ANTHROPIC_OAUTH_TOKEN: "oauth-token" },
			},
			{
				provider: "anthropic",
				host: { ANTHROPIC_OAUTH_TOKEN: "oauth-token" },
				forward: { ANTHROPIC_API_KEY: "user-key" },
			},
			{
				provider: "anthropic",
				host: { ANTHROPIC_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" },
				forward: { ANTHROPIC_OAUTH_TOKEN: "" },
			},
			{
				provider: "anthropic",
				host: { ANTHROPIC_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" },
				forward: { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_API_KEY: "foundry-key" },
			},
			{
				provider: "anthropic",
				host: { ANTHROPIC_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" },
				forward: { CLAUDE_CODE_USE_FOUNDRY: "1" },
			},
			{
				provider: "anthropic",
				host: { ANTHROPIC_OAUTH_TOKEN: "oauth-token" },
				forward: { ANTHROPIC_FOUNDRY_API_KEY: "foundry-key" },
			},
		]);
		expect(both).toEqual({ ANTHROPIC_OAUTH_TOKEN: "oauth-token" });
		expect(envOverride).toEqual({});
		expect(oauthCleared).toEqual({ ANTHROPIC_API_KEY: "api-key" });
		expect(foundryActive).toEqual({});
		expect(foundryNoKey).toEqual({ ANTHROPIC_OAUTH_TOKEN: "oauth-token" });
		expect(foundryDisabled).toEqual({ ANTHROPIC_OAUTH_TOKEN: "oauth-token" });
	});

	it("still forwards independent multi-var credentials", () => {
		const [got] = collect([
			{
				provider: "amazon-bedrock",
				host: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1" },
			},
		]);
		expect(got).toEqual({ AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1" });
	});
});
