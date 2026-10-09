import { afterEach, describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createTaskModelRoute, resolveRoleRoute } from "@oh-my-pi/pi-coding-agent/task/role-routing";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

const parentSelector = "issue985-parent/parent";
const taskSelector = "issue985-task/task";
const alternateSelector = "issue985-parent/alternate";
const resources: Array<{ dir: TempDir; authStorage: AuthStorage }> = [];

async function createRegistry(taskAuth: "apiKey" | "none" | "oauth" = "oauth") {
	const dir = TempDir.createSync("omp-subagent-route-auth-");
	const authStorage = await AuthStorage.create(":memory:");
	resources.push({ dir, authStorage });
	const modelsPath = path.join(dir.path(), "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				"issue985-parent": {
					api: "openai-completions",
					baseUrl: "https://parent.example.test/v1",
					apiKey: "parent-test-key",
					models: [
						{ id: "parent", reasoning: false },
						{
							id: "alternate",
							reasoning: true,
							thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
						},
					],
				},
				"issue985-task": {
					api: "openai-completions",
					baseUrl: "https://task.example.test/v1",
					auth: taskAuth,
					...(taskAuth === "apiKey" ? { apiKey: "task-test-key" } : {}),
					models: [{ id: "task", reasoning: false }],
				},
			},
		}),
	);
	return new ModelRegistry(authStorage, modelsPath);
}

function authority(
	registry: ModelRegistry,
	settings = Settings.isolated(),
	agentModel: string | string[] = taskSelector,
) {
	return {
		settings,
		agentName: "task",
		agentModel,
		getParentModel: () => registry.find("issue985-parent", "parent"),
		getParentSelector: () => parentSelector,
	};
}

afterEach(async () => {
	for (const { dir, authStorage } of resources.splice(0)) {
		authStorage.close();
		await dir.remove();
	}
});

describe("issue #985: governed subagent authentication", () => {
	test("denies an unauthenticated pin without substituting the authenticated live parent", async () => {
		const registry = await createRegistry();
		const settings = Settings.isolated({
			modelRoles: { default: parentSelector },
			"retry.fallbackChains": { default: [alternateSelector] },
		});
		expect(registry.hasConfiguredAuth(registry.find("issue985-parent", "parent")!)).toBe(true);
		await expect(
			createTaskModelRoute({
				authority: authority(registry, settings),
				modelRegistry: registry,
				selectors: [taskSelector],
				explicit: true,
			}),
		).rejects.toThrow(/Host role preflight unavailable/);
	});

	test("keeps an authenticated authorized pin on the requested provider", async () => {
		const registry = await createRegistry("apiKey");
		const route = await createTaskModelRoute({
			authority: authority(registry),
			modelRegistry: registry,
			selectors: [taskSelector],
			explicit: true,
		});
		expect(resolveRoleRoute(route.permit).selector).toBe(taskSelector);
	});

	test("admits a keyless authorized provider without sending it to the remote parent (#1008)", async () => {
		const registry = await createRegistry("none");
		const requested = registry.find("issue985-task", "task")!;
		expect(await registry.getApiKey(requested)).toBe(kNoAuth);
		const route = await createTaskModelRoute({
			authority: authority(registry),
			modelRegistry: registry,
			selectors: [taskSelector],
			explicit: true,
		});
		expect(resolveRoleRoute(route.permit).selector).toBe(taskSelector);
	});

	test("uses a later authorized candidate with its exact supported effort", async () => {
		const registry = await createRegistry();
		const route = await createTaskModelRoute({
			authority: authority(registry, Settings.isolated(), [taskSelector, alternateSelector]),
			modelRegistry: registry,
			selectors: [taskSelector, `${alternateSelector}:high`],
			explicit: true,
		});
		expect(resolveRoleRoute(route.permit)).toMatchObject({
			selector: `${alternateSelector}:high`,
			thinkingLevel: "high",
			fixedEffort: true,
			occurrence: 1,
		});
	});

	test("walks only the actual configured role chain when the primary has no auth", async () => {
		const registry = await createRegistry();
		const settings = Settings.isolated({
			modelRoles: { qa: taskSelector, default: parentSelector },
			"retry.fallbackChains": { qa: [alternateSelector], default: [parentSelector] },
		});
		const route = await createTaskModelRoute({
			authority: authority(registry, settings),
			modelRegistry: registry,
			selectors: ["@qa"],
			explicit: true,
		});
		expect(resolveRoleRoute(route.permit).selector).toBe(alternateSelector);
	});

	test("walks a configured role past a disabled provider but rejects an explicit disabled pin (#11709)", async () => {
		const registry = await createRegistry("apiKey");
		const settings = Settings.isolated({
			disabledProviders: ["issue985-task"],
			modelRoles: { qa: taskSelector },
			"retry.fallbackChains": { qa: [alternateSelector] },
		});
		const route = await createTaskModelRoute({
			authority: authority(registry, settings, [taskSelector, alternateSelector]),
			modelRegistry: registry,
			selectors: ["@qa"],
			explicit: true,
		});
		expect(resolveRoleRoute(route.permit).selector).toBe(alternateSelector);
		await expect(
			createTaskModelRoute({
				authority: authority(registry, settings),
				modelRegistry: registry,
				selectors: [taskSelector],
				explicit: true,
			}),
		).rejects.toThrow(/Requested provider issue985-task is disabled/);
	});

	test("rejects an invalid suffix instead of replacing the effort or using the parent", async () => {
		const registry = await createRegistry("apiKey");
		await expect(
			createTaskModelRoute({
				authority: authority(registry),
				modelRegistry: registry,
				selectors: [`${taskSelector}:invalid`],
				explicit: true,
			}),
		).rejects.toThrow(/Invalid thinking suffix/);
	});
});
