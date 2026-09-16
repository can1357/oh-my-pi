import { expect, it } from "bun:test";
import type { DiscoverAuthStorageOptions } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { getDbBusyTimeoutMs, setInteractiveHost } from "@oh-my-pi/pi-utils";

it("classifies an interactive host before opening auth storage", async () => {
	const previous = setInteractiveHost(false);
	const stop = new Error("stop after auth classification");
	let observedTimeout: number | undefined;
	const parsed = parseArgs([]);
	parsed.noExtensions = true;

	try {
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: async () => {
					observedTimeout = getDbBusyTimeoutMs();
					throw stop;
				},
			}),
		).rejects.toBe(stop);
	} finally {
		setInteractiveHost(previous);
	}

	expect(observedTimeout).toBe(5000);
});

it("passes effective account policies to auth storage discovery", async () => {
	const policies = [
		{
			provider: "openai-codex",
			account: { email: "protected@example.com" },
			priority: 100,
			reservePct: 25,
		},
	];
	const settings = Settings.isolated({
		"auth.accountPolicies": policies,
		"retry.usageReservePct": 17,
	});
	const stop = new Error("stop after observing auth discovery");
	let observedOptions: DiscoverAuthStorageOptions | undefined;
	const parsed = parseArgs([]);
	parsed.noExtensions = true;

	await expect(
		runRootCommand(parsed, [], {
			discoverAuthStorage: async (_agentDir, options) => {
				observedOptions = options;
				throw stop;
			},
			settings,
		}),
	).rejects.toBe(stop);

	expect(observedOptions).toEqual({
		accountPolicies: policies,
		authStorageOptions: { defaultReservePct: 17 },
	});
});
