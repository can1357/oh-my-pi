import { afterEach, describe, expect, test } from "bun:test";
import {
	type CustomStreamSimpleFn,
	clearCustomApis,
	getCustomApi,
	registerCustomApi,
	unregisterCustomApis,
} from "@oh-my-pi/pi-ai/api-registry";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/types";

afterEach(() => {
	clearCustomApis();
});

describe("custom API registry", () => {
	const streamSimple: CustomStreamSimpleFn = () => ({}) as unknown as AssistantMessageEventStream;

	test("rejects registrations that collide with built-in API names", () => {
		expect(() => registerCustomApi("openai-responses", streamSimple)).toThrow(
			'Cannot register custom API "openai-responses": built-in API names are reserved.',
		);
	});

	test("unregisterCustomApis removes only matching source registrations", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		unregisterCustomApis("ext-a");

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeDefined();
	});

	test("clearCustomApis removes all custom APIs", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		clearCustomApis();

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeUndefined();
	});
});
