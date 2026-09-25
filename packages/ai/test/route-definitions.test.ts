import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadRouteDefinitionsFile, parseRouteDefinitions } from "@oh-my-pi/pi-ai/auth-gateway";
import * as AIError from "@oh-my-pi/pi-ai/error";

async function withTempFile(name: string, contents: string, run: (filePath: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "route-defs-"));
	const filePath = path.join(dir, name);
	try {
		await Bun.write(filePath, contents);
		await run(filePath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("parseRouteDefinitions", () => {
	it("parses a top-level array of route definitions", () => {
		const parsed = parseRouteDefinitions([{ id: "primary", root: { type: "target", model: "openai:gpt-4o" } }]);
		expect(parsed).toEqual([{ id: "primary", root: { type: "target", model: "openai:gpt-4o" } }]);
	});

	it("accepts an empty routes object wrapper", () => {
		expect(parseRouteDefinitions({ routes: [] })).toEqual([]);
	});

	it("parses a fallback tree keyed on provider_unavailable", () => {
		const parsed = parseRouteDefinitions({
			routes: [
				{
					id: "failover",
					root: {
						type: "fallback",
						on: ["provider_unavailable"],
						children: [
							{ type: "target", model: "openai:gpt-4o" },
							{ type: "target", model: "anthropic:claude-sonnet-4" },
						],
					},
				},
			],
		});
		expect(parsed).toEqual([
			{
				id: "failover",
				root: {
					type: "fallback",
					on: ["provider_unavailable"],
					children: [
						{ type: "target", model: "openai:gpt-4o" },
						{ type: "target", model: "anthropic:claude-sonnet-4" },
					],
				},
			},
		]);
	});

	it("rejects a definition missing id (negative)", () => {
		expect(() => parseRouteDefinitions([{ root: { type: "target", model: "openai:gpt-4o" } }])).toThrow(
			AIError.ValidationError,
		);
		expect(() => parseRouteDefinitions([{ root: { type: "target", model: "openai:gpt-4o" } }])).toThrow(/id/i);
	});

	it("rejects an unknown node type (negative)", () => {
		expect(() => parseRouteDefinitions([{ id: "bad", root: { type: "weighted", model: "openai:gpt-4o" } }])).toThrow(
			AIError.ValidationError,
		);
		expect(() => parseRouteDefinitions([{ id: "bad", root: { type: "weighted", model: "openai:gpt-4o" } }])).toThrow(
			/type/i,
		);
	});

	it("rejects an unknown disposition string (negative)", () => {
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: {
						type: "fallback",
						on: ["not_a_disposition"],
						children: [{ type: "target", model: "openai:gpt-4o" }],
					},
				},
			]),
		).toThrow(AIError.ValidationError);
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: {
						type: "fallback",
						on: ["not_a_disposition"],
						children: [{ type: "target", model: "openai:gpt-4o" }],
					},
				},
			]),
		).toThrow(/disposition/i);
	});

	it("rejects a fallback with empty children (negative)", () => {
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: { type: "fallback", on: ["provider_unavailable"], children: [] },
				},
			]),
		).toThrow(AIError.ValidationError);
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: { type: "fallback", on: ["provider_unavailable"], children: [] },
				},
			]),
		).toThrow(/empty/i);
	});

	it("parses a balance node", () => {
		const parsed = parseRouteDefinitions([
			{
				id: "lb",
				root: {
					type: "balance",
					strategy: "rr",
					children: [
						{ type: "target", model: "openai:gpt-4o" },
						{ type: "target", model: "anthropic:claude-sonnet-4" },
					],
				},
			},
		]);
		expect(parsed).toEqual([
			{
				id: "lb",
				root: {
					type: "balance",
					strategy: "rr",
					children: [
						{ type: "target", model: "openai:gpt-4o" },
						{ type: "target", model: "anthropic:claude-sonnet-4" },
					],
				},
			},
		]);
	});

	it("parses a weighted balance node", () => {
		const parsed = parseRouteDefinitions([
			{
				id: "weighted",
				root: {
					type: "balance",
					strategy: "weighted",
					children: [{ type: "target", model: "openai:gpt-4o" }],
				},
			},
		]);
		expect(parsed[0]?.root).toEqual({
			type: "balance",
			strategy: "weighted",
			children: [{ type: "target", model: "openai:gpt-4o" }],
		});
	});

	it("parses a conditional node", () => {
		const parsed = parseRouteDefinitions([
			{
				id: "vision",
				root: {
					type: "conditional",
					when: { vision: true },
					children: [{ type: "target", model: "openai:gpt-4o" }],
				},
			},
		]);
		expect(parsed).toEqual([
			{
				id: "vision",
				root: {
					type: "conditional",
					when: { vision: true },
					children: [{ type: "target", model: "openai:gpt-4o" }],
				},
			},
		]);
	});

	it("parses a domain node", () => {
		const parsed = parseRouteDefinitions([
			{
				id: "coding",
				root: {
					type: "domain",
					name: "coding",
					children: [{ type: "target", model: "openai:gpt-4o" }],
				},
			},
		]);
		expect(parsed).toEqual([
			{
				id: "coding",
				root: {
					type: "domain",
					name: "coding",
					children: [{ type: "target", model: "openai:gpt-4o" }],
				},
			},
		]);
	});

	it("parses a route-ref node", () => {
		const parsed = parseRouteDefinitions([{ id: "alias", root: { type: "route-ref", route: "primary" } }]);
		expect(parsed).toEqual([{ id: "alias", root: { type: "route-ref", route: "primary" } }]);
	});

	it("rejects a conditional node missing when (negative)", () => {
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: {
						type: "conditional",
						children: [{ type: "target", model: "openai:gpt-4o" }],
					},
				},
			]),
		).toThrow(AIError.ValidationError);
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: {
						type: "conditional",
						children: [{ type: "target", model: "openai:gpt-4o" }],
					},
				},
			]),
		).toThrow(/when/i);
	});
});

describe("loadRouteDefinitionsFile", () => {
	it("loads JSON5 with comments", async () => {
		const contents = `{
			// virtual primary
			routes: [
				{ id: "main", root: { type: "target", model: "openai:gpt-4o" } },
			],
		}`;
		await withTempFile("routes.json5", contents, async filePath => {
			const parsed = await loadRouteDefinitionsFile(filePath);
			expect(parsed).toEqual([{ id: "main", root: { type: "target", model: "openai:gpt-4o" } }]);
		});
	});

	it("throws ValidationError including the path when the file is missing (negative)", async () => {
		const missing = path.join(os.tmpdir(), `missing-routes-${crypto.randomUUID()}.json5`);
		let thrown: unknown;
		try {
			await loadRouteDefinitionsFile(missing);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AIError.ValidationError);
		if (!(thrown instanceof AIError.ValidationError)) return;
		expect(thrown.message).toContain(missing);
	});
});
