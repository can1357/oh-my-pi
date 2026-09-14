import { expect, it } from "bun:test";
import { formatTaskResultPreview } from "../../src/task/result-preview";

it.each(["output", "preview"])("retains literal closing %s tags inside task output", tag => {
	const body = `Example </${tag}> remains in the result\nFinal result`;
	const envelope = `<task-result status="completed"><${tag}>\n${body}\n</${tag}>\n<merge-summary>Applied without conflicts</merge-summary>\n</task-result>`;
	expect(formatTaskResultPreview(envelope)).toBe(`${body}\n\nApplied without conflicts`);
});
