import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

describe("applyToolProxy", () => {
	class DemoTool {
		name = "demo";
		description = "demo tool";
		parameters = type({ a: "string" });
		async execute(): Promise<string> {
			return this.name;
		}
	}

	it("preserves schema callables: parameters stay wire-detectable through the wrapper", () => {
		// Regression: omptype schemas are plain functions carrying toJsonSchema/
		// assert as own properties; binding them stripped those properties, so
		// isArkSchema failed and JSON.stringify(schema) yielded undefined
		// downstream (status-line tokenizer crash).
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(new DemoTool(), wrapper);
		expect(isArkSchema(wrapper.parameters)).toBe(true);
		expect(wrapper.parameters).toBeInstanceOf(Function);
	});

	it("preserves bind-capable schema callables from external arktype copies", () => {
		// Regression: an extension bundling its own arktype registers tools whose
		// `parameters` is a callable Type that DOES have Function.prototype.bind
		// (unlike omptype). Binding it returned a bare bound function with no
		// schema surface, so toolWireSchema stringified to undefined and the
		// native tokenizer crashed every read-only subagent at first prompt.
		const schema = Object.assign((value: unknown) => value, {
			toJsonSchema: () => ({ type: "object" }),
			assert: (value: unknown) => value,
		});
		const tool = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(tool, wrapper);
		expect(wrapper.parameters).toBe(schema);
		expect(isArkSchema(wrapper.parameters)).toBe(true);
	});

	it("binds prototype methods to the underlying tool", async () => {
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(new DemoTool(), wrapper);
		const execute = wrapper.execute as () => Promise<string>;
		// `this` must resolve to the inner tool even when called off the wrapper
		await expect(execute.call({ name: "WRONG" })).resolves.toBe("demo");
	});

	it("passes own data properties through unchanged", () => {
		const inner = new DemoTool();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(inner, wrapper);
		expect(wrapper.name).toBe("demo");
		expect(wrapper.parameters).toBe(inner.parameters);
	});
});
