import { describe, expect, test } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type TodoBackend,
	type TodoBackendDefinition,
	TodoBackendRegistry,
} from "@oh-my-pi/pi-coding-agent/tools/todo-backend";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const noopBackend: TodoBackend = {
	async apply() {},
	async replace() {},
};

function definition(id: string, overrides: Partial<TodoBackendDefinition> = {}): TodoBackendDefinition {
	return { id, label: `Label ${id}`, create: () => noopBackend, ...overrides };
}

describe("TodoBackendRegistry", () => {
	test("rejects a duplicate id and names the id and the first registrant", () => {
		const registry = new TodoBackendRegistry();
		registry.register(definition("tracker"), "ext-first");
		expect(() => registry.register(definition("tracker"), "ext-second")).toThrow(/"tracker".*ext-first/);
		expect(registry.list()).toHaveLength(1);
	});

	test("rejects an empty id, an empty label and a non-function create", () => {
		const registry = new TodoBackendRegistry();
		expect(() => registry.register(definition(""), "ext")).toThrow(/id/);
		expect(() => registry.register(definition("a", { label: "" }), "ext")).toThrow(/"a".*label/);
		expect(() => registry.register(definition("b", { create: undefined as never }), "ext")).toThrow(/"b".*create/);
	});

	test("list keeps registration order, which the settings submenu shows", () => {
		const registry = new TodoBackendRegistry();
		registry.register(definition("b"), "ext");
		registry.register(definition("a"), "ext");
		registry.register(definition("c"), "ext");
		expect(registry.list().map(entry => entry.id)).toEqual(["b", "a", "c"]);
		expect(registry.get("missing")).toBeUndefined();
	});
});

describe("pi.registerTodoBackend", () => {
	test("registers into the runner's todoBackends through the extension loader", async () => {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerTodoBackend({ id: "tracker", label: "Tracker", create: () => noopBackend });
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"tracker-extension",
		);
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);

		expect(runner.todoBackends.list().map(entry => entry.id)).toEqual(["tracker"]);
	});

	test("an extension registering native fails to load", async () => {
		const runtime = new ExtensionRuntime();
		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerTodoBackend({ id: "native", label: "Native", create: () => noopBackend });
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"bad-extension",
			),
		).rejects.toThrow(/native/);
		expect(runtime.todoBackends.list()).toEqual([]);
	});

	test("a factory that throws after registering leaves earlier backends and frees its id", async () => {
		const runtime = new ExtensionRuntime();
		const load = (factory: Parameters<typeof loadExtensionFromFactory>[0], name: string) =>
			loadExtensionFromFactory(factory, process.cwd(), new EventBus(), runtime, name);
		await load(pi => pi.registerTodoBackend({ id: "earlier", label: "Earlier", create: () => noopBackend }), "a");

		await expect(
			load(pi => {
				pi.registerTodoBackend({ id: "tracker", label: "Broken", create: () => noopBackend });
				throw new Error("factory failed");
			}, "broken"),
		).rejects.toThrow("factory failed");
		expect(runtime.todoBackends.list().map(entry => entry.id)).toEqual(["earlier"]);

		await load(pi => pi.registerTodoBackend({ id: "tracker", label: "Healthy", create: () => noopBackend }), "b");
		expect(runtime.todoBackends.get("tracker")?.label).toBe("Healthy");
	});
});
