import { expect, it } from "bun:test";
import { getEditInputPaths } from "../src/edit/renderer";

it("keeps apply-patch targets when unchanged source contains a sloppy marker", () => {
	const input = "*** Begin Patch\n*** Update File: target.txt\n@@\n <SM: example>\n-old\n+new\n*** End Patch";
	expect(getEditInputPaths(input, "apply_patch")).toEqual(["target.txt"]);
	expect(getEditInputPaths(input)).toEqual(["target.txt"]);
});

it("keeps hashline targets and move destinations with an explicit hashline mode", () => {
	const input = "*** Begin Patch\n[target.txt#ABCD]\nPUT 1.=1:\n+<SM: example>\nMV renamed.txt\n*** End Patch";
	expect(getEditInputPaths(input, "hashline")).toEqual(["target.txt", "renamed.txt"]);
});
