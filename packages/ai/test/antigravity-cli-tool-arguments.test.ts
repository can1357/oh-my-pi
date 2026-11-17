import { describe, expect, it } from "bun:test";
import { normalizeToolArguments } from "@oh-my-pi/pi-ai/providers/antigravity-cli/tool-arguments";

const fileSchema = {
	type: "object",
	properties: {
		file_path: { type: "string" },
		description: { type: "string" },
	},
	required: ["file_path"],
};

describe("normalizeToolArguments", () => {
	it("renames a single alias to the single schema property", () => {
		const input = { path: "/tmp/a.ts", description: "read" };
		const { arguments: args, renamed } = normalizeToolArguments(fileSchema, input);
		expect(renamed).toEqual([{ from: "path", to: "file_path" }]);
		expect(args).toEqual({ file_path: "/tmp/a.ts", description: "read" });
		expect(input).toEqual({ path: "/tmp/a.ts", description: "read" });
	});

	it("renames every unambiguous group in one call", () => {
		const schema = {
			type: "object",
			properties: {
				file_path: { type: "string" },
				command_line: { type: "string" },
				working_dir: { type: "string" },
				Description: { type: "string" },
			},
		};
		const { arguments: args, renamed } = normalizeToolArguments(schema, {
			absolute_path: "/a",
			command: "ls",
			cwd: "/tmp",
			description: "list",
		});
		expect(renamed).toEqual([
			{ from: "absolute_path", to: "file_path" },
			{ from: "command", to: "command_line" },
			{ from: "cwd", to: "working_dir" },
			{ from: "description", to: "Description" },
		]);
		expect(args).toEqual({ file_path: "/a", command_line: "ls", working_dir: "/tmp", Description: "list" });
	});

	it("keeps the original arguments when the target is already present", () => {
		const { arguments: args, renamed } = normalizeToolArguments(fileSchema, { file_path: "/a", path: "/b" });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ file_path: "/a", path: "/b" });
	});

	it("keeps the original arguments when the schema declares two group members", () => {
		const schema = {
			type: "object",
			properties: { path: { type: "string" }, file_path: { type: "string" } },
			required: ["file_path"],
		};
		const { arguments: args, renamed } = normalizeToolArguments(schema, { absolute_path: "/a" });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ absolute_path: "/a" });
	});

	it("counts a group member declared only in required as ambiguity", () => {
		const schema = {
			type: "object",
			properties: { file_path: { type: "string" } },
			required: ["file_path", "path"],
		};
		const { arguments: args, renamed } = normalizeToolArguments(schema, { path: "/a" });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ path: "/a" });
	});

	it("does not rename to a target declared only in required", () => {
		const schema = { type: "object", properties: {}, required: ["file_path"] };
		const { arguments: args, renamed } = normalizeToolArguments(schema, { path: "/a" });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ path: "/a" });
	});

	it("keeps the original arguments when the input carries two group members", () => {
		const { arguments: args, renamed } = normalizeToolArguments(fileSchema, { path: "/a", absolute_path: "/b" });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ path: "/a", absolute_path: "/b" });
	});

	it("keeps the original arguments when the schema property is not a string", () => {
		const schema = { type: "object", properties: { file_path: { type: "number" } }, required: ["file_path"] };
		const { arguments: args, renamed } = normalizeToolArguments(schema, { path: "/a" });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ path: "/a" });
	});

	it("keeps the original arguments when the input value is not a string", () => {
		const { arguments: args, renamed } = normalizeToolArguments(fileSchema, { path: 42 });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ path: 42 });
	});

	it("keeps the original arguments when the schema lacks the group target", () => {
		const schema = { type: "object", properties: { contents: { type: "string" } } };
		const { arguments: args, renamed } = normalizeToolArguments(schema, { path: "/a" });
		expect(renamed).toEqual([]);
		expect(args).toEqual({ path: "/a" });
	});

	it("returns non-object schemas and arguments unchanged", () => {
		expect(normalizeToolArguments(undefined, { path: "/a" })).toEqual({ arguments: { path: "/a" }, renamed: [] });
		expect(normalizeToolArguments("not a schema", { path: "/a" })).toEqual({
			arguments: { path: "/a" },
			renamed: [],
		});
		expect(normalizeToolArguments({ type: "object" }, { path: "/a" })).toEqual({
			arguments: { path: "/a" },
			renamed: [],
		});
		expect(normalizeToolArguments(fileSchema, null)).toEqual({ arguments: null, renamed: [] });
		expect(normalizeToolArguments(fileSchema, "/a")).toEqual({ arguments: "/a", renamed: [] });
		expect(normalizeToolArguments(fileSchema, ["path"])).toEqual({ arguments: ["path"], renamed: [] });
	});

	it("does not rename inherited keys", () => {
		const args = Object.create({ path: "/a" }) as Record<string, unknown>;
		const { arguments: normalized, renamed } = normalizeToolArguments(fileSchema, args);
		expect(renamed).toEqual([]);
		expect(normalized).toEqual({});
	});
});
