import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bindPreparedExtensions, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("prepared extension rebinding", () => {
	it("binds a fresh session extension without evaluating the module again", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prepared-extension-"));
		temporaryDirectories.push(directory);
		const parentDirectory = path.join(directory, "parent");
		const childDirectory = path.join(directory, "child");
		await Promise.all([fs.mkdir(parentDirectory), fs.mkdir(childDirectory)]);
		const extensionPath = path.join(directory, "counter.ts");
		const counterKey = `__omp_prepared_extension_${crypto.randomUUID().replaceAll("-", "")}`;
		const bindingsKey = `${counterKey}_bindings`;
		await Bun.write(
			extensionPath,
			`Reflect.set(globalThis, ${JSON.stringify(counterKey)}, Number(Reflect.get(globalThis, ${JSON.stringify(counterKey)}) ?? 0) + 1);\nexport default function counterExtension(api) {\n  const bindings = Reflect.get(globalThis, ${JSON.stringify(bindingsKey)}) ?? [];\n  bindings.push(api);\n  Reflect.set(globalThis, ${JSON.stringify(bindingsKey)}, bindings);\n}\n`,
		);

		const parentEventBus = new EventBus();
		const childEventBus = new EventBus();
		const parent = await loadExtensions([extensionPath], parentDirectory, parentEventBus);
		const prepared = parent.preparedExtensions;
		expect(prepared).toHaveLength(1);
		expect(Reflect.get(globalThis, counterKey)).toBe(1);

		const child = await bindPreparedExtensions(prepared ?? [], childDirectory, childEventBus);

		expect(Reflect.get(globalThis, counterKey)).toBe(1);
		expect(child.extensions).toHaveLength(1);
		expect(child.extensions[0]).not.toBe(parent.extensions[0]);
		expect(child.runtime).not.toBe(parent.runtime);

		const bindings = Reflect.get(globalThis, bindingsKey) as ExtensionAPI[];
		expect(bindings).toHaveLength(2);
		expect(bindings[0]).not.toBe(bindings[1]);
		expect(bindings[0]?.events).toBe(parentEventBus);
		expect(bindings[1]?.events).toBe(childEventBus);
		const [parentPwd, childPwd] = await Promise.all([bindings[0]!.exec("pwd", []), bindings[1]!.exec("pwd", [])]);
		expect(parentPwd.stdout.trim()).toBe(await fs.realpath(parentDirectory));
		expect(childPwd.stdout.trim()).toBe(await fs.realpath(childDirectory));
		Reflect.deleteProperty(globalThis, counterKey);
		Reflect.deleteProperty(globalThis, bindingsKey);
	});
});
