import { describe, expect, it } from "bun:test";
import type { ExecutionToolArguments, PublicToolArguments } from "../../src/presentation/arguments";

/**
 * Compile-time negative tests: mutation of adapter inputs must not typecheck.
 *
 * Each `@ts-expect-error` below MUST fire — if it does not, the type system no
 * longer prevents mutation, and this test fails the type check. The `DeepReadonly`
 * wrapper on both branded argument types is what makes these assignments illegal;
 * removing it would turn every directive into an "unused" error, failing `bun check`.
 *
 * Public and execution views carry disjoint brands, but both erase to deeply
 * readonly projections of the input type. A `selects()` or `start()` implementation
 * that only inspects arguments cannot mutate them — not even a nested field — at
 * the type level. The mutable copy reaches only `execute()`, which owns it.
 *
 * The mutation expressions live inside functions that are never called at runtime —
 * they exist only for the type checker to reject. The `it` bodies verify the functions
 * exist (they were type-checked) without invoking them.
 */

function mutatePublicTopLevel(params: PublicToolArguments<{ command: string }>): void {
	// @ts-expect-error — Cannot assign to 'command' because it is a read-only property.
	params.command = "mutated";
}

function mutatePublicNested(params: PublicToolArguments<{ env: Record<string, string> }>): void {
	// @ts-expect-error — Index signature in type is read-only.
	params.env.TOKEN = "leaked";
}

function mutateExecutionTopLevel(params: ExecutionToolArguments<{ pty: boolean }>): void {
	// @ts-expect-error — Cannot assign to 'pty' because it is a read-only property.
	params.pty = true;
}

function mutateExecutionArray(params: ExecutionToolArguments<{ files: string[] }>): void {
	// @ts-expect-error — Property 'push' does not exist on type 'readonly string[]'.
	params.files.push("extra");
}

function mutateExecutionDeepNested(params: ExecutionToolArguments<{ config: { nested: { value: string } } }>): void {
	// @ts-expect-error — Cannot assign to 'value' because it is a read-only property.
	params.config.nested.value = "mutated";
}

describe("argument brands are deeply readonly at the type level", () => {
	it("prevents mutating a top-level property on PublicToolArguments", () => {
		expect(typeof mutatePublicTopLevel).toBe("function");
	});

	it("prevents mutating a nested property on PublicToolArguments", () => {
		expect(typeof mutatePublicNested).toBe("function");
	});

	it("prevents mutating a top-level property on ExecutionToolArguments", () => {
		expect(typeof mutateExecutionTopLevel).toBe("function");
	});

	it("prevents mutating a nested array element on ExecutionToolArguments", () => {
		expect(typeof mutateExecutionArray).toBe("function");
	});

	it("prevents mutating a deeply nested object on ExecutionToolArguments", () => {
		expect(typeof mutateExecutionDeepNested).toBe("function");
	});
});
