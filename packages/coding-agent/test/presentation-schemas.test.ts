import { describe, expect, it } from "bun:test";
import type { SyntheticToolResultDetails, ValidationFailureToolResultDetails } from "@oh-my-pi/pi-agent-core";
import type { EditToolDetails } from "../src/edit";
import type { EvalTermination, EvalToolDetails } from "../src/eval/types";
import {
	BuiltinResultSchemaError,
	editDetailsSchema,
	evalDetailsSchema,
	type IsExact,
	knownResultText,
	outputMetaSchema,
	type PresentationBashDetails,
	type PresentationEvalTermination,
	type PresentationOutputMeta,
	type PresentationSyntheticToolResultDetails,
	type PresentationValidationFailureDetails,
	parseLegacyToolResult,
	salvageOutputMeta,
} from "../src/presentation";
import type { BashToolDetails } from "../src/tools/bash";
import type { OutputMeta } from "../src/tools/output-meta";

/**
 * The parse boundary is the *sole* place an untyped legacy result enters the new
 * pipeline, so two things have to hold and both are asserted here:
 *
 * 1. **Type parity.** The zod schema and the producer's own interface are the same
 *    type. Without this a producer rename would make the validator reject every
 *    real result and silently drop whatever it gated — the exact failure the old
 *    hand-written `satisfies`-checked key lists existed to avoid.
 * 2. **Provenance selection.** External data is selected by where it came from,
 *    never by a default branch on a tool name, and an unmodelled built-in gets its
 *    own arm rather than being waved through as external.
 */

/**
 * Type identity, not mutual assignability.
 *
 * `IsExact` lives in the strict presentation project alongside its own negative
 * fixtures; see `src/presentation/exact.ts` for why the previous
 * `[A] extends [B] && [B] extends [A]` check could not see optional-field drift.
 */

