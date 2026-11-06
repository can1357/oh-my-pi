import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import * as streams from "@oh-my-pi/pi-ai/stream";
import { ModelRegistry } from "../src/config/model-registry";
import {
	findInitialModel,
	restoreModelFromSession,
	resolveCliModel,
	resolveSessionModelSelector,
	resolveModelOverride,
} from "../src/config/model-resolver";
import { resolveSharpshooterModel } from "../src/sharpshooter/extract";
import { Settings } from "../src/config/settings";
import { validateRetryFallbackChains } from "../src/session/retry-fallback-chains";
import { AuthStorage } from "../src/session/auth-storage";
import * as availability from "../src/session/provider-exhaustion";
import { probeProviderInference } from "../src/session/provider-availability-probe";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const action of cleanup.splice(0).reverse()) action();
});

async function fixture() {
	const directory = TempDir.createSync("availability-registry-");
	cleanup.push(() => directory.removeSync());
	const auth = await AuthStorage.create(":memory:");
	cleanup.push(() => auth.close());
	await auth.credentials.set("openai", { type: "api_key", key: "fixture-key" });
	const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
	cleanup.push(() => registry.stopAvailabilityMonitoring());
	return { auth, registry, directory };
}

describe("registry provider availability", () => {
	test("blocked provider stays in catalog but leaves both selection enumerations and ordered overrides", async () => {
		const { registry } = await fixture();
		const blocked = spyOn(availability, "isProviderExhausted").mockImplementation(provider => provider === "openai");
		cleanup.push(() => blocked.mockRestore());
		expect(registry.find("openai", "gpt-5-mini")?.id).toBe("gpt-5-mini");
		expect(registry.getAvailableForProviders(new Set(["openai"]))).toEqual([]);
		expect(registry.getAvailable().some(model => model.provider === "openai")).toBe(false);
		expect(resolveModelOverride(["openai/gpt-5-mini"], registry).model).toBeUndefined();
		blocked.mockReturnValue(false);
		expect(resolveModelOverride(["openai/gpt-5-mini"], registry).model?.id).toBe("gpt-5-mini");
	});

	test("CLI roles, saved defaults, scoped rows and resume cannot revive an exhausted catalog entry", async () => {
		const { registry } = await fixture();
		const blocked = spyOn(availability, "isProviderExhausted").mockImplementation(provider => provider === "openai");
		cleanup.push(() => blocked.mockRestore());
		const model = registry.find("openai", "gpt-5-mini")!;
		const settings = Settings.isolated({ modelRoles: { auditor: "openai/gpt-5-mini" } });
		for (const selector of ["openai/gpt-5-mini", "@auditor"]) {
			expect(resolveCliModel({ cliModel: selector, modelRegistry: registry, settings }).model).toBeUndefined();
		}
		expect(
			(
				await findInitialModel({
					scopedModels: [{ model, explicitThinkingLevel: false }],
					isContinuing: false,
					defaultProvider: "openai",
					defaultModelId: model.id,
					modelRegistry: registry,
				})
			).model,
		).toBeUndefined();
		expect((await restoreModelFromSession("openai", model.id, model, false, registry)).model).toBeUndefined();
		expect(resolveSessionModelSelector(registry, "openai/gpt-5-mini")).toBeUndefined();
		expect(
			await resolveSharpshooterModel(
				Settings.isolated({ "sharpshooter.model": "openai/gpt-5-mini", modelRoles: { smol: "openai/gpt-5-mini" } }),
				registry,
			),
		).toBeUndefined();
		blocked.mockReturnValue(false);
		expect(resolveCliModel({ cliModel: "@auditor", modelRegistry: registry, settings }).model?.id).toBe(model.id);
		expect(
			(
				await findInitialModel({
					scopedModels: [],
					isContinuing: false,
					defaultProvider: "openai",
					defaultModelId: model.id,
					modelRegistry: registry,
				})
			).model?.id,
		).toBe(model.id);
	});

	test("recovery inference bypasses unavailable enumeration and rejects failed completion", async () => {
		const { registry } = await fixture();
		const blocked = spyOn(availability, "isProviderExhausted").mockReturnValue(true);
		cleanup.push(() => blocked.mockRestore());
		const complete = spyOn(streams, "completeSimple").mockResolvedValue({ stopReason: "error" } as never);
		cleanup.push(() => complete.mockRestore());
		expect(registry.getAvailableForProviders(new Set(["openai"]))).toEqual([]);
		expect(await probeProviderInference(registry, "openai")).toBe(false);
		expect(complete.mock.calls[0]?.[0].provider).toBe("openai");
		expect(complete.mock.calls[0]?.[2]?.maxTokens).toBe(1);
		complete.mockResolvedValue({ stopReason: "stop" } as never);
		expect(await probeProviderInference(registry, "openai")).toBe(true);
	});

	test("only a replaced credential triggers auth recovery, without changing preferred model identity", async () => {
		const { auth, registry } = await fixture();
		const clear = spyOn(availability, "clearProviderAuthOnCredentialChange").mockImplementation(() => {});
		const probe = spyOn(availability, "probeUnavailableProviders").mockResolvedValue();
		const gate = spyOn(availability, "isProviderExhausted").mockReturnValue(false);
		cleanup.push(
			() => gate.mockRestore(),
			() => clear.mockRestore(),
			() => probe.mockRestore(),
		);
		await registry.runAvailabilityProbes();
		expect(clear).not.toHaveBeenCalled();
		await auth.credentials.set("openai", { type: "api_key", key: "replaced-key" });
		await registry.runAvailabilityProbes();
		expect(clear).toHaveBeenCalledWith("openai", registry.providerCredentialVersion("openai"));
		expect(registry.find("openai", "gpt-5-mini")?.id).toBe("gpt-5-mini");
	});

	test.each(["runtime", "config"] as const)(
		"a changed %s override restores selection while the rejected key stays unavailable",
		async source => {
			const { auth, registry } = await fixture();
			const model = registry.find("openai", "gpt-5-mini")!;
			const setKey = (key: string) => {
				if (source === "runtime") auth.keys.setRuntime("openai", key);
				else auth.keys.setConfig("openai", key);
			};
			setKey("rejected-key");
			await registry.getApiKey(model);
			availability.recordProviderFailure("openai", {
				status: 401,
				credentialVersion: registry.providerCredentialVersion("openai"),
			});
			cleanup.push(() => availability.clearProviderAuthOnCredentialChange("openai", "test-cleanup"));
			await registry.runAvailabilityProbes();
			expect(registry.getAvailableForProviders(new Set(["openai"]))).toEqual([]);
			setKey("replacement-key");
			await registry.runAvailabilityProbes();
			expect(resolveModelOverride(["openai/gpt-5-mini"], registry).model?.id).toBe("gpt-5-mini");
		},
	);

	test("failed discovery retains known membership and requires catalog recovery rather than chat success", async () => {
		const { auth, directory } = await fixture();
		const configPath = path.join(directory.path(), "discovery.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				providers: {
					"fixture-discovery": {
						api: "openai-completions",
						baseUrl: "https://fixture.invalid/v1",
						apiKey: "fixture",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		let fails = true;
		let blocked = false;
		const clear = spyOn(availability, "clearProviderAuthOnCredentialChange").mockImplementation(() => {});
		cleanup.push(() => clear.mockRestore());
		const registry = new ModelRegistry(auth, configPath, {
			fetch: async () => {
				if (fails) throw new TypeError("fixture transport unavailable");
				return Response.json({ data: [{ id: "retained-model" }] });
			},
		});
		const record = spyOn(availability, "recordProviderFailure").mockImplementation((_provider, evidence) => {
			blocked = evidence.discoveryFailure === true;
			return blocked;
		});
		const gate = spyOn(availability, "isProviderExhausted").mockImplementation(
			provider => provider === "fixture-discovery" && blocked,
		);
		const complete = spyOn(streams, "completeSimple").mockRejectedValue(new Error("discovery must not invoke chat"));
		const probe = spyOn(availability, "probeUnavailableProviders").mockImplementation(async run => {
			const result = await run({ provider: "fixture-discovery", class: "discovery" } as never);
			if (result.available) blocked = false;
		});
		cleanup.push(
			() => record.mockRestore(),
			() => gate.mockRestore(),
			() => complete.mockRestore(),
			() => probe.mockRestore(),
		);
		await registry.refreshDiscoverableProviders(["fixture-discovery"], "online");
		const warnings: string[] = [];
		validateRetryFallbackChains(
			Settings.isolated({ "retry.fallbackChains": { default: ["fixture-discovery/retained-model"] } }),
			registry,
			warning => warnings.push(warning),
			{ isDiscoveryPending: provider => registry.isProviderDiscoveryPending(provider) },
		);
		expect(warnings).toEqual([]);
		fails = false;
		await registry.refreshDiscoverableProviders(["fixture-discovery"], "online");
		expect(registry.find("fixture-discovery", "retained-model")?.id).toBe("retained-model");
		fails = true;
		await registry.refreshDiscoverableProviders(["fixture-discovery"], "online");
		expect(registry.isProviderDiscoveryPending("fixture-discovery")).toBe(true);
		expect(registry.find("fixture-discovery", "retained-model")?.id).toBe("retained-model");
		expect(registry.getAvailableForProviders(new Set(["fixture-discovery"]))).toEqual([]);
		const count = record.mock.calls.length;
		await registry.runAvailabilityProbes();
		expect(blocked).toBe(true);
		expect(record.mock.calls.length).toBe(count);
		fails = false;
		await registry.runAvailabilityProbes();
		expect(registry.getAvailableForProviders(new Set(["fixture-discovery"])).map(model => model.id)).toEqual([
			"retained-model",
		]);
		expect(complete).not.toHaveBeenCalled();
	});
});
