import { afterEach, describe, expect, it } from "bun:test";
import { modelApiKeyCredential, modelHeaderCommandGenerations } from "@oh-my-pi/pi-catalog/types";
import {
	createConfigHeaderResolver,
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
	invalidateCommandGeneration,
	resolveConfigHeaders,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";

const TEMP_ENV_KEYS: string[] = [];

function setEnv(key: string, value: string): void {
	TEMP_ENV_KEYS.push(key);
	process.env[key] = value;
}

function delayedValueCommand(value: string): string {
	if (process.platform !== "win32") return `!sleep 0.15; printf %s ${JSON.stringify(value)}`;
	return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
		`setTimeout(() => process.stdout.write(${JSON.stringify(value)}), 150)`,
	)}`;
}

afterEach(() => {
	for (const key of TEMP_ENV_KEYS.splice(0)) delete process.env[key];
	invalidateAllCommandConfigs();
});

describe("async config header materialization", () => {
	it("cancels while a header source remains pending instead of returning missing headers", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<Record<string, string>>();
		const resolver = createConfigHeaderResolver([
			async () => {
				started.resolve();
				return release.promise;
			},
		]);
		if (!resolver) throw new Error("Expected a header resolver");
		const controller = new AbortController();
		const pending = resolver(controller.signal);
		try {
			await started.promise;
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			release.resolve({ Authorization: "too late" });
		}
	});

	it("merges nested resolvers with later sources taking precedence", async () => {
		const inner = createConfigHeaderResolver([{ "X-Tenant": "old", "X-Keep": "k" }]);
		const outer = createConfigHeaderResolver([inner, { "X-Tenant": "new" }]);

		expect(await outer?.()).toEqual({ "X-Tenant": "new", "X-Keep": "k" });
	});

	it("applies authHeader after explicit sources", async () => {
		setEnv("OMP_TEST_LIVE_KEY", "sekret");
		const resolver = createConfigHeaderResolver([{ Authorization: "wrong", "X-Keep": "k" }], {
			authHeader: true,
			apiKeyConfig: "OMP_TEST_LIVE_KEY",
		});

		expect(await resolver?.()).toEqual({ Authorization: "Bearer sekret", "X-Keep": "k" });
	});

	it("carries the derived API key and its generation through nested composition", async () => {
		const inner = createConfigHeaderResolver([], {
			authHeader: true,
			apiKeyConfig: "!printf %s test-a",
		});
		const outer = createConfigHeaderResolver([inner, { "X-Keep": "test-value" }]);
		const headers = await outer?.();
		expect(headers?.Authorization).toBe("Bearer test-a");
		expect(headers?.["X-Keep"]).toBe("test-value");
		expect(headers?.[modelApiKeyCredential]).toEqual({ apiKey: "test-a", credentialGeneration: 1 });
	});

	it.each(["Authorization", "authorization", "AUTHORIZATION"])(
		"drops API-key provenance when a later %s header replaces the derived key",
		async header => {
			const inner = createConfigHeaderResolver([], {
				authHeader: true,
				apiKeyConfig: "!printf %s test-b",
			});
			const outer = createConfigHeaderResolver([inner, { [header]: "Bearer test-c" }]);
			const headers = await outer?.();
			expect(headers?.[header]).toBe("Bearer test-c");
			expect(headers?.[modelApiKeyCredential]).toBeUndefined();
		},
	);

	it("does not claim a derived API key when Authorization has case-duplicate values", async () => {
		const resolver = createConfigHeaderResolver([{ authorization: "Bearer test-c" }], {
			authHeader: true,
			apiKeyConfig: "!printf %s test-d",
		});
		const headers = await resolver?.();
		expect(headers?.authorization).toBe("Bearer test-c");
		expect(headers?.Authorization).toBe("Bearer test-d");
		expect(headers?.[modelApiKeyCredential]).toBeUndefined();
	});

	it("reads environment-backed values for every request", async () => {
		setEnv("OMP_TEST_LIVE_DYN", "v1");
		const resolver = createConfigHeaderResolver([{ "X-Dyn": "OMP_TEST_LIVE_DYN" }]);

		expect((await resolver?.())?.["X-Dyn"]).toBe("v1");
		setEnv("OMP_TEST_LIVE_DYN", "v2");
		expect((await resolver?.())?.["X-Dyn"]).toBe("v2");
	});

	it("does not block timers while a command-backed header resolves", async () => {
		const resolver = createConfigHeaderResolver([{ Authorization: delayedValueCommand("token") }]);
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
		}, 20);

		const pending = resolver?.();
		// Real time is intentional: fake timers cannot detect event-loop blocking
		// by a synchronous child-process API, which is the regression under test.
		await Bun.sleep(50);
		expect(timerFired).toBe(true);
		expect(await pending).toEqual({ Authorization: "token" });
		clearTimeout(timer);
	});

	it("resolves a deeply composed parent-child chain once per layer", async () => {
		const depth = 64;
		let baseReads = 0;
		const base = async (): Promise<Record<string, string>> => {
			baseReads++;
			return { "X-Base": "b" };
		};
		let resolver = createConfigHeaderResolver([base]);
		for (let i = 0; i < depth; i++) {
			resolver = createConfigHeaderResolver([resolver, { [`X-L${i}`]: String(i) }]);
		}

		const headers = await resolver?.();
		expect(Object.keys(headers ?? {})).toHaveLength(depth + 1);
		expect(headers?.["X-Base"]).toBe("b");
		expect(headers?.[`X-L${depth - 1}`]).toBe(String(depth - 1));
		expect(baseReads).toBe(1);
	});

	it("invalidates only the normalized command generation that materialized a header", async () => {
		const config = "!  printf %s test-exact-header  ";
		const first = await resolveConfigHeaders({ "X-Test": config });
		const sent = first?.[modelHeaderCommandGenerations]?.["X-Test"];
		expect(sent).toEqual({ command: "printf %s test-exact-header", generation: 1 });
		if (!sent) throw new Error("Expected sent command generation");
		invalidateCommandGeneration(sent);
		const next = await resolveConfigHeaders({ "X-Test": "!printf %s test-exact-header" });
		expect(next?.["X-Test"]).toBe("test-exact-header");
		expect(next?.[modelHeaderCommandGenerations]?.["X-Test"].generation).toBe(2);
	});

	it("preserves a newer command generation even when both mints return identical bytes", async () => {
		const config = "!printf %s test-identical-header";
		const first = await resolveConfigHeaders({ "X-Test": config });
		const sent = first?.[modelHeaderCommandGenerations]?.["X-Test"];
		if (!sent) throw new Error("Expected sent command generation");
		invalidateCommandConfig(config);
		const replacement = await resolveConfigHeaders({ "X-Test": config });
		expect(replacement?.["X-Test"]).toBe(first?.["X-Test"]);
		expect(replacement?.[modelHeaderCommandGenerations]?.["X-Test"].generation).toBe(2);
		invalidateCommandGeneration(sent);
		const retained = await resolveConfigHeaders({ "X-Test": config });
		expect(retained?.[modelHeaderCommandGenerations]?.["X-Test"].generation).toBe(2);
	});

	it("does not cross-invalidate distinct commands that issue equal header bytes", async () => {
		const a = "!printf %s test-shared-header-bytes";
		const b = "!printf %s test-shared-header-bytes; :";
		const first = await resolveConfigHeaders({ "X-A": a, "X-B": b });
		expect(first?.["X-A"]).toBe(first?.["X-B"]);
		const sent = first?.[modelHeaderCommandGenerations]?.["X-B"];
		if (!sent) throw new Error("Expected sent command generation");
		invalidateCommandGeneration(sent);
		const next = await resolveConfigHeaders({ "X-A": a, "X-B": b });
		expect(next?.[modelHeaderCommandGenerations]?.["X-A"].generation).toBe(1);
		expect(next?.[modelHeaderCommandGenerations]?.["X-B"].generation).toBe(2);
	});

	it("does not discard a replacement mint still pending when an old header is refused", async () => {
		const config = delayedValueCommand("test-pending-header");
		const first = await resolveConfigHeaders({ "X-Test": config });
		const sent = first?.[modelHeaderCommandGenerations]?.["X-Test"];
		if (!sent) throw new Error("Expected sent command generation");
		invalidateCommandConfig(config);
		const pending = resolveConfigHeaders({ "X-Test": config });
		invalidateCommandGeneration(sent);
		const replacement = await pending;
		expect(replacement?.[modelHeaderCommandGenerations]?.["X-Test"].generation).toBe(2);
		const retained = await resolveConfigHeaders({ "X-Test": config });
		expect(retained?.[modelHeaderCommandGenerations]?.["X-Test"].generation).toBe(2);
	});

	it.each([false, true])(
		"invalidates without a positive observation, including an empty snapshot: %s",
		async empty => {
			const config = `!printf %s test-snapshot-${empty ? "empty" : "unknown"}`;
			await resolveConfigHeaders({ "X-Test": config });
			invalidateCommandConfig(config, undefined, empty ? [] : undefined);
			const next = await resolveConfigHeaders({ "X-Test": config });
			expect(next?.[modelHeaderCommandGenerations]?.["X-Test"].generation).toBe(2);
		},
	);

	it("does not treat another command's positive observation as proof of omission", async () => {
		const a = "!printf %s test-unobserved-command";
		const b = "!printf %s test-observed-command";
		const first = await resolveConfigHeaders({ "X-A": a, "X-B": b });
		const observed = first?.[modelHeaderCommandGenerations]?.["X-B"];
		if (!observed) throw new Error("Expected a positive observation");
		invalidateCommandConfig(a, undefined, [observed]);
		invalidateCommandConfig(b, undefined, [observed]);
		const next = await resolveConfigHeaders({ "X-A": a, "X-B": b });
		expect(next?.[modelHeaderCommandGenerations]?.["X-A"].generation).toBe(2);
		expect(next?.[modelHeaderCommandGenerations]?.["X-B"].generation).toBe(2);
	});

	it("does not invent command generations from prototype header names", async () => {
		const literalHeaders = {
			constructor: "test-constructor",
			toString: "test-to-string",
			hasOwnProperty: "test-own",
		};
		const inner = createConfigHeaderResolver([literalHeaders]);
		const outer = createConfigHeaderResolver([inner]);
		const headers = await outer?.();
		expect(headers).toEqual(literalHeaders);
		expect(Object.keys(headers?.[modelHeaderCommandGenerations] ?? {})).toEqual([]);
	});

	it("retains only positive command observations through opaque composition", async () => {
		const config = "!printf %s test-composed-header";
		const inner = createConfigHeaderResolver([{ "X-Test": config, "X-Shared": config }]);
		const outer = createConfigHeaderResolver([inner, async () => ({ "X-Test": "test-composed-header" })]);
		const headers = await outer?.();
		expect(headers?.["X-Test"]).toBe("test-composed-header");
		expect(headers?.[modelHeaderCommandGenerations]).toEqual({
			"X-Shared": { command: "printf %s test-composed-header", generation: 1 },
		});
		expect(Object.keys(headers ?? {})).toEqual(["X-Test", "X-Shared"]);
		expect(JSON.stringify(headers)).toBe('{"X-Test":"test-composed-header","X-Shared":"test-composed-header"}');
	});

	it("does not infer command generations from environment values or literal command-looking bytes", async () => {
		setEnv("OMP_TEST_HEADER_COMMAND_BYTES", "!printf %s test-not-a-command");
		const headers = await resolveConfigHeaders({ "X-Test": "OMP_TEST_HEADER_COMMAND_BYTES" });
		expect(headers?.["X-Test"]).toBe("!printf %s test-not-a-command");
		expect(headers?.[modelHeaderCommandGenerations]).toBeUndefined();
	});

	it("records only the authHeader command that replaced an explicit Authorization command", async () => {
		const resolver = createConfigHeaderResolver([{ Authorization: "!printf %s test-overwritten-header" }], {
			authHeader: true,
			apiKeyConfig: "!printf %s test-derived-header",
		});
		const headers = await resolver?.();
		expect(headers?.Authorization).toBe("Bearer test-derived-header");
		expect(headers?.[modelHeaderCommandGenerations]).toEqual({
			Authorization: { command: "printf %s test-derived-header", generation: 1 },
		});
	});
});
