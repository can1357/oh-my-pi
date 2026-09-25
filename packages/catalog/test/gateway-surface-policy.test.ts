import { expect, it } from "bun:test";
import { compileBehavior } from "../scripts/compat-compiler/compile-behavior";

it("rejects duplicate gateway surface policies rather than silently picking one", () => {
	expect(() =>
		compileBehavior({
			file: "fixture.kdl",
			text: `behavior {
 gateway-surface name="test" { allow any=#true; }
 gateway-surface name="test" { allow exact="other"; }
}`,
		}),
	).toThrow(/malformed/);
});

it("rejects gateway allow rules with no predicate", () => {
	expect(() =>
		compileBehavior({ file: "fixture.kdl", text: 'behavior { gateway-surface name="test" { allow; }; }' }),
	).toThrow(/malformed/);
});
