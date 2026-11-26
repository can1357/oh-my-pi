import { describe, expect, it } from "bun:test";
import { formatRawOutputNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta-format";
import { stripRawOutputNotice } from "../../src/ui/tools/run";

describe("bash raw-output footer", () => {
	// Failure a consumer sees if this regresses: a model that follows the footer reads
	// the bare spill, which is paged and column-capped, instead of the original output;
	// and the renderer keeps the footer line in the minimized text.
	it("names the :raw selector and reads back through the strip", () => {
		const footer = formatRawOutputNotice("5");
		expect(footer).toBe("[raw output: local://5.log:raw]");
		expect(stripRawOutputNotice(`diff --git a/f b/f\n-old\n+new\n${footer}`)).toEqual({
			text: "diff --git a/f b/f\n-old\n+new",
			artifactId: "5",
		});
	});

	// Failure a consumer sees: a session saved before the selector was added shows its
	// footer text in the renderer.
	it("still strips the bare footer that earlier sessions persisted", () => {
		expect(stripRawOutputNotice("out\n[raw output: local://5.log]")).toEqual({
			text: "out",
			artifactId: "5",
		});
	});
});
