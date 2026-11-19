import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("docs select config example", () => {
	const SelectivelyConfigured = type({
		name: "string",
		age: "number",
	}).configure(
		{
			description: "a special string",
		},
		// only add the description to string keywords
		{
			kind: "domain",
			where: d => d.domain === "string",
		},
	);

	expect(SelectivelyConfigured.get("name").description).toBe("a special string");
	expect(SelectivelyConfigured.get("age").description).toBe("a number");
});
