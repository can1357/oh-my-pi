import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function observeSnapshots(registry: ModelRegistry): WeakRef<Model<Api>[]>[] {
	return [new WeakRef(registry.getAll("all")), new WeakRef(registry.getAll("chat"))];
}

function observeOpenAiModel(registry: ModelRegistry): WeakRef<Model<Api>> {
	const model = registry.find("openai", "gpt-4o");
	if (!model) throw new Error("Missing OpenAI model");
	return new WeakRef(model);
}

async function snapshotsCollected(snapshots: WeakRef<object>[]): Promise<boolean> {
	for (let turn = 0; turn < 20; turn++) {
		await Bun.sleep(0);
		Bun.gc(true);
		if (snapshots.every(snapshot => snapshot.deref() === undefined)) return true;
	}
	return false;
}

describe("ModelRegistry snapshot retention", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-registry-snapshot-release-");
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	test("policy refresh releases the previous catalog without another filtered lookup", async () => {
		const previous = observeSnapshots(registry);

		await registry.reapplyModelPolicies();

		expect(await snapshotsCollected(previous)).toBe(true);
		expect(registry.find("openai", "gpt-4o")?.provider).toBe("openai");
	});

	test("transport replacement releases old snapshots while exposing the new endpoint", async () => {
		registry.registerProvider("openai", { baseUrl: "https://previous.example/v1" });
		const previous = [...observeSnapshots(registry), observeOpenAiModel(registry)];

		registry.registerProvider("openai", { baseUrl: "https://snapshot.example/v1" });

		expect(await snapshotsCollected(previous)).toBe(true);
		expect(registry.getAll("chat").find(model => model.provider === "openai" && model.id === "gpt-4o")?.baseUrl).toBe(
			"https://snapshot.example/v1",
		);
	});
});
