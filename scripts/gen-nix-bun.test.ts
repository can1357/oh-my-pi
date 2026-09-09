import { describe, expect, test } from "bun:test";
import {
	BUN2NIX_NPM_SPEC,
	normalizeGeneratedNix,
	normalizeLockfileVersion,
	resolveNixBunDepsGenerator,
} from "./gen-nix-bun";

describe("resolveNixBunDepsGenerator", () => {
	test("prefers bun2nix from the active development shell", () => {
		const generator = resolveNixBunDepsGenerator(command => {
			if (command === "bun2nix") return "/nix/store/bun2nix";
			return "/nix/store/nix";
		});

		expect(generator).toEqual({ kind: "bun2nix", executable: "/nix/store/bun2nix" });
	});

	test("falls back to entering the Nix development shell", () => {
		const generator = resolveNixBunDepsGenerator(command => (command === "nix" ? "/usr/bin/nix" : null));

		expect(generator).toEqual({ kind: "nix", executable: "/usr/bin/nix" });
	});

	test("falls back to the pinned portable bunx package", () => {
		expect(resolveNixBunDepsGenerator(() => null)).toEqual({
			kind: "bunx",
			package: BUN2NIX_NPM_SPEC,
		});
	});
});
describe("normalizeLockfileVersion", () => {
	test("restamps a Bun 1.4 version-2 lockfile to the bun2nix-supported version 1", () => {
		const lock = '{\n  "lockfileVersion": 2,\n  "configVersion": 1,\n  "workspaces": {},\n}\n';
		expect(normalizeLockfileVersion(lock)).toBe(
			'{\n  "lockfileVersion": 1,\n  "configVersion": 1,\n  "workspaces": {},\n}\n',
		);
	});

	test("leaves a version-1 lockfile byte-identical", () => {
		const lock = '{\n  "lockfileVersion": 1,\n  "workspaces": {},\n}\n';
		expect(normalizeLockfileVersion(lock)).toBe(lock);
	});

	test("rejects version 3+, whose scoped-override content cannot be downgraded", () => {
		expect(() => normalizeLockfileVersion('{\n  "lockfileVersion": 3,\n}\n')).toThrow(/lockfileVersion 3/);
	});

	test("rejects a lockfile without a version stamp", () => {
		expect(() => normalizeLockfileVersion("{}\n")).toThrow(/missing a lockfileVersion/);
	});
});

describe("normalizeGeneratedNix", () => {
	test("writes exactly one trailing LF for every generator output shape", () => {
		expect(normalizeGeneratedNix("}")).toBe("}\n");
		expect(normalizeGeneratedNix("}\n")).toBe("}\n");
		expect(normalizeGeneratedNix("}\r\n\r\n")).toBe("}\n");
	});
});
