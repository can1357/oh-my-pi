import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubscriptionsConfig, parseSubscriptionsConfig } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

const FILE = "test.json";

describe("parseSubscriptionsConfig", () => {
	// The scanner walks raw text, so the cases that could fool it are keys that
	// merely LOOK duplicated: a value string equal to a key, an escaped quote
	// inside a key, and a repeat nested one level deeper.
	it("keeps an account whose value string repeats its own key", () => {
		const raw = `{"accounts":{"acct-1":{"provider":"anthropic","plan":"acct-1"}}}`;

		const config = parseSubscriptionsConfig(raw, FILE);

		// The scanner must not reject this, AND the entry it accepted must still
		// resolve: a false duplicate hit is one failure, silently dropping the
		// account so its plan/renewal series vanish is the other.
		expect(config.lookup("anthropic", "acct-1", "")).toEqual({ plan: "acct-1", renewsAtSeconds: undefined });
	});

	it("still detects a duplicate after a value containing an escaped quote", () => {
		// Without escape handling the scanner ends the `plan` string at the
		// backslash-quote, resyncs half a token off, and misses the repeated
		// `provider` entirely — a false negative, not a false alarm.
		const raw = `{"accounts":{"acct-1":{"plan":"x\\"","provider":"anthropic","provider":"openai"}}}`;
		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicate key .*provider/);
	});

	it("keeps an account whose plan value looks like a sibling key", () => {
		const plan = 'a,b"acct-1"';
		const raw = JSON.stringify({ accounts: { "acct-1": { provider: "anthropic", plan } } });

		const config = parseSubscriptionsConfig(raw, FILE);

		// The embedded quotes and comma are the scanner's bait; the plan the
		// renderer reads back must be the value as written, not a truncated
		// prefix ("a,b") from a resync half a token off.
		expect(config.lookup("anthropic", "acct-1", "")).toEqual({ plan, renewsAtSeconds: undefined });
	});

	it("detects a duplicate nested inside an account entry", () => {
		const raw = `{"accounts":{"acct-1":{"provider":"anthropic","provider":"openai"}}}`;
		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicate key .*provider/);
	});

	// Two spellings of ONE key: `JSON.parse` decodes `\u002d` to `-` and keeps
	// only the last value, so this must be caught like any other duplicate.
	it("rejects a duplicate whose key uses a unicode escape", () => {
		const raw = `{"accounts":{"acct\\u002d1":{"provider":"anthropic"},"acct-1":{"provider":"openai"}}}`;
		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicate key/);
	});

	// `JSON.parse` keeps only the last value for a repeated key, so a
	// copy-pasted duplicate account silently drops one subscription's series
	// instead of failing. The parser documents that it fails loudly rather than
	// emitting partial series, so a duplicate must throw.
	it("rejects a duplicate account key instead of silently keeping the last", () => {
		const raw = `{"accounts":{"acct-1":{"provider":"anthropic","plan":"max"},"acct-1":{"provider":"anthropic","plan":"pro"}}}`;
		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicate key .*acct-1/);
	});

	it("rejects a duplicate plan key", () => {
		const raw = `{"plans":{"anthropic:max":{"capacityWeight":1},"anthropic:max":{"capacityWeight":2}}}`;
		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicate key .*anthropic:max/);
	});

	it("rejects a duplicate top-level section", () => {
		const raw = `{"accounts":{},"accounts":{"a":{"provider":"anthropic"}}}`;
		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicate key .*accounts/);
	});

	// Repeating a key in two SIBLING objects is legal JSON and must stay legal.
	it("keeps both entries when the same key appears in sibling objects", () => {
		const raw = JSON.stringify({
			// `anthropic:max` appears as an account id AND as a sibling plan key.
			accounts: { "anthropic:max": { provider: "anthropic", plan: "max" } },
			plans: { "anthropic:max": { capacityWeight: 1, monthlyPriceUsd: 20 } },
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		// Both consumers of the shared label resolve independently: the account
		// lookup and the plan table. Dropping either while accepting the file is
		// the silent partial-series failure this loader exists to prevent.
		expect(config.lookup("anthropic", "anthropic:max", "")).toEqual({ plan: "max", renewsAtSeconds: undefined });
		expect(config.plans).toEqual([{ provider: "anthropic", plan: "max", capacityWeight: 1, monthlyPriceUsd: 20 }]);
	});

	it("resolves accounts and plans from a valid config", () => {
		const raw = JSON.stringify({
			accounts: {
				"acct-1": { provider: "anthropic", plan: "max", renewsAt: "2026-08-26" },
			},
			plans: {
				"anthropic:max": { capacityWeight: 2, monthlyPriceUsd: 200 },
			},
		});
		const lookup = parseSubscriptionsConfig(raw, FILE);
		const entry = lookup.lookup("anthropic", "acct-1", "");
		expect(entry).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
		expect(lookup.plans).toEqual([{ provider: "anthropic", plan: "max", capacityWeight: 2, monthlyPriceUsd: 200 }]);
	});

	// The loader validates the keys it knows, so a misspelling would otherwise be
	// ignored and its series silently omitted — the opposite of failing loudly.
	it("rejects two account entries that normalize to the same identity", () => {
		// Order-dependent facts are worse than a hard failure: the surviving plan
		// would depend on JSON property order.
		const raw = JSON.stringify({
			accounts: {
				"acct-1": { provider: "anthropic", plan: "max" },
				" acct-1 ": { provider: "anthropic", plan: "pro" },
			},
		});

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicates an earlier entry after trimming/i);
	});

	it("normalizes the provider segment of a plan key so it joins account series", () => {
		const raw = JSON.stringify({
			plans: { " anthropic :max": { capacityWeight: 1, monthlyPriceUsd: 100 } },
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		expect(config.plans[0]?.provider).toBe("anthropic");
	});

	it("rejects a plan key whose provider segment is only padding", () => {
		const raw = JSON.stringify({
			plans: { "   :max": { capacityWeight: 1, monthlyPriceUsd: 100 } },
		});

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/empty provider segment/i);
	});

	it("rejects a whitespace-only account provider", () => {
		// Stored verbatim, a padded identity builds a composite key no live usage
		// report can produce, so the account's plan and renewal series silently
		// vanish while the broker still boots.
		const raw = JSON.stringify({ accounts: { "acct-1": { provider: "   ", plan: "max" } } });

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/must be non-empty and not whitespace-only/i);
	});

	it("rejects a whitespace-only account key", () => {
		const raw = JSON.stringify({ accounts: { "   ": { provider: "anthropic", plan: "max" } } });

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/must be non-empty and not whitespace-only/i);
	});

	it("stores a padded provider and account key trimmed so lookups match", () => {
		const raw = JSON.stringify({ accounts: { "  acct-1  ": { provider: "  anthropic  ", plan: "max" } } });

		const config = parseSubscriptionsConfig(raw, FILE);

		expect(config.lookup("anthropic", "acct-1", "")?.plan).toBe("max");
	});

	it("rejects a misspelled account key instead of silently omitting the series", () => {
		const raw = JSON.stringify({
			accounts: { "acct-1": { provider: "anthropic", plan: "max", renewAt: "2026-10-01" } },
		});

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/unknown key\(s\) "renewAt"/);
	});

	it("rejects an unknown root key", () => {
		const raw = JSON.stringify({ accounts: {}, plan: {} });

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/root has unknown key\(s\) "plan"/);
	});

	it("rejects an unknown key inside a nested org entry", () => {
		const raw = JSON.stringify({
			accounts: {
				"acct-1": { provider: "anthropic", orgs: { "org-a": { plan: "max", renewsAtt: "2026-10-01" } } },
			},
		});

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/unknown key\(s\) "renewsAtt"/);
	});

	it("rejects an unknown key inside a plans entry", () => {
		const raw = JSON.stringify({
			plans: { "anthropic:max": { capacityWeight: 1, monthlyPriceUsd: 100, monthlyPrice: 100 } },
		});

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/unknown key\(s\) "monthlyPrice"/);
	});

	it("pins renewsAt to UTC-midnight epoch seconds (no TZ drift)", () => {
		const raw = JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-08-26" } } });
		const lookup = parseSubscriptionsConfig(raw, FILE);
		expect(lookup.lookup("p", "a", "")?.renewsAtSeconds).toBe(1787702400);
	});

	it("accepts empty/absent maps without throwing", () => {
		const lookup = parseSubscriptionsConfig("{}", FILE);
		expect(lookup.lookup("p", "a", "")).toBeUndefined();
		expect(lookup.plans).toEqual([]);
	});

	it("parses an entry that omits plan entirely (renewal-only / provider-derived)", () => {
		const raw = JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-08-26" } } });
		const lookup = parseSubscriptionsConfig(raw, FILE);
		expect(lookup.lookup("p", "a", "")).toEqual({ plan: undefined, renewsAtSeconds: 1787702400 });
	});

	it("scopes account entries by org and falls back to an org-less entry", () => {
		const raw = JSON.stringify({
			accounts: {
				"acct-1": { provider: "anthropic", org: "org-team", plan: "team" },
				"acct-1 personal": { provider: "anthropic", org: "org-personal", plan: "max" },
				"acct-2": { provider: "anthropic", plan: "pro" },
			},
		});
		const lookup = parseSubscriptionsConfig(raw, FILE);
		// Distinct org keys resolve to their own entry.
		expect(lookup.lookup("anthropic", "acct-1", "org-team")).toEqual({ plan: "team", renewsAtSeconds: undefined });
		expect(lookup.lookup("anthropic", "acct-1 personal", "org-personal")).toEqual({
			plan: "max",
			renewsAtSeconds: undefined,
		});
		// An org-less config entry resolves for any org of that account.
		expect(lookup.lookup("anthropic", "acct-2", "org-x")).toEqual({ plan: "pro", renewsAtSeconds: undefined });
		expect(lookup.lookup("anthropic", "acct-2", "")).toEqual({ plan: "pro", renewsAtSeconds: undefined });
		// An org-scoped entry does not answer a mismatched org unless a bare
		// fallback exists.
		expect(lookup.lookup("anthropic", "acct-1", "org-personal")).toBeUndefined();
	});

	it("resolves the SAME account id in two orgs via the nested orgs map", () => {
		// Two orgs for one account id cannot be two top-level `accounts` keys —
		// JSON.parse keeps only the last property of a duplicated key. The nested
		// `orgs` map lets a single account id carry an independent plan/renewal per
		// org; a regression collapses both orgs onto one plan (or drops one).
		const raw = JSON.stringify({
			accounts: {
				"acct-1": {
					provider: "anthropic",
					org: "org-team",
					plan: "team",
					renewsAt: "2026-08-26",
					orgs: {
						"org-personal": { plan: "max", renewsAt: "2026-09-15" },
					},
				},
			},
		});
		const lookup = parseSubscriptionsConfig(raw, FILE);
		expect(lookup.lookup("anthropic", "acct-1", "org-team")).toEqual({ plan: "team", renewsAtSeconds: 1787702400 });
		expect(lookup.lookup("anthropic", "acct-1", "org-personal")).toEqual({
			plan: "max",
			renewsAtSeconds: 1789430400,
		});
		// Neither org's entry leaks to a third, unconfigured org (no bare fallback).
		expect(lookup.lookup("anthropic", "acct-1", "org-other")).toBeUndefined();
	});

	const throwCases: Array<[string, string]> = [
		["non-JSON string", "not json"],
		["JSON non-object root (number)", "3"],
		["JSON array root (accounts/plans silently absent)", "[]"],
		["account entry not an object", JSON.stringify({ accounts: { a: 5 } })],
		["provider missing", JSON.stringify({ accounts: { a: {} } })],
		["provider not a string", JSON.stringify({ accounts: { a: { provider: 1 } } })],
		["provider empty string", JSON.stringify({ accounts: { a: { provider: "" } } })],
		["account key empty string", JSON.stringify({ accounts: { "": { provider: "p" } } })],
		[
			"org not a string (number coerced to empty scope)",
			JSON.stringify({ accounts: { a: { provider: "p", org: 42 } } }),
		],
		["orgs map not an object", JSON.stringify({ accounts: { a: { provider: "p", orgs: 5 } } })],
		["orgs entry not an object", JSON.stringify({ accounts: { a: { provider: "p", orgs: { x: 5 } } } })],
		[
			"org scope declared twice (top-level org + orgs key)",
			JSON.stringify({ accounts: { a: { provider: "p", org: "team", orgs: { team: { plan: "x" } } } } }),
		],
		[
			"nested org plan not a string",
			JSON.stringify({ accounts: { a: { provider: "p", orgs: { x: { plan: 1 } } } } }),
		],
		["plan not a string", JSON.stringify({ accounts: { a: { provider: "p", plan: 1 } } })],
		["renewsAt not a string", JSON.stringify({ accounts: { a: { provider: "p", renewsAt: 1 } } })],
		[
			"renewsAt wrong format (single digits)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-8-6" } } }),
		],
		[
			"renewsAt wrong format (slashes)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "08/26/2026" } } }),
		],
		[
			"renewsAt wrong format (datetime)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-08-26T00:00:00" } } }),
		],
		["renewsAt unparseable", JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-13-99" } } })],
		["plan key with no colon", JSON.stringify({ plans: { max: { capacityWeight: 1, monthlyPriceUsd: 1 } } })],
		["plan key leading colon", JSON.stringify({ plans: { ":max": { capacityWeight: 1, monthlyPriceUsd: 1 } } })],
		[
			"plan key trailing colon",
			JSON.stringify({ plans: { "anthropic:": { capacityWeight: 1, monthlyPriceUsd: 1 } } }),
		],
		[
			"capacityWeight non-number",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: "1", monthlyPriceUsd: 1 } } }),
		],
		[
			"monthlyPriceUsd non-number",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: 1, monthlyPriceUsd: "1" } } }),
		],
		["accounts map is null", JSON.stringify({ accounts: null })],
		["accounts map is an array", JSON.stringify({ accounts: [] })],
		["accounts map is a number", JSON.stringify({ accounts: 3 })],
		["plans map is null", JSON.stringify({ plans: null })],
		["plans map is an array", JSON.stringify({ plans: [] })],
		["plans map is a number", JSON.stringify({ plans: 3 })],
		[
			"renewsAt normalized-invalid (2026-02-29)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-02-29" } } }),
		],
		[
			"renewsAt normalized-invalid (2026-02-31)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-02-31" } } }),
		],
		[
			"renewsAt normalized-invalid (2026-13-01)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-13-01" } } }),
		],
		[
			"plan keys collapse to one canonical identity",
			JSON.stringify({
				plans: {
					"anthropic:Max Plan": { capacityWeight: 1, monthlyPriceUsd: 1 },
					"anthropic:max-plan": { capacityWeight: 2, monthlyPriceUsd: 2 },
				},
			}),
		],
		["account plan empty string", JSON.stringify({ accounts: { a: { provider: "p", plan: "" } } })],
		["account plan whitespace-only", JSON.stringify({ accounts: { a: { provider: "p", plan: "   " } } })],
		[
			"nested org plan empty string",
			JSON.stringify({ accounts: { a: { provider: "p", orgs: { x: { plan: "" } } } } }),
		],
		[
			"org value whitespace-only (canonicalizes to all-orgs fallback)",
			JSON.stringify({ accounts: { a: { provider: "p", org: "   ", plan: "max" } } }),
		],
		[
			"orgs key whitespace-only (canonicalizes to all-orgs fallback)",
			JSON.stringify({ accounts: { a: { provider: "p", org: "team", orgs: { "   ": { plan: "max" } } } } }),
		],
		[
			"orgs key literal empty string (canonicalizes to all-orgs fallback)",
			JSON.stringify({ accounts: { a: { provider: "p", org: "team", orgs: { "": { plan: "max" } } } } }),
		],
		[
			"plan key canonically empty (trailing chatgpt_)",
			JSON.stringify({ plans: { "anthropic:chatgpt_": { capacityWeight: 1, monthlyPriceUsd: 1 } } }),
		],
		[
			"plan key canonically empty (whitespace suffix)",
			JSON.stringify({ plans: { "anthropic:   ": { capacityWeight: 1, monthlyPriceUsd: 1 } } }),
		],
		[
			"capacityWeight negative",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: -1, monthlyPriceUsd: 1 } } }),
		],
		[
			"capacityWeight non-finite (Infinity)",
			// JSON has no NaN/Infinity literal; `1e999` overflows to Infinity on
			// JSON.parse, which is a `number` (passing the type check) but not
			// finite, so the range guard is what must reject it.
			'{"plans":{"anthropic:max":{"capacityWeight":1e999,"monthlyPriceUsd":1}}}',
		],
		[
			"monthlyPriceUsd negative",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: 1, monthlyPriceUsd: -0.01 } } }),
		],
		[
			"monthlyPriceUsd non-finite (Infinity)",
			'{"plans":{"anthropic:max":{"capacityWeight":1,"monthlyPriceUsd":1e999}}}',
		],
	];

	for (const [name, raw] of throwCases) {
		it(`throws on ${name}`, () => {
			expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow();
		});
	}
});

