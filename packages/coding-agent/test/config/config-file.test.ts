import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { ConfigError, ConfigFile } from "../../src/config/config-file";

const schema = type({ enabled: "boolean" });

describe("ConfigFile schema validation", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "config-validation-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it.each(["json", "yml"])("rejects invalid %s values in both sync and async loaders", async extension => {
		const file = new ConfigFile<{ enabled: boolean }>("test", schema, join(directory, `test.${extension}`));
		await Bun.write(file.path(), extension === "json" ? '{"enabled":"yes"}' : 'enabled: "yes"');
		const sync = file.tryLoad();
		expect(sync.status).toBe("error");
		expect(sync.error).toBeInstanceOf(ConfigError);
		expect(sync.value).toBeUndefined();
		file.invalidate();
		const asyncResult = await file.tryLoadAsync();
		expect(asyncResult.status).toBe("error");
		if (asyncResult.status === "error") expect(asyncResult.error.message).toContain("enabled");
	});

	it("reloads a repaired file after invalidation and runs auxiliary validation only on valid data", async () => {
		const validated: boolean[] = [];
		const file = new ConfigFile<{ enabled: boolean }>("test", schema, join(directory, "test.json")).withValidation(
			"enabled",
			value => {
				validated.push(value.enabled);
			},
		);
		await Bun.write(file.path(), '{"enabled":"yes"}');
		expect((await file.tryLoadAsync()).status).toBe("error");
		expect(validated).toEqual([]);
		await Bun.write(file.path(), '{"enabled":false}');
		file.invalidate();
		expect(await file.tryLoadAsync()).toEqual({ status: "ok", value: { enabled: false } });
		expect(validated).toEqual([false]);
	});

	it("does not treat ArkErrors as a default value", () => {
		const required = new ConfigFile<{ enabled: boolean }>("required", schema, join(directory, "required.json"));
		expect(() => required.createDefault()).toThrow(ConfigError);
		const defaulted = new ConfigFile<{ enabled: boolean }>(
			"defaulted",
			type({ enabled: "boolean = false" }),
			join(directory, "defaulted.json"),
		);
		expect(defaulted.createDefault()).toEqual({ enabled: false });
	});
});

describe("ConfigFile empty documents", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "config-empty-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	const optionalSchema = type({ "enabled?": "boolean" });

	it.each([
		["empty", ""],
		["whitespace", "  \n\t  "],
		["comment-only", "# just a comment\n"],
		["null literal", "null\n"],
		["tilde", "~\n"],
	])("treats %s yml as an empty object in both loaders", async (label, content) => {
		const slug = String(label).replace(/[^a-z0-9]+/gi, "-");
		const file = new ConfigFile<{ enabled?: boolean }>("test", optionalSchema, join(directory, `${slug}.yml`));
		await Bun.write(file.path(), content);
		const sync = file.tryLoad();
		expect(sync.status).toBe("ok");
		expect(sync.value).toEqual({});
		file.invalidate();
		const asyncResult = await file.tryLoadAsync();
		expect(asyncResult.status).toBe("ok");
		expect(asyncResult.value).toEqual({});
	});

	it.each([
		["empty", ""],
		["null literal", "null"],
	])("treats %s json as an empty object", async (label, content) => {
		const slug = String(label).replace(/[^a-z0-9]+/gi, "-");
		const file = new ConfigFile<{ enabled?: boolean }>("test", optionalSchema, join(directory, `${slug}.json`));
		await Bun.write(file.path(), content);
		expect(file.tryLoad()).toEqual({ status: "ok", value: {} });
		file.invalidate();
		expect(await file.tryLoadAsync()).toEqual({ status: "ok", value: {} });
	});

	it.each(["", "null", "  \n  "])("migrates empty legacy JSON %j", async content => {
		await Bun.write(join(directory, "legacy.json"), content);
		const file = new ConfigFile("legacy", optionalSchema, join(directory, "legacy.yml"));
		expect(file.tryLoad()).toEqual({ status: "ok", value: {} });
		file.invalidate();
		expect(await file.tryLoadAsync()).toEqual({ status: "ok", value: {} });
	});

	it("discovers legacy JSON created after a missing-file load", async () => {
		const file = new ConfigFile("late", optionalSchema, join(directory, "late.yml"));
		expect(file.tryLoad().status).toBe("not-found");
		await Bun.write(join(directory, "late.json"), '{"enabled":true}');
		file.invalidate();
		expect(await file.tryLoadAsync()).toEqual({ status: "ok", value: { enabled: true } });
	});

	it.each(["false", "0", '"invalid"'])("rejects invalid legacy JSON root %s", async content => {
		await Bun.write(join(directory, "invalid.json"), content);
		const file = new ConfigFile("invalid", optionalSchema, join(directory, "invalid.yml"));
		expect(file.tryLoad().status).toBe("error");
	});

	it("still rejects empty documents when fields are required", async () => {
		const file = new ConfigFile("required", schema, join(directory, "required.yml"));
		await Bun.write(file.path(), "null");
		expect(file.tryLoad().status).toBe("error");
		file.invalidate();
		expect((await file.tryLoadAsync()).status).toBe("error");
	});

	it.each(["json", "yml"])("preserves schema-valid null in %s", async extension => {
		const file = new ConfigFile("nullable", type("null"), join(directory, `nullable.${extension}`));
		await Bun.write(file.path(), "null");
		expect(file.tryLoad()).toEqual({ status: "ok", value: null });
		expect(file.loadOrDefault()).toBeNull();
		file.invalidate();
		expect(await file.loadOrDefaultAsync()).toBeNull();
	});

	it("applies validators added after a successful cached load", async () => {
		const file = new ConfigFile("validation", optionalSchema, join(directory, "validation.json"));
		await Bun.write(file.path(), "{}");
		expect(file.tryLoad().status).toBe("ok");
		file.withValidation("reject", () => {
			throw new Error("rejected");
		});
		const result = await file.tryLoadAsync();
		expect(result.status).toBe("error");
		if (result.status === "error") expect(result.error.message).toContain("rejected");
	});

	it("loads an empty models.yml without a schema error", async () => {
		const { ModelsConfigFile } = await import("../../src/config/models-config");
		const file = ModelsConfigFile.relocate(join(directory, "models.yml"));
		await Bun.write(file.path(), "");
		const result = file.tryLoad();
		expect(result.status).toBe("ok");
		expect(result.value).toEqual({});
	});
});
