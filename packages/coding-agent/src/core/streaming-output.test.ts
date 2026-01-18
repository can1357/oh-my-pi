import { describe, expect, it } from "bun:test";
import { createOutputSink } from "./streaming-output";

function makeLargeOutput(size: number): string {
	return "x".repeat(size);
}

describe("createOutputSink", () => {
	it("spills to disk and truncates large output", async () => {
		const largeOutput = makeLargeOutput(60_000);
		const sink = createOutputSink(10, 70_000);
		const writer = sink.getWriter();

		await writer.write(largeOutput);
		await writer.close();

		const result = sink.dump();

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(result.output.length).toBeLessThan(largeOutput.length);

		const fullOutput = await Bun.file(result.fullOutputPath!).text();
		expect(fullOutput).toBe(largeOutput);
	});
});