describe("loadSubscriptionsConfig", () => {
	const tempDirs: string[] = [];
	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reads and parses a valid config file (via Bun.file)", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authbroker-subs-"));
		tempDirs.push(dir);
		const file = path.join(dir, "subs.json");
		await Bun.write(
			file,
			JSON.stringify({
				accounts: { "acct-1": { provider: "anthropic", plan: "max", renewsAt: "2026-08-26" } },
				plans: { "anthropic:max": { capacityWeight: 2, monthlyPriceUsd: 200 } },
			}),
		);
		const lookup = await loadSubscriptionsConfig(file, true);
		expect(lookup?.lookup("anthropic", "acct-1", "")).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
		expect(lookup?.plans).toEqual([{ provider: "anthropic", plan: "max", capacityWeight: 2, monthlyPriceUsd: 200 }]);
	});

	it("returns undefined when no path is configured, regardless of ambient env", async () => {
		// `loadSubscriptionsConfig(undefined)` falls back to OMP_AUTH_BROKER_SUBSCRIPTIONS,
		// so an ambient value would silently exercise the env-configured path (reading
		// an unrelated host file) instead of the absent branch. Isolate the env var
		// around the call and restore it exactly, leaking no process-wide state.
		const ENV = "OMP_AUTH_BROKER_SUBSCRIPTIONS";
		const prior = process.env[ENV];
		process.env[ENV] = "/nonexistent/ambient-subs.json";
		try {
			delete process.env[ENV];
			expect(await loadSubscriptionsConfig(undefined, true)).toBeUndefined();
		} finally {
			if (prior === undefined) delete process.env[ENV];
			else process.env[ENV] = prior;
		}
		expect(process.env[ENV] === prior).toBe(true);
	});
	// Subscription data feeds ONLY the `/metrics` route. With the route disabled
	// (the default, or an explicit `--no-enable-metrics`) a malformed file must
	// not keep the broker from booting, otherwise turning the feature off cannot
	// recover a deployment from a metrics-only misconfiguration.
	it("skips the read entirely while metrics are disabled, even for a malformed file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authbroker-subs-"));
		tempDirs.push(dir);
		const file = path.join(dir, "subs.json");
		await Bun.write(file, "{ this is not valid JSON");

		// Enabled: the malformed file is read and fails loudly.
		await expect(loadSubscriptionsConfig(file, true)).rejects.toThrow(/not valid JSON/i);
		// Disabled: never read, so the broker still starts.
		expect(await loadSubscriptionsConfig(file, false)).toBeUndefined();
	});

	it("does not read a missing file while metrics are disabled", async () => {
		const missing = path.join(os.tmpdir(), "authbroker-subs-does-not-exist.json");

		await expect(loadSubscriptionsConfig(missing, true)).rejects.toThrow();
		expect(await loadSubscriptionsConfig(missing, false)).toBeUndefined();
	});

	// The env-configured path must short-circuit too: a stale
	// OMP_AUTH_BROKER_SUBSCRIPTIONS is the most likely way a bad path outlives
	// the decision to disable the endpoint.
	it("ignores a malformed env-configured file while metrics are disabled", async () => {
		const ENV = "OMP_AUTH_BROKER_SUBSCRIPTIONS";
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authbroker-subs-"));
		tempDirs.push(dir);
		const file = path.join(dir, "subs.json");
		await Bun.write(file, "{ nope");
		const prior = process.env[ENV];
		process.env[ENV] = file;
		try {
			await expect(loadSubscriptionsConfig(undefined, true)).rejects.toThrow(/not valid JSON/i);
			expect(await loadSubscriptionsConfig(undefined, false)).toBeUndefined();
		} finally {
			if (prior === undefined) delete process.env[ENV];
			else process.env[ENV] = prior;
		}
	});
});

