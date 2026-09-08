/**
 * Bake↔runtime consistency gate: for every bundled models.json row, the compat
 * engine (`resolveModelPolicy`) must reproduce the row's baked `compat` and
 * `thinking` values exactly, for every field that existed before the engine.
 *
 * Thinking is derived from scratch (`thinking: undefined`), mirroring the
 * generator's `rebakeModelThinking`, except its documented provider-authored
 * exemption rows, which keep their explicit metadata.
 *
 * Hermetic (no network). Zero diffs required — a failure names each divergent
 * field as `provider/model.field: baked=X engine=Y`; fix the KDL rules (or a
 * host-detection seam in `resolve.ts`), never the baked values.
 */
import { describe, expect, test } from "bun:test";
import { isCollapsedVariantSpec } from "../src/compat/collapse";
import { resolveModelPolicy } from "../src/compat/resolve";
import models from "../src/models.json";
import type { Api, Model, ModelSpec } from "../src/types";

/** Fields introduced by the compat engine — absent from pre-engine baked rows. */
const NEW_COMPAT_FIELDS = new Set([
	"injectClaudeCodeInstruction",
	"stripImageInput",
	"thinkingLoopGuard",
	"nativeKimiK3Reasoning",
	"zaiReasoningEffortDialect",
	"clampOutputToModelMax",
	"supportsAllTurnsReasoningContext",
	"supportsFunctionPartId",
	"requiresSkipThoughtSignature",
	"dropUnsignedThinking",
	"ccaLegacyParametersSchema",
	"multimodalFunctionResponse",
	"flashStreamLeakWorkaround",
	"claudeThinkingBetaHeader",
	"antigravityClaudeToolMode",
	"antigravityUsageLabel",
]);

/** APIs whose compat record is new with the engine (no baked baseline). */
const NEW_COMPAT_APIS = new Set(["google-generative-ai", "google-vertex", "google-gemini-cli"]);

function jsonClone<T>(value: T): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function diffValues(prefix: string, baked: unknown, engine: unknown, out: string[]): void {
	if (Bun.deepEquals(baked, engine, true)) return;
	if (
		typeof baked === "object" &&
		baked !== null &&
		!Array.isArray(baked) &&
		typeof engine === "object" &&
		engine !== null &&
		!Array.isArray(engine)
	) {
		const keys = new Set([...Object.keys(baked), ...Object.keys(engine)]);
		for (const key of keys) {
			if (NEW_COMPAT_FIELDS.has(key)) continue;
			diffValues(
				`${prefix}.${key}`,
				(baked as Record<string, unknown>)[key],
				(engine as Record<string, unknown>)[key],
				out,
			);
		}
		return;
	}
	out.push(`${prefix}: baked=${JSON.stringify(baked)} engine=${JSON.stringify(engine)}`);
}

interface RowLike {
	id: string;
	provider: string;
	api: Api;
	compat?: unknown;
	compatConfig?: { thinkingFormat?: string };
	thinking?: Model<Api>["thinking"];
	[key: string]: unknown;
}

/**
 * Mirrors `rebakeModelThinking`'s exemptions: rows whose baked thinking is
 * provider-authored and never re-derived by the generator.
 */
function keepsExplicitThinking(row: RowLike): boolean {
	if (isCollapsedVariantSpec(row as unknown as ModelSpec<Api>)) return true;
	if (row.compatConfig?.thinkingFormat === "chat-template" && row.thinking) return true;
	if (
		row.provider === "alibaba-token-plan" &&
		(row.id === "qwen3.8-max-preview" || row.id === "qwen3.8-max") &&
		row.thinking
	) {
		return true;
	}
	if (row.provider === "cline-pass" && row.thinking) return true;
	if (row.provider === "openrouter" && row.thinking?.requiresEffort === true) return true;
	return false;
}

describe("compat parity", () => {
	test("engine reproduces every baked models.json compat/thinking value", () => {
		const diffs: string[] = [];
		let rows = 0;
		for (const provider in models) {
			const providerModels = models[provider as keyof typeof models] as Record<string, unknown>;
			for (const modelId in providerModels) {
				const row = providerModels[modelId] as unknown as Model<Api> & RowLike;
				rows++;
				const label = `${provider}/${modelId}`;
				const {
					compat: _compat,
					compatConfig,
					requiresGlyphTokenization: _glyph,
					supportsComputerUseConfig,
					supportsComputerUse: _computerUse,
					identity: _identity,
					...rest
				} = row;
				if (compatConfig !== undefined) (rest as Record<string, unknown>).compat = compatConfig;
				if (supportsComputerUseConfig !== undefined) {
					(rest as Record<string, unknown>).supportsComputerUse = supportsComputerUseConfig;
				}
				const exempt = keepsExplicitThinking(row);
				if (!exempt) (rest as Record<string, unknown>).thinking = undefined;
				const umansAuthored =
					provider === "umans" && (row.thinking?.requiresEffort === true || row.id === "umans-kimi-k2.7");
				let policy: ReturnType<typeof resolveModelPolicy>;
				try {
					policy = resolveModelPolicy(rest as unknown as ModelSpec<Api>);
				} catch (error) {
					diffs.push(`${label}: engine threw ${(error as Error).message}`);
					continue;
				}
				let thinking = policy.thinking;
				if (!exempt && umansAuthored && thinking) thinking = { ...thinking, requiresEffort: true };
				if (!NEW_COMPAT_APIS.has(row.api)) {
					diffValues(`${label}.compat`, jsonClone(row.compat), jsonClone(policy.compat), diffs);
				}
				diffValues(`${label}.thinking`, jsonClone(row.thinking), jsonClone(thinking), diffs);
			}
		}
		if (diffs.length > 0) {
			const shown = diffs.slice(0, 200);
			console.error(`\n${diffs.length} parity diffs across ${rows} rows:\n${shown.join("\n")}`);
			if (diffs.length > shown.length) console.error(`… and ${diffs.length - shown.length} more`);
		}
		expect(diffs.length).toBe(0);
	});
});
