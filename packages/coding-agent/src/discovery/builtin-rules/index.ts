/**
 * Bundled default rules shipped with the coding agent.
 *
 * Each markdown source is embedded via `with { type: "text" }` so it survives
 * `bun build --compile` (the compiled binary ships no loose rule files; only
 * the embedded text). The native source/tarball installs read the same modules.
 *
 * Registered by the lowest-priority `builtin-defaults` rule provider so any
 * user/project/tool rule with the same name overrides the bundled copy.
 */
import goAddCleanup from "./go-add-cleanup.md" with { type: "text" };
import goBenchLoop from "./go-bench-loop.md" with { type: "text" };
import goExpPromoted from "./go-exp-promoted.md" with { type: "text" };
import goIoutil from "./go-ioutil.md" with { type: "text" };
import goJoinHostport from "./go-join-hostport.md" with { type: "text" };
import goNewExpr from "./go-new-expr.md" with { type: "text" };
import goRandV2 from "./go-rand-v2.md" with { type: "text" };
import goRangeInt from "./go-range-int.md" with { type: "text" };
import rsBoxLeak from "./rs-box-leak.md" with { type: "text" };
import rsFuturePrelude from "./rs-future-prelude.md" with { type: "text" };
import rsLazylock from "./rs-lazylock.md" with { type: "text" };
import rsMatchErgonomics from "./rs-match-ergonomics.md" with { type: "text" };
import rsParkingLot from "./rs-parking-lot.md" with { type: "text" };
import rsResultType from "./rs-result-type.md" with { type: "text" };
import tsBareCatch from "./ts-bare-catch.md" with { type: "text" };
import tsImportType from "./ts-import-type.md" with { type: "text" };
import tsNoAny from "./ts-no-any.md" with { type: "text" };
import tsNoDeprecatedLeftovers from "./ts-no-deprecated-leftovers.md" with { type: "text" };
import tsNoDynamicImport from "./ts-no-dynamic-import.md" with { type: "text" };
import tsNoInlineCastAccess from "./ts-no-inline-cast-access.md" with { type: "text" };
import tsNoLocalIsRecord from "./ts-no-local-is-record.md" with { type: "text" };
import tsNoReturnType from "./ts-no-return-type.md" with { type: "text" };
import tsNoTestTimers from "./ts-no-test-timers.md" with { type: "text" };
import tsNoTinyFunctions from "./ts-no-tiny-functions.md" with { type: "text" };
import tsPromiseWithResolvers from "./ts-promise-with-resolvers.md" with { type: "text" };
import tsRedundantClearGuard from "./ts-redundant-clear-guard.md" with { type: "text" };
import tsSetMap from "./ts-set-map.md" with { type: "text" };

/** A bundled rule's stable name and raw markdown (frontmatter + body). */
export interface BuiltinRuleSource {
	name: string;
	content: string;
}

/** All bundled default rules, ordered by name. */
export const BUILTIN_RULE_SOURCES: readonly BuiltinRuleSource[] = [
	{ name: "go-add-cleanup", content: goAddCleanup },
	{ name: "go-bench-loop", content: goBenchLoop },
	{ name: "go-exp-promoted", content: goExpPromoted },
	{ name: "go-ioutil", content: goIoutil },
	{ name: "go-join-hostport", content: goJoinHostport },
	{ name: "go-new-expr", content: goNewExpr },
	{ name: "go-rand-v2", content: goRandV2 },
	{ name: "go-range-int", content: goRangeInt },
	{ name: "rs-box-leak", content: rsBoxLeak },
	{ name: "rs-future-prelude", content: rsFuturePrelude },
	{ name: "rs-lazylock", content: rsLazylock },
	{ name: "rs-match-ergonomics", content: rsMatchErgonomics },
	{ name: "rs-parking-lot", content: rsParkingLot },
	{ name: "rs-result-type", content: rsResultType },
	{ name: "ts-bare-catch", content: tsBareCatch },
	{ name: "ts-import-type", content: tsImportType },
	{ name: "ts-no-any", content: tsNoAny },
	{ name: "ts-no-deprecated-leftovers", content: tsNoDeprecatedLeftovers },
	{ name: "ts-no-dynamic-import", content: tsNoDynamicImport },
	{ name: "ts-no-inline-cast-access", content: tsNoInlineCastAccess },
	{ name: "ts-no-local-is-record", content: tsNoLocalIsRecord },
	{ name: "ts-no-return-type", content: tsNoReturnType },
	{ name: "ts-no-test-timers", content: tsNoTestTimers },
	{ name: "ts-no-tiny-functions", content: tsNoTinyFunctions },
	{ name: "ts-promise-with-resolvers", content: tsPromiseWithResolvers },
	{ name: "ts-redundant-clear-guard", content: tsRedundantClearGuard },
	{ name: "ts-set-map", content: tsSetMap },
];