describe("presentation schema type parity", () => {
	it("keeps BashToolDetails and its schema the same type", () => {
		// A renamed, retyped, added or removed bash detail field breaks these lines at
		// `bun check` — including an optional one, which the old mutual-assignability
		// check accepted silently.
		const bashParity: IsExact<BashToolDetails, PresentationBashDetails> = true;
		const metaParity: IsExact<OutputMeta, PresentationOutputMeta> = true;
		expect(bashParity && metaParity).toBe(true);
	});

	it("keeps SyntheticToolResultDetails and its schema the same type", () => {
		// The agent loop's synthetic-lifecycle result (`__synthetic`/`source`/
		// `executed`) is pinned to its schema the same way BashToolDetails is: a
		// renamed or retyped producer field breaks this line at `bun check`
		// instead of a validator silently rejecting every real synthetic result.
		const syntheticParity: IsExact<SyntheticToolResultDetails, PresentationSyntheticToolResultDetails> = true;
		expect(syntheticParity).toBe(true);
	});

	it("keeps ValidationFailureToolResultDetails and its schema the same type", () => {
		// The agent loop's pre-dispatch validation-failure result (`isError`/
		// `error`) is pinned to `validationFailureDetailsSchema` the same way:
		// this is what lets a real validation failure settle as a typed failed
		// frame instead of failing the built-in bash schema and poisoning the
		// ACP prompt (a valid producer shape must always parse).
		const validationParity: IsExact<ValidationFailureToolResultDetails, PresentationValidationFailureDetails> = true;
		expect(validationParity).toBe(true);
	});

	it("rejects drift introduced on either side", () => {
		// Negative fixtures. Each `@ts-expect-error` is the assertion: if the exactness
		// check weakened, these would compile, the directive would be unused, and
		// TypeScript would fail the file (TS2578).

		// Drift on the schema-derived side: one extra required field. (An added
		// *optional* field slips past `IsExact`'s identity comparison, so the
		// fixture adds a required one — any real schema addition breaks parity.)
		type SchemaWithExtraRequired = PresentationBashDetails & { readonly addedByDrift: string };
		// @ts-expect-error -- an added schema field must break parity.
		const schemaDrift: IsExact<BashToolDetails, SchemaWithExtraRequired> = true;

		// Drift on the producer side: one field's type changed.
		type ProducerRetypedField = Omit<BashToolDetails, "wallTimeMs"> & { readonly wallTimeMs?: string };
		// @ts-expect-error -- a producer field the schema models with a different type must break parity.
		const producerDrift: IsExact<ProducerRetypedField, PresentationBashDetails> = true;

		// Drift in a nested schema: `OutputMeta`'s own siblings are part of the contract.
		type MetaWithRetypedSibling = Omit<PresentationOutputMeta, "limits"> & { readonly limits?: string };
		// @ts-expect-error -- a retyped nested field must break parity.
		const nestedDrift: IsExact<OutputMeta, MetaWithRetypedSibling> = true;

		expect([schemaDrift, producerDrift, nestedDrift]).toHaveLength(3);
	});

	it("accepts a real eval details object without dropping its modelled fields", () => {
		// eval details reference types that live outside this boundary
		// (`EvalLanguage`, `FileDiagnosticsResult`), so its schema models the
		// presentation-relevant subset and stays `loose`. What must hold *now*
		// is that a real producer shape round-trips with its modelled fields
		// intact. (Edit's own mirror is `z.strictObject`.)
		const details: EvalToolDetails = {
			cells: [{ index: 0, code: "print(1)", output: "1\n", status: "complete", exitCode: 0, language: "python" }],
			isError: false,
			notice: "fell back to the proxy executor",
			notices: ["kernel restarted"],
			language: "python",
			languages: ["python"],
		};
		const parsed = evalDetailsSchema.parse(details);
		expect(parsed.notice).toBe("fell back to the proxy executor");
		expect(parsed.notices).toEqual(["kernel restarted"]);
		expect(parsed.cells?.[0]?.output).toBe("1\n");
	});

	it("keeps EvalTermination and its schema the same type", () => {
		// EvalTermination is now derived from evalTerminationSchema via
		// `(typeof evalTerminationSchema)["_output"]`, so the runtime
		// schema and the static type cannot drift by construction. This
		// assertion verifies the derivation holds — a rename on the schema
		// side propagates to the type, and a field change breaks here.
		const terminationParity: IsExact<EvalTermination, PresentationEvalTermination> = true;
		expect(terminationParity).toBe(true);
	});

	it("accepts a real single-file edit details object without dropping its modelled fields", () => {
		const details: EditToolDetails = {
			diff: "--- a\n+++ b\n",
			path: "/repo/a.txt",
			oldText: "one\n",
			newText: "two\n",
		};
		const parsed = editDetailsSchema.parse(details);
		if (!("diff" in parsed) || parsed.perFileResults !== undefined || parsed.snapshotsPruned === true) {
			throw new Error("expected the single-file available arm");
		}
		expect(parsed.path).toBe("/repo/a.txt");
		expect(parsed.oldText).toBe("one\n");
		expect(parsed.newText).toBe("two\n");
	});

	it("accepts a real multi-file edit details object without dropping its modelled fields", () => {
		const details: EditToolDetails = {
			diff: "--- a\n+++ b\n",
			perFileResults: [{ path: "/repo/a.txt", diff: "--- a\n+++ b\n", isError: true, errorText: "boom" }],
			unattemptedPaths: ["/repo/missing.txt"],
		};
		const parsed = editDetailsSchema.parse(details);
		if (!("diff" in parsed) || parsed.perFileResults === undefined) throw new Error("expected the multi-file arm");
		expect(parsed.unattemptedPaths).toEqual(["/repo/missing.txt"]);
		expect(parsed.perFileResults[0]?.path).toBe("/repo/a.txt");
	});

	it("accepts the agent loop's own lifecycle results for an edit call that never built a bag", () => {
		// The thrown-empty, pre-dispatch validation-failure, and synthetic
		// shapes are emitted for every built-in, edit included (this is the fix for
		// a live bug: before these arms existed, any edit call that threw —
		// a stale hashline tag, a patch context mismatch — poisoned the whole
		// ACP prompt with a JSON-RPC internal error instead of settling as a
		// typed failed frame).
		expect(editDetailsSchema.safeParse({}).success).toBe(true);
		expect(editDetailsSchema.safeParse({ isError: true, error: "bad args" }).success).toBe(true);
		expect(
			editDetailsSchema.safeParse({ __synthetic: true, source: "assistant_stop_skipped", executed: false }).success,
		).toBe(true);
	});

	it("rejects a bag populating both the single-file fields and perFileResults — the old loose schema let this through", () => {
		// This is the exact fixture the previous, pre-strict schema let through:
		// `perFileResults ?? [details]` was the only thing that ever resolved
		// which shape was authoritative, entirely by convention.
		const contradictory = {
			diff: "--- a\n+++ b\n",
			path: "/repo/a.txt",
			oldText: "one\n",
			newText: "two\n",
			perFileResults: [{ path: "/repo/a.txt", diff: "--- a\n+++ b\n" }],
			unattemptedPaths: ["/repo/missing.txt"],
		};
		expect(editDetailsSchema.safeParse(contradictory).success).toBe(false);
	});

	it("rejects an edit details object carrying an unmodelled key — the old loose schema let it through", () => {
		expect(editDetailsSchema.safeParse({ diff: "d", bogus: 1 }).success).toBe(false);
	});

	it("rejects snapshotsPruned alongside a populated snapshot — the old loose schema let this through", () => {
		expect(editDetailsSchema.safeParse({ diff: "d", path: "/p", snapshotsPruned: true, oldText: "x" }).success).toBe(
			false,
		);
	});

	it("rejects a failed per-file entry that also claims a change snapshot", () => {
		expect(
			editDetailsSchema.safeParse({
				diff: "d",
				perFileResults: [{ path: "/p", diff: "", isError: true, errorText: "boom", oldText: "x" }],
			}).success,
		).toBe(false);
	});

	it("rejects unattemptedPaths with no failed perFileResults entry", () => {
		expect(
			editDetailsSchema.safeParse({
				diff: "d",
				perFileResults: [{ path: "/p", diff: "d", oldText: "a", newText: "b" }],
				unattemptedPaths: ["/missing"],
			}).success,
		).toBe(false);
	});
});

