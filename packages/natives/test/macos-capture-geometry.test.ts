import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the capture worker's pure geometry without starting AppKit or capturing a screen.
test.skipIf(process.platform !== "darwin")(
	"window capture selects and clips the largest on-screen display intersection",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-capture-geometry-"));
		try {
			const binary = join(directory, "geometry-test");
			const include = fileURLToPath(
				new URL("../../../crates/pi-natives/src/desktop/macos/capture", import.meta.url),
			);
			const source = `
#include "geometry.h"
#include <assert.h>
int main(void) {
	CGRect bounds = CGRectZero, source = CGRectZero;
	CGRect window = CGRectMake(-100, 50, 500, 300);
	CGRect left = CGRectMake(-800, 0, 800, 600), right = CGRectMake(0, 0, 1000, 800);
	assert(WindowCaptureDisplay(window, true, left, &bounds, &source));
	assert(CGRectEqualToRect(bounds, CGRectMake(-100, 50, 100, 300)));
	assert(CGRectEqualToRect(source, CGRectMake(700, 50, 100, 300)));
	assert(WindowCaptureDisplay(window, true, right, &bounds, &source));
	assert(CGRectEqualToRect(bounds, CGRectMake(0, 50, 400, 300)));
	assert(CGRectEqualToRect(source, bounds));
	assert(!WindowCaptureDisplay(window, true, left, &bounds, &source));
	assert(!WindowCaptureDisplay(window, true, right, &bounds, &source));
	bounds = CGRectZero;
	assert(!WindowCaptureDisplay(window, false, right, &bounds, &source));
	assert(!WindowCaptureDisplay(CGRectMake(1000, 50, 500, 300), true, right, &bounds, &source));
	assert(!WindowCaptureDisplay(CGRectMake(1200, 50, 500, 300), true, right, &bounds, &source));
	assert(CGRectEqualToRect(bounds, CGRectZero));
	assert(WindowCaptureDisplay(CGRectMake(10, 20, 200, 100), true, right, &bounds, &source));
	assert(CGRectEqualToRect(bounds, CGRectMake(10, 20, 200, 100)));
	assert(CGRectEqualToRect(source, bounds));
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
