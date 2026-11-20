import { describe, expect, it } from "bun:test";
import * as PiCodingAgent from "@oh-my-pi/pi-coding-agent";

/**
 * Extensions import host helpers from the package root: a static import of an
 * internal file path fails the whole extension when that file moves. If one of
 * these root exports disappears, extensions that use it stop loading.
 */
const rootHelpers: [name: string, kind: "function" | "object"][] = [
	["formTheme", "object"],
	["compactText", "function"],
	["rowsText", "function"],
	["styledSpans", "function"],
	["parseXdUrl", "function"],
	["cfgExtensionTranscriptPresenters", "object"],
];

describe("extension helpers exported from the package root", () => {
	const root = PiCodingAgent as Record<string, unknown>;

	it.each(rootHelpers)("exports %s as a %s", (name, kind) => {
		expect(root[name]).not.toBeNull();
		expect(typeof root[name]).toBe(kind);
	});
});