describe("output meta parsing dispositions", () => {
	it("parses a well-formed built-in meta strictly", () => {
		const meta: OutputMeta = {
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 100,
				totalBytes: 4096,
				outputLines: 10,
				outputBytes: 512,
				artifactId: "3",
			},
			limits: { columnTruncated: { maxColumn: 512 } },
		};
		expect(outputMetaSchema.parse(meta)).toEqual(meta);
	});

	it("rejects an unexpected key on a built-in meta instead of ignoring it", () => {
		expect(outputMetaSchema.safeParse({ truncation: undefined, bogus: 1 }).success).toBe(false);
	});

	it("salvages persisted meta sibling-by-sibling", () => {
		// A malformed `limits` must not take a valid `truncation` down with it.
		const salvaged = salvageOutputMeta({
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 9,
				totalBytes: 90,
				outputLines: 4,
				outputBytes: 40,
			},
			limits: { matchLimit: "not an object", columnTruncated: { maxColumn: 512 } },
			diagnostics: { summary: 42 },
		});
		expect(salvaged?.truncation?.totalBytes).toBe(90);
		expect(salvaged?.limits).toEqual({ columnTruncated: { maxColumn: 512 } });
		expect(salvaged?.diagnostics).toBeUndefined();
	});

	it("returns undefined when nothing survived", () => {
		expect(salvageOutputMeta({ truncation: 1, limits: 2 })).toBeUndefined();
		expect(salvageOutputMeta(null)).toBeUndefined();
	});

	it("salvages a sibling carrying an unknown key instead of dropping it (external/MCP tool leniency)", () => {
		// If salvage used the strict built-in schema instead of a tolerant one,
		// this whole `truncation` sibling would be dropped — disarming the
		// re-render/limits signal for exactly the kind of unmodelled
		// extension/MCP field it must tolerate.
		const salvaged = salvageOutputMeta({
			truncation: {
				direction: "middle",
				truncatedBy: "middle",
				totalLines: 777,
				totalBytes: 77700,
				outputLines: 300,
				outputBytes: 30000,
				futureVendorField: "unmodelled-extension-field",
			},
		});
		expect(salvaged?.truncation?.totalBytes).toBe(77700);
		expect(outputMetaSchema.safeParse({ truncation: salvaged?.truncation }).success).toBe(true);
	});

	it("still rejects a non-finite number on a salvaged sibling, matching the strict schema", () => {
		const salvaged = salvageOutputMeta({
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: Number.POSITIVE_INFINITY,
				totalBytes: 90,
				outputLines: 4,
				outputBytes: 40,
			},
		});
		expect(salvaged).toBeUndefined();
	});
});

