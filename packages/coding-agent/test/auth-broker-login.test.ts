import { afterEach, expect, it } from "bun:test";
import { BROKER_CALLBACK_PORT_ENV } from "@oh-my-pi/pi-ai/registry/engine/oauth-code";
import { remoteLoginSshArgs } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { restoreEnvValue } from "./helpers/settings-test-state";

const env = "PI_ANTHROPIC_OAUTH_CALLBACK_PORT";
const original = process.env[env];
afterEach(() => restoreEnvValue(env, original));

it.each([undefined, "54600"])("pins remote Anthropic login to the SSH forward (local override: %s)", override => {
	restoreEnvValue(env, override);
	const port = override ?? "54545";
	expect(remoteLoginSshArgs("anthropic", "user@broker")).toEqual([
		"-L",
		`${port}:127.0.0.1:${port}`,
		"-o",
		"ExitOnForwardFailure=yes",
		"user@broker",
		`env ${BROKER_CALLBACK_PORT_ENV}=${port} omp auth-broker login anthropic`,
	]);
});

it("requires a concrete port for an SSH forward", () => {
	process.env[env] = "0";
	expect(() => remoteLoginSshArgs("anthropic", "user@broker")).toThrow("choose a fixed port");
});
