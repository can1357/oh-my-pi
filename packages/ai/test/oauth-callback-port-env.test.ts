import { afterEach, describe, expect, it } from "bun:test";
import type { CompiledCallback } from "@oh-my-pi/pi-catalog/compat/types";
import { BROKER_CALLBACK_PORT_ENV, resolveCallbackOptions } from "../src/registry/engine/oauth-code";

const ENV = "PI_ANTHROPIC_OAUTH_CALLBACK_PORT";
const callback: CompiledCallback = {
	port: 54545,
	portEnv: ENV,
	path: "/callback",
	hostname: "localhost",
	portFallback: true,
	manualOnly: false,
	nativeScheme: false,
};

describe("callback port-env override", () => {
	afterEach(() => {
		delete process.env[ENV];
		delete process.env[BROKER_CALLBACK_PORT_ENV];
	});

	it("uses the rule port when unset", async () => {
		expect((await resolveCallbackOptions(callback, "anthropic")).preferredPort).toBe(54545);
	});

	it("forwards the override, including 0 for a random port", async () => {
		process.env[ENV] = "0";
		const options = await resolveCallbackOptions(callback, "anthropic");
		expect(options.preferredPort).toBe(0);
		expect(options.allowPortFallback).toBe(true);
		process.env[ENV] = "54600";
		expect((await resolveCallbackOptions(callback, "anthropic")).preferredPort).toBe(54600);
	});

	it("binds only the forwarded port even when the broker host configures a different port", async () => {
		process.env[ENV] = "54601";
		process.env[BROKER_CALLBACK_PORT_ENV] = "54600";
		expect(await resolveCallbackOptions(callback, "anthropic")).toMatchObject({
			preferredPort: 54600,
			allowPortFallback: false,
		});
	});

	it("rejects invalid ports", async () => {
		process.env[ENV] = "70000";
		await expect(resolveCallbackOptions(callback, "anthropic")).rejects.toThrow(ENV);
	});
});