describe("parseLegacyToolResult", () => {
	it("narrows a bash result by name and keeps its details typed", () => {
		const parsed = parseLegacyToolResult(
			{ origin: "builtin", name: "bash" },
			{
				content: [{ type: "text", text: "hi\n" }],
				details: { exitCode: 3, wallTimeMs: 12 },
				isError: true,
			},
		);
		expect(parsed.tool).toBe("bash");
		if (parsed.tool !== "bash") throw new Error("expected the bash arm");
		if (!("exitCode" in parsed.details)) throw new Error("expected completed bash details");
		expect(parsed.details.exitCode).toBe(3);
		expect(parsed.isError).toBe(true);
		expect(knownResultText(parsed)).toBe("hi\n");
	});

	it("routes every command alias to the bash arm", () => {
		for (const name of ["bash", "shell", "exec"]) {
			expect(parseLegacyToolResult({ origin: "builtin", name }, { content: [], details: {} }).tool).toBe("bash");
		}
	});

	it("accepts only the explicit synthetic lifecycle shape for a bash alias", () => {
		const parsed = parseLegacyToolResult(
			{ origin: "builtin", name: "shell" },
			{
				content: [{ type: "text", text: "Tool call was not executed" }],
				details: { __synthetic: true, source: "assistant_stop_skipped", executed: false },
				isError: true,
			},
		);
		expect(parsed.tool).toBe("bash");
		if (parsed.tool !== "bash") throw new Error("expected the bash arm");
		expect(parsed.details).toEqual({ __synthetic: true, source: "assistant_stop_skipped", executed: false });
		expect(() =>
			parseLegacyToolResult(
				{ origin: "builtin", name: "shell" },
				{ content: [], details: { __synthetic: true, source: "assistant_stop_skipped", executed: true } },
			),
		).toThrow(BuiltinResultSchemaError);
	});

	it("gives an unmodelled built-in its own arm rather than the external one", () => {
		const parsed = parseLegacyToolResult(
			{ origin: "builtin", name: "hub" },
			{
				content: [{ type: "text", text: "ok" }],
				details: { daemon: { state: "failed" } },
			},
		);
		expect(parsed.tool).toBe("unmodelled_builtin");
		// Crucially not "external": the arms carry different trust contracts.
		expect(parsed.tool === "external").toBe(false);
	});

	it("selects the external arm by provenance, not by name", () => {
		// A tool *named* bash from an MCP server is still external data.
		const parsed = parseLegacyToolResult(
			{ origin: "external", name: "bash", provider: "mcp" },
			{
				content: [{ type: "text", text: "from mcp" }],
				details: { anything: true },
			},
		);
		expect(parsed.tool).toBe("external");
		if (parsed.tool !== "external") throw new Error("expected the external arm");
		expect(parsed.provider).toBe("mcp");
	});

	it("throws loudly when a built-in violates its own schema", () => {
		expect(() =>
			parseLegacyToolResult({ origin: "builtin", name: "bash" }, { content: [], details: { exitCode: "three" } }),
		).toThrow(BuiltinResultSchemaError);
	});

	it("rejects malformed built-in eval details instead of treating them as external", () => {
		for (const result of [
			"not-an-envelope",
			{ content: "not-an-array", details: {} },
			{ content: [{ type: "text", text: "not a fallback" }], details: { notice: 42 } },
		]) {
			expect(() => parseLegacyToolResult({ origin: "builtin", name: "eval" }, result)).toThrow(
				BuiltinResultSchemaError,
			);
		}
	});

	it("rejects malformed built-in bash envelopes instead of a successful empty result", () => {
		// Before the malformed-envelope check was generalized past eval, any of
		// these degraded into `{ tool: "bash", content: [], details: {} }` — a
		// successful empty result manufactured from producer/transport garbage.
		for (const result of ["not-an-envelope", 42, null, { content: "not-an-array" }]) {
			expect(() => parseLegacyToolResult({ origin: "builtin", name: "bash" }, result)).toThrow(
				BuiltinResultSchemaError,
			);
		}
	});

	it("settles a real argument-validation failure as a typed bash arm instead of throwing", () => {
		// This is exactly the shape `agent-loop.ts`'s `validationErrorMessage`
		// branch emits for every built-in. It must parse as a normal (failed)
		// bash result so the ACP adapter can settle a typed failed frame,
		// never fail the built-in schema and poison the prompt.
		const parsed = parseLegacyToolResult(
			{ origin: "builtin", name: "shell" },
			{
				content: [{ type: "text", text: "bad args" }],
				details: { isError: true, error: "bad args" },
				isError: true,
			},
		);
		expect(parsed.tool).toBe("bash");
		if (parsed.tool !== "bash") throw new Error("expected the bash arm");
		expect(parsed.details).toEqual({ isError: true, error: "bad args" });
	});

	it("degrades a violating built-in to the unmodelled arm when asked to", () => {
		const parsed = parseLegacyToolResult(
			{ origin: "builtin", name: "bash" },
			{ content: [], details: { exitCode: "three" } },
			{ onBuiltinSchemaError: "degrade" },
		);
		expect(parsed.tool).toBe("unmodelled_builtin");
	});

	it("treats absent details as an empty object rather than a violation", () => {
		expect(parseLegacyToolResult({ origin: "builtin", name: "bash" }, { content: [] }).tool).toBe("bash");
		expect(parseLegacyToolResult({ origin: "builtin", name: "bash" }, { content: [], details: null }).tool).toBe(
			"bash",
		);
	});

	it("salvages content block-by-block", () => {
		const parsed = parseLegacyToolResult(
			{ origin: "builtin", name: "bash" },
			{
				content: [
					{ type: "text", text: "kept" },
					{ type: "text" },
					null,
					{ type: "image", data: "AAA", mimeType: "image/png" },
				],
				details: {},
			},
		);
		expect(parsed.content).toEqual([
			{ type: "text", text: "kept" },
			{ type: "image", data: "AAA", mimeType: "image/png" },
		]);
	});

	it("survives a result that is not an object at all", () => {
		const parsed = parseLegacyToolResult({ origin: "external", name: "weird", provider: "extension" }, "nope");
		expect(parsed.content).toEqual([]);
		expect(parsed.isError).toBe(false);
	});
});
