import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@pk-nerdsaver-ai/pi-coding-agent/capability";
import { loadOkfConcepts } from "@pk-nerdsaver-ai/pi-coding-agent/discovery/okf";

const tempRoots: string[] = [];

function makeBundle(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-discovery-test-"));
	tempRoots.push(dir);
	return dir;
}

function writeConcept(
	bundleRoot: string,
	relativePath: string,
	frontmatter: Record<string, unknown>,
	body: string,
): void {
	const fullPath = path.join(bundleRoot, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	const yaml = Object.entries(frontmatter)
		.map(([k, v]) => {
			if (Array.isArray(v)) return `${k}: [${v.map(item => JSON.stringify(item)).join(", ")}]`;
			if (typeof v === "string") return `${k}: ${JSON.stringify(v)}`;
			return `${k}: ${String(v)}`;
		})
		.join("\n");
	const content = `---\n${yaml}\n---\n\n${body}\n`;
	fs.writeFileSync(fullPath, content, "utf8");
}

function ctxFor(projectBundle: string, home = projectBundle): LoadContext {
	return { cwd: projectBundle, home, repoRoot: projectBundle };
}

beforeEach(() => {
	tempRoots.length = 0;
});

afterEach(() => {
	for (const dir of tempRoots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("OKF discovery provider", () => {
	it("loads concept documents from the project's .wiki bundle", async () => {
		const projectBundle = makeBundle();
		const wiki = path.join(projectBundle, ".wiki");
		const home = makeBundle();
		writeConcept(
			wiki,
			"tables/orders.md",
			{ type: "BigQuery Table", title: "Orders", tags: ["sales"] },
			"See [customers](/tables/customers.md).",
		);
		writeConcept(wiki, "tables/customers.md", { type: "BigQuery Table", title: "Customers" }, "Part of the bundle.");

		const result = await loadOkfConcepts(ctxFor(projectBundle, home));
		const items = result.items.filter(concept => concept.bundleRoot === wiki);
		expect(items).toHaveLength(2);
		const orders = items.find(item => item.id === "tables/orders");
		expect(orders?.title).toBe("Orders");
		expect(orders?.tags).toEqual(["sales"]);
		expect(orders?.links[0]?.conceptId).toBe("tables/customers");
	});

	it("accepts index.md without requiring a type field", async () => {
		const projectBundle = makeBundle();
		const wiki = path.join(projectBundle, ".wiki");
		const home = makeBundle();
		writeConcept(wiki, "tables/index.md", { okf_version: "0.1" }, "# Tables\n\n* [orders](orders.md)");

		const result = await loadOkfConcepts(ctxFor(projectBundle, home));
		const index = result.items.find(item => item.id === "tables/index");
		expect(index).toBeDefined();
		expect(index?.type).toBe("");
		expect(index?.okfVersion).toBe("0.1");
	});

	it("emits a warning for a concept missing the required type field", async () => {
		const projectBundle = makeBundle();
		const wiki = path.join(projectBundle, ".wiki");
		const home = makeBundle();
		fs.mkdirSync(path.join(wiki, "broken"), { recursive: true });
		fs.writeFileSync(path.join(wiki, "broken/no-type.md"), "---\ntitle: no type\n---\nbody", "utf8");

		const result = await loadOkfConcepts(ctxFor(projectBundle, home));
		expect(result.items).toHaveLength(0);
		expect(result.warnings?.some(w => w.includes("missing required `type`"))).toBe(true);
	});

	it("keeps project and user bundle concepts separate when their ids differ", async () => {
		const projectBundle = makeBundle();
		const wiki = path.join(projectBundle, ".wiki");
		const home = makeBundle();
		const userOkf = path.join(home, ".ompk", "okf");
		writeConcept(wiki, "tables/orders.md", { type: "BigQuery Table", title: "Project" }, "project body");
		writeConcept(userOkf, "tables/users.md", { type: "BigQuery Table", title: "User" }, "user body");

		const result = await loadOkfConcepts(ctxFor(projectBundle, home));
		expect(result.items).toHaveLength(2);
		expect(result.items.find(item => item.id === "tables/orders")?.bundleRoot).toBe(wiki);
		expect(result.items.find(item => item.id === "tables/users")?.bundleRoot).toBe(userOkf);
	});
});
