import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyphonicRecallEngine } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";

const roots: string[] = [];
const toggleNames = [
	"MNEMOPI_VOICE_VECTOR",
	"MNEMOPI_VOICE_GRAPH",
	"MNEMOPI_VOICE_FACT",
	"MNEMOPI_VOICE_TEMPORAL",
] as const;
const savedEnv: Partial<Record<(typeof toggleNames)[number], string>> = {};

function tempDb(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-ab-toggle-"));
	roots.push(root);
	return join(root, "mnemopi.db");
}

function withEngine<T>(fn: (engine: PolyphonicRecallEngine) => T): T {
	const engine = new PolyphonicRecallEngine({ dbPath: tempDb() });
	try {
		return fn(engine);
	} finally {
		engine.close();
	}
}

afterEach(() => {
	for (const name of toggleNames) {
		const value = savedEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
});

for (const name of toggleNames) savedEnv[name] = process.env[name];

describe("A/B polyphonic voice toggles", () => {
	it("treats falsy values as disabled with whitespace and case normalization", () => {
		const falsyValues = ["0", "false", "no", "off", "FALSE", "Off", " 0 ", "\toff\t"];
		for (const value of falsyValues) {
			withEngine(engine => {
				process.env.MNEMOPI_VOICE_VECTOR = value;
				process.env.MNEMOPI_VOICE_GRAPH = value;
				process.env.MNEMOPI_VOICE_FACT = value;
				process.env.MNEMOPI_VOICE_TEMPORAL = value;
				expect(engine.vectorVoice(new Float32Array([1, 0, 0]))).toEqual([]);
				expect(engine.graphVoice("Alice owns the service")).toEqual([]);
				expect(engine.factVoice("deploy service")).toEqual([]);
				expect(engine.temporalVoice("recent activity yesterday")).toEqual([]);
			});
		}
	});

	it("keeps voices enabled for unset, truthy, empty, and unrecognized values", () => {
		const enabledValues = [undefined, "1", "true", "yes", "on", "", " ", "maybe"];
		for (const value of enabledValues) {
			withEngine(engine => {
				if (value === undefined) {
					delete process.env.MNEMOPI_VOICE_GRAPH;
					delete process.env.MNEMOPI_VOICE_FACT;
					delete process.env.MNEMOPI_VOICE_TEMPORAL;
				} else {
					process.env.MNEMOPI_VOICE_GRAPH = value;
					process.env.MNEMOPI_VOICE_FACT = value;
					process.env.MNEMOPI_VOICE_TEMPORAL = value;
				}
				expect(Array.isArray(engine.graphVoice("Alice owns the service"))).toBe(true);
				expect(Array.isArray(engine.factVoice("deploy service"))).toBe(true);
				expect(Array.isArray(engine.temporalVoice("recent activity yesterday"))).toBe(true);
			});
		}
	});

	it("documents every in-scope polyphonic voice toggle in the source contract", () => {
		withEngine(engine => {
			process.env.MNEMOPI_VOICE_VECTOR = "0";
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_FACT = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";
			expect(engine.recall("recent Alice deploy", new Float32Array([1, 0, 0]), 10)).toEqual([]);
		});
	});
});
