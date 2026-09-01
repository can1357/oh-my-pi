import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { invalidateCommandConfig } from "@oh-my-pi/pi-coding-agent/config/model-config-values";
import { mergeDiscoveredModel } from "@oh-my-pi/pi-coding-agent/config/model-registry";

/**
 * Regression for v15.2.4 tp- key bug: when Xiaomi `tp-` token-plan keys hit
 * discovery, models came back with `baseUrl: token-plan-sgp.xiaomimimo.com/v1`,
 * but the bundled `xiaomi/*` entries in `models.json` carry the standard
 * `api.xiaomimimo.com/v1` host. The old merge forced `existing.baseUrl` over
 * the discovered value, sending stream calls to the wrong host → 401.
 */

const STANDARD = "https://api.xiaomimimo.com/v1";
const TOKEN_PLAN = "https://token-plan-sgp.xiaomimimo.com/v1";

function bundled(baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id: "mimo-v2.5",
		name: "MiMo v2.5",
		api: "openai-completions",
		provider: "xiaomi",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

describe("mergeDiscoveredModel", () => {
	test("prefers discovered baseUrl over bundled baseUrl (xiaomi tp- regression)", () => {
		const discovered = bundled(TOKEN_PLAN);
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing);
		expect(merged.baseUrl).toBe(TOKEN_PLAN);
	});

	test("falls back to existing baseUrl when discovery did not supply one", () => {
		const discovered = { ...bundled(STANDARD), baseUrl: undefined as unknown as string };
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing);
		expect(merged.baseUrl).toBe(STANDARD);
	});

	test("merges headers: existing first, discovered overrides per-key", () => {
		const discovered: Model<"openai-completions"> = {
			...bundled(TOKEN_PLAN),
			headers: { "x-tp": "1", "x-shared": "discovered" },
		};
		const existing: Model<"openai-completions"> = {
			...bundled(STANDARD),
			headers: { "x-bundled": "1", "x-shared": "existing" },
		};
		const merged = mergeDiscoveredModel(discovered, existing);
		expect(merged.headers).toEqual({
			"x-bundled": "1",
			"x-shared": "discovered",
			"x-tp": "1",
		});
	});

	test("provider override path: override baseUrl wins when no bundled entry", () => {
		const discovered = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, undefined, { baseUrl: TOKEN_PLAN });
		expect(merged.baseUrl).toBe(TOKEN_PLAN);
	});

	test("user providerOverride baseUrl wins over discovered baseUrl even when bundled entry exists", () => {
		const discovered = bundled(STANDARD);
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing, { baseUrl: "https://my-proxy.example.com/v1" });
		expect(merged.baseUrl).toBe("https://my-proxy.example.com/v1");
	});

	test("preserves provider override transport on rediscovery (#2555 openrouter gateway regression)", () => {
		// Bundled openrouter entry carries transport=pi-native after
		// applying providerOverride at boot (#loadBuiltInModels). Discovery
		// refetched the same model from /v1/models — provider catalogs
		// never set transport in defaults, so the discovered model has no
		// transport hint of its own.
		const existing: Model<"openai-completions"> = {
			...bundled("http://localhost:4000"),
			transport: "pi-native",
			headers: { Authorization: "Bearer gateway-token" },
		};
		const discovered = bundled("http://localhost:4000");
		const merged = mergeDiscoveredModel(discovered, existing, {
			baseUrl: "http://localhost:4000",
			transport: "pi-native",
			headers: { Authorization: "Bearer gateway-token" },
		});
		expect(merged.transport).toBe("pi-native");
		expect(merged.baseUrl).toBe("http://localhost:4000");
		expect(merged.headers).toEqual({ Authorization: "Bearer gateway-token" });
	});

	test("provider override path (no bundled entry): transport flows through", () => {
		const discovered = bundled("http://localhost:4000");
		const merged = mergeDiscoveredModel(discovered, undefined, {
			baseUrl: "http://localhost:4000",
			transport: "pi-native",
		});
		expect(merged.transport).toBe("pi-native");
	});

	test("returns model untouched when no existing entry and no override", () => {
		const discovered = bundled(TOKEN_PLAN);
		const merged = mergeDiscoveredModel(discovered, undefined);
		expect(merged).toEqual(discovered);
	});

	test("resolves provider-override `!command` headers on the inference path (#10457)", () => {
		const discovered = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, undefined, {
			headers: { "X-Project-Id": "!echo resolved-value" },
		});
		// Discovery providers previously carried the raw `!command` literal into
		// the model's headers, leaking it verbatim to the upstream server.
		expect(merged.headers?.["X-Project-Id"]).toBe("resolved-value");
	});

	test("resolves `!command` headers merged from a bundled entry (#10457)", () => {
		const discovered = bundled(STANDARD);
		const existing: Model<"openai-completions"> = {
			...bundled(STANDARD),
			headers: { "X-Project-Id": "!echo resolved-value" },
		};
		const merged = mergeDiscoveredModel(discovered, existing);
		expect(merged.headers?.["X-Project-Id"]).toBe("resolved-value");
	});

	test("raw provider `!command` headers win over the discovery snapshot and re-resolve on rotation (#10458)", async () => {
		const tokenFile = path.join(os.tmpdir(), `omp-rot-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
		// Cross-platform + space-safe: re-invoke the running Bun to print the
		// token file's contents. All paths are JSON-quoted so a temp dir with
		// spaces survives both `/bin/sh -c` and `cmd.exe /c`, and the eval body
		// carries no double quotes of its own.
		const readScript = "process.stdout.write(await Bun.file(Bun.argv[1]).text())";
		const command = `!${JSON.stringify(process.execPath)} -e "${readScript}" ${JSON.stringify(tokenFile)}`;
		await Bun.write(tokenFile, "token-A");
		try {
			// The discovered model carries the discovery-time resolved snapshot,
			// and the existing entry stands in for a prior-merge value — either
			// would shadow the live provider header if ordered last.
			const discovered: Model<"openai-completions"> = {
				...bundled(STANDARD),
				headers: { "X-Token": "stale-snapshot" },
			};
			const existing: Model<"openai-completions"> = {
				...bundled(STANDARD),
				headers: { "X-Token": "stale-snapshot" },
			};
			const merged = mergeDiscoveredModel(discovered, existing, { headers: { "X-Token": command } });
			// Raw provider header wins over the discovery snapshot...
			expect(merged.headers?.["X-Token"]).toBe("token-A");
			// ...and a 401 auth-retry rotation (cache invalidation) reaches it.
			await Bun.write(tokenFile, "token-B");
			invalidateCommandConfig(command);
			expect(merged.headers?.["X-Token"]).toBe("token-B");
		} finally {
			invalidateCommandConfig(command);
			await fs.rm(tokenFile, { force: true });
		}
	});
});
