import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the capture worker's pure geometry without starting AppKit or capturing a screen.
test.skipIf(process.platform !== "darwin")(
	"window capture crops from a display only when the on-screen window lies wholly on it",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-capture-geometry-"));
		try {
			const binary = join(directory, "geometry-test");
			const include = join(import.meta.dir, "../../../crates/pi-natives/src/desktop/macos/capture");
			const source = `
#include "geometry.h"
#include <assert.h>
int main(void) {
	CGRect source = CGRectZero;
	CGRect left = CGRectMake(-800, 0, 800, 600), right = CGRectMake(0, 0, 1000, 800);
	assert(WindowCaptureDisplay(CGRectMake(10, 20, 200, 100), true, right, &source));
	assert(CGRectEqualToRect(source, CGRectMake(10, 20, 200, 100)));
	assert(WindowCaptureDisplay(CGRectMake(-500, 50, 300, 200), true, left, &source));
	assert(CGRectEqualToRect(source, CGRectMake(300, 50, 300, 200)));
	assert(WindowCaptureDisplay(CGRectMake(0, 0, 1000, 800), true, right, &source));
	source = CGRectZero;
	// Spanning two displays, partly off screen, or not on screen: captured on its own.
	CGRect spanning = CGRectMake(-100, 50, 500, 300);
	assert(!WindowCaptureDisplay(spanning, true, left, &source));
	assert(!WindowCaptureDisplay(spanning, true, right, &source));
	assert(!WindowCaptureDisplay(CGRectMake(900, 50, 500, 300), true, right, &source));
	assert(!WindowCaptureDisplay(CGRectMake(10, 20, 200, 100), false, right, &source));
	assert(!WindowCaptureDisplay(CGRectMake(10, 20, 0, 100), true, right, &source));
	assert(CGRectEqualToRect(source, CGRectZero));
	return 0;
}`;
			const compile = Bun.spawn(
				["xcrun", "clang", "-x", "c", "-I", include, "-framework", "CoreGraphics", "-o", binary, "-"],
				{
					stdin: new TextEncoder().encode(source),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = await new Response(compile.stderr).text();
			expect(await compile.exited, stderr).toBe(0);
			const run = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
			expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
