import { describe, expect, it } from "bun:test";
import { findToolRenderer } from "../src/tools/find";
import { nameSearchRenderer } from "../src/tools/glob";
import { contentSearchRenderer } from "../src/tools/grep";

describe("findToolRenderer mode dispatch", () => {
	it("renders a pattern call with the content renderer", () => {
		expect(findToolRenderer.describeCall({ pattern: "x" } as never)).toEqual(
			contentSearchRenderer.describeCall({ pattern: "x" } as never),
		);
	});

	it("renders a glob call with the names renderer", () => {
		expect(findToolRenderer.describeCall({ glob: "*.ts" } as never)).toEqual(
			nameSearchRenderer.describeCall({ glob: "*.ts" } as never),
		);
	});

	it("renders a query call with neither the content nor the names renderer", () => {
		const view = findToolRenderer.describeCall({ query: "where" } as never);
		expect(view).not.toEqual(contentSearchRenderer.describeCall({ query: "where" } as never));
		expect(view).not.toEqual(nameSearchRenderer.describeCall({ query: "where" } as never));
	});
});
