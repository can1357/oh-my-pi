import { describe, expect, test } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	registerTodoBackend,
	type TodoBackend,
	type TodoBackendDefinition,
	type TodoBackendRegistration,
} from "@oh-my-pi/pi-coding-agent/tools/todo-backend";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const noopBackend: TodoBackend = {
	async apply() {},
	async replace() {},
};

function definition(id: string, overrides: Partial<TodoBackendDefinition> = {}): TodoBackendDefinition {
	return { id, label: `Label ${id}`, create: () => noopBackend, ...overrides };
}

function load(runtime: ExtensionRuntime, factory: ExtensionFactory, name: string) {
	return loadExtensionFromFactory(factory, process.cwd(), new EventBus(), runtime, name);
}

describe("registerTodoBackend", () => {
	test("rejects an empty id, an empty label and a non-function create", () => {
		const registrations: TodoBackendRegistration[] = [];
		expect(() => registerTodoBackend(registrations, definition(""), "ext")).toThrow(/id/);
		expect(() => registerTodoBackend(registrations, definition("a", { label: "" }), "ext")).toThrow(/"a".*label/);
		expect(() => registerTodoBackend(registrations, definition("b", { create: undefined as never }), "ext")).toThrow(
			/"b".*create/,
		);
		expect(registrations).toEqual([]);
	});
});

describe("pi.registerTodoBackend", () => {
	test("an extension reusing a taken id keeps its other registrations", async () => {
		const runtime = new ExtensionRuntime();
		await load(runtime, pi => pi.registerTodoBackend(definition("tracker", { label: "First" })), "a");

		const second = await load(
			runtime,
			pi => {
				pi.registerTodoBackend(definition("tracker", { label: "Second" }));
				pi.registerCommand("second-cmd", { handler: async () => {} });
			},
			"b",
		);

		expect(second.commands.has("second-cmd")).toBe(true);
	});

	test("an extension registering native fails to load", async () => {
		const runtime = new ExtensionRuntime();
		await expect(load(runtime, pi => pi.registerTodoBackend(definition("native")), "bad-extension")).rejects.toThrow(
			/native/,
		);
		expect(runtime.todoBackends).toEqual([]);
	});

	test("a factory that throws after registering rolls back only its own backends", async () => {
		const runtime = new ExtensionRuntime();
		await load(runtime, pi => pi.registerTodoBackend(definition("earlier")), "a");

		await expect(
			load(
				runtime,
				pi => {
					pi.registerTodoBackend(definition("tracker", { label: "Broken" }));
					throw new Error("factory failed");
				},
				"broken",
			),
		).rejects.toThrow("factory failed");
		expect(runtime.todoBackends.map(entry => entry.definition.id)).toEqual(["earlier"]);
	});
});
