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