// Provider ids are compared against live usage reports by exact key, and every
// id in the catalog table is lowercase. A mis-cased config provider stored
// verbatim joins no report, so the account's plan/renewal series vanish while
// the broker logs a healthy start.
describe("parseSubscriptionsConfig provider-id casing", () => {
	it("canonicalizes a mis-cased account provider so it joins the report series", () => {
		const raw = JSON.stringify({
			accounts: { "acct-1": { provider: "Anthropic", plan: "max", renewsAt: "2026-08-26" } },
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		// The report's provider label is the bare lowercase id.
		expect(config.lookup("anthropic", "acct-1", "")).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
	});

	it("canonicalizes a mis-cased plan-key provider segment", () => {
		const raw = JSON.stringify({
			plans: { "Anthropic:max": { capacityWeight: 2, monthlyPriceUsd: 200 } },
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		expect(config.plans[0]?.provider).toBe("anthropic");
	});

	it("handles mixed casing and padding together", () => {
		const raw = JSON.stringify({
			accounts: { " acct-1 ": { provider: "  OpenAI-Codex  ", plan: "pro" } },
			plans: { "  OPENAI-CODEX  :pro": { capacityWeight: 1, monthlyPriceUsd: 20 } },
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		expect(config.lookup("openai-codex", "acct-1", "")).toEqual({ plan: "pro", renewsAtSeconds: undefined });
		expect(config.plans[0]?.provider).toBe("openai-codex");
	});

	// Casing collapses into one identity, so two entries differing only by case
	// would otherwise let JSON property order decide the surviving plan — the
	// same order-dependence the trimming duplicate check already rejects.
	it("rejects two account entries that differ only by provider casing", () => {
		const colliding = JSON.stringify({
			accounts: {
				"acct-1": { provider: "anthropic", plan: "max" },
				" acct-1 ": { provider: "Anthropic", plan: "pro" },
			},
		});
		expect(() => parseSubscriptionsConfig(colliding, FILE)).toThrow(/duplicates an earlier entry after trimming/i);
	});

	it("rejects two plan keys that differ only by provider casing", () => {
		const raw = JSON.stringify({
			plans: {
				"anthropic:max": { capacityWeight: 2, monthlyPriceUsd: 200 },
				"Anthropic:max": { capacityWeight: 3, monthlyPriceUsd: 300 },
			},
		});

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/duplicates canonical plan/i);
	});
});

// Two providers can hand out the same account label — a username-based
// subscription called `monalisa` on each. The runtime lookup is keyed by
// `{provider, account, org}`, so both are distinct identities, but a config
// that keys accounts by the JSON property alone can only name the label once:
// repeating it is rejected as a duplicate key, so one provider's subscription
// had to be dropped. The nested `providers` map carries the extra providers for
// one label, mirroring how `orgs` carries the extra org scopes.
describe("parseSubscriptionsConfig cross-provider account ids", () => {
	it("resolves the SAME account label under two providers", () => {
		const raw = JSON.stringify({
			accounts: {
				monalisa: {
					provider: "anthropic",
					plan: "max",
					renewsAt: "2026-08-26",
					providers: {
						"openai-codex": { plan: "pro", renewsAt: "2026-09-15" },
					},
				},
			},
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		expect(config.lookup("anthropic", "monalisa", "")).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
		expect(config.lookup("openai-codex", "monalisa", "")).toEqual({ plan: "pro", renewsAtSeconds: 1789430400 });
		// A third, unconfigured provider does not inherit either plan.
		expect(config.lookup("google", "monalisa", "")).toBeUndefined();
	});

	it("scopes a nested provider by org, with its own org-less fallback", () => {
		const raw = JSON.stringify({
			accounts: {
				monalisa: {
					provider: "anthropic",
					org: "org-team",
					plan: "team",
					providers: {
						"openai-codex": { plan: "pro", orgs: { "org-personal": { plan: "plus" } } },
					},
				},
			},
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		expect(config.lookup("openai-codex", "monalisa", "org-personal")?.plan).toBe("plus");
		// The nested provider's org-less entry answers its other orgs.
		expect(config.lookup("openai-codex", "monalisa", "org-other")?.plan).toBe("pro");
		// The account-level provider is org-scoped, so it answers only its org.
		expect(config.lookup("anthropic", "monalisa", "org-team")?.plan).toBe("team");
		expect(config.lookup("anthropic", "monalisa", "org-personal")).toBeUndefined();
	});

	it("canonicalizes a padded and mis-cased nested provider key", () => {
		const raw = JSON.stringify({
			accounts: {
				monalisa: { provider: "anthropic", plan: "max", providers: { "  OpenAI-Codex  ": { plan: "pro" } } },
			},
		});

		const config = parseSubscriptionsConfig(raw, FILE);

		expect(config.lookup("openai-codex", "monalisa", "")?.plan).toBe("pro");
	});

	// A nested provider that restates the account's own provider and org would
	// collide on one identity and let property order decide the surviving plan —
	// the same order-dependence the orgs map already rejects.
	it("rejects a nested provider that restates the account's own provider scope", () => {
		const raw = JSON.stringify({
			accounts: {
				monalisa: { provider: "anthropic", plan: "max", providers: { Anthropic: { plan: "pro" } } },
			},
		});

		expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow(/anthropic/i);
	});

	const nestedThrowCases: Array<[string, string]> = [
		["providers map not an object", JSON.stringify({ accounts: { a: { provider: "p", providers: 5 } } })],
		["providers entry not an object", JSON.stringify({ accounts: { a: { provider: "p", providers: { q: 5 } } } })],
		[
			"providers key whitespace-only",
			JSON.stringify({ accounts: { a: { provider: "p", providers: { "   ": { plan: "max" } } } } }),
		],
		[
			"providers entry declares its own provider",
			JSON.stringify({ accounts: { a: { provider: "p", providers: { q: { provider: "r" } } } } }),
		],
		[
			"providers entry nests another providers map",
			JSON.stringify({ accounts: { a: { provider: "p", providers: { q: { providers: {} } } } } }),
		],
		[
			"unknown key inside a providers entry",
			JSON.stringify({ accounts: { a: { provider: "p", providers: { q: { renewAt: "2026-10-01" } } } } }),
		],
		[
			"nested provider plan canonically empty",
			JSON.stringify({ accounts: { a: { provider: "p", providers: { q: { plan: "   " } } } } }),
		],
		[
			"nested provider org whitespace-only",
			JSON.stringify({ accounts: { a: { provider: "p", providers: { q: { org: "   ", plan: "max" } } } } }),
		],
		[
			"nested provider declares one org scope twice",
			JSON.stringify({
				accounts: {
					a: { provider: "p", providers: { q: { org: "team", orgs: { team: { plan: "x" } } } } },
				},
			}),
		],
	];

	for (const [name, raw] of nestedThrowCases) {
		it(`throws on ${name}`, () => {
			expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow();
		});
	}
});
