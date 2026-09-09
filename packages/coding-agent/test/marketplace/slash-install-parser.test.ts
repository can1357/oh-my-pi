import { describe, expect, it } from "bun:test";
import {
	parseMarketplaceInstallArgs,
	parsePluginScopeArgs,
} from "@oh-my-pi/pi-coding-agent/slash-commands/marketplace-install-parser";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(rest: string) {
	const r = parseMarketplaceInstallArgs(rest);
	if ("error" in r) throw new Error(`Expected success, got error: ${r.error}`);
	return r;
}

function err(rest: string) {
	const r = parseMarketplaceInstallArgs(rest);
	if (!("error" in r)) throw new Error(`Expected error, got success: ${JSON.stringify(r)}`);
	return r.error;
}

// ── Success paths ─────────────────────────────────────────────────────────────

describe("parseMarketplaceInstallArgs — success", () => {
	it("bare spec → defaults force=false scope=user", () => {
		expect(ok("hello@market")).toEqual({ force: false, scope: "user", installSpec: "hello@market" });
	});

	it("--force flag", () => {
		expect(ok("--force hello@market")).toEqual({ force: true, scope: "user", installSpec: "hello@market" });
	});

	it("--scope user", () => {
		expect(ok("--scope user hello@market")).toEqual({ force: false, scope: "user", installSpec: "hello@market" });
	});

	it("--scope project", () => {
		expect(ok("--scope project hello@market")).toEqual({
			force: false,
			scope: "project",
			installSpec: "hello@market",
		});
	});

	it("--force and --scope project together", () => {
		expect(ok("--force --scope project hello@market")).toEqual({
			force: true,
			scope: "project",
			installSpec: "hello@market",
		});
	});

	it("flags after the positional", () => {
		expect(ok("hello@market --force")).toEqual({ force: true, scope: "user", installSpec: "hello@market" });
	});

	it("positional between flags", () => {
		expect(ok("--scope project hello@market --force")).toEqual({
			force: true,
			scope: "project",
			installSpec: "hello@market",
		});
	});

	it("extra whitespace is tolerated", () => {
		expect(ok("  hello@market  ")).toEqual({ force: false, scope: "user", installSpec: "hello@market" });
	});
});

// ── Error paths ───────────────────────────────────────────────────────────────

describe("parseMarketplaceInstallArgs — errors", () => {
	it("empty string → usage", () => {
		expect(err("")).toMatch(/Usage:/);
	});

	it("spec without @ → usage", () => {
		expect(err("hello-world")).toMatch(/Usage:/);
	});

	it("unknown flag → Unknown flag message", () => {
		expect(err("--froce hello@market")).toMatch(/Unknown flag.*--froce/);
	});

	it("unknown flag before positional still rejects", () => {
		expect(err("--unknown")).toMatch(/Unknown flag/);
	});

	it("invalid scope value → clear error", () => {
		expect(err("--scope admin hello@market")).toMatch(/Invalid --scope value.*admin/);
	});

	it("--scope with no value at end → requires a value", () => {
		expect(err("hello@market --scope")).toMatch(/requires a value/);
	});

	it("--scope followed immediately by another flag → requires a value", () => {
		expect(err("--scope --force hello@market")).toMatch(/requires a value/);
	});

	it("multiple positional args → unexpected argument", () => {
		expect(err("a@x b@y")).toMatch(/Unexpected argument/);
	});

	it("flags only, no positional → usage", () => {
		expect(err("--force")).toMatch(/Usage:/);
	});
});

// ── parsePluginScopeArgs ─────────────────────────────────────────────────────

function scopeOk(rest: string) {
	const r = parsePluginScopeArgs(rest, "Usage: /test [--scope user|project] <id@mkt>");
	if ("error" in r) throw new Error(`Expected success, got error: ${r.error}`);
	return r;
}

function scopeErr(rest: string) {
	const r = parsePluginScopeArgs(rest, "Usage: /test [--scope user|project] <id@mkt>");
	if (!("error" in r)) throw new Error(`Expected error, got success: ${JSON.stringify(r)}`);
	return r.error;
}

describe("parsePluginScopeArgs — success", () => {
	it("bare id → scope undefined", () => {
		expect(scopeOk("hello@market")).toEqual({ pluginId: "hello@market", scope: undefined });
	});

	it("--scope user", () => {
		expect(scopeOk("--scope user hello@market")).toEqual({ pluginId: "hello@market", scope: "user" });
	});

	it("--scope project", () => {
		expect(scopeOk("hello@market --scope project")).toEqual({ pluginId: "hello@market", scope: "project" });
	});

	it("extra whitespace is tolerated", () => {
		expect(scopeOk("  hello@market  ")).toEqual({ pluginId: "hello@market", scope: undefined });
	});
});

describe("parsePluginScopeArgs — errors", () => {
	it("empty string → usage hint", () => {
		expect(scopeErr("")).toMatch(/Usage:/);
	});

	it("unknown flag → Unknown flag message with usage", () => {
		expect(scopeErr("--froce hello@market")).toMatch(/Unknown flag.*--froce/);
	});

	it("multiple positional args → unexpected argument", () => {
		expect(scopeErr("a@x b@y")).toMatch(/Unexpected argument/);
	});

	it("invalid scope value → clear error", () => {
		expect(scopeErr("--scope admin hello@market")).toMatch(/Invalid --scope value.*admin/);
	});

	it("--scope with no value at end → requires a value", () => {
		expect(scopeErr("hello@market --scope")).toMatch(/requires a value/);
	});

	it("--scope followed by another flag → requires a value", () => {
		expect(scopeErr("--scope --other hello@market")).toMatch(/requires a value/);
	});
});

// extra error path: valid flags but no positional
describe("parsePluginScopeArgs — valid flags, missing id", () => {
	it("--scope with no plugin id → usage hint", () => {
		expect(scopeErr("--scope project")).toMatch(/Usage:/);
	});
});
