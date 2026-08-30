import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createAgentDefinitionIdentity,
	createAgentDefinitionIdentityFromOrigin,
	createAgentDefinitionOriginIdentity,
} from "@oh-my-pi/pi-coding-agent/task/agent-definition-identity";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("agent definition identity", () => {
	test("canonical path aliases retain one origin and exact definition identity", async () => {
		const temp = TempDir.createSync("omp-agent-definition-identity-");
		tempDirs.push(temp);
		const tempRoot = path.resolve(temp.path());
		const packageRoot = path.join(tempRoot, "real-package");
		const agentsDir = path.join(packageRoot, "agents");
		const definitionPath = path.join(agentsDir, "worker.md");
		const aliasRoot = path.join(tempRoot, "package-alias");
		const definition = "---\nname: worker\ndescription: worker\n---\nbody\n";
		await fs.mkdir(agentsDir, { recursive: true });
		await Bun.write(definitionPath, definition);
		await fs.symlink(packageRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

		const canonical = await createAgentDefinitionIdentity("extension", packageRoot, definitionPath, definition);
		const aliased = await createAgentDefinitionIdentity(
			"extension",
			aliasRoot,
			path.join(aliasRoot, "agents", "worker.md"),
			definition,
		);

		expect(aliased).toEqual(canonical);
		expect(Object.isFrozen(canonical)).toBe(true);
		if (process.platform === "win32") {
			const caseAlias = await createAgentDefinitionIdentity(
				"extension",
				packageRoot.toUpperCase(),
				definitionPath.toUpperCase().replaceAll("\\", "/"),
				definition,
			);
			expect(caseAlias).toEqual(canonical);
		}
	});

	test("origin kind, definition location, and exact parser input occupy distinct identity domains", async () => {
		const temp = TempDir.createSync("omp-agent-definition-domains-");
		tempDirs.push(temp);
		const packageRoot = path.join(path.resolve(temp.path()), "package");
		const firstPath = path.join(packageRoot, "agents", "worker.md");
		const secondPath = path.join(packageRoot, "agents", "worker-copy.md");
		const definition = "---\nname: worker\ndescription: worker\n---\nbody\n";
		await fs.mkdir(path.dirname(firstPath), { recursive: true });
		await Promise.all([Bun.write(firstPath, definition), Bun.write(secondPath, definition)]);

		const extensionOrigin = await createAgentDefinitionOriginIdentity("extension", packageRoot);
		const projectOrigin = await createAgentDefinitionOriginIdentity("project", packageRoot);
		const first = await createAgentDefinitionIdentity("extension", packageRoot, firstPath, definition);
		const moved = await createAgentDefinitionIdentity("extension", packageRoot, secondPath, definition);
		const changed = await createAgentDefinitionIdentity(
			"extension",
			packageRoot,
			firstPath,
			`${definition}changed\n`,
		);

		expect(projectOrigin.originId).not.toBe(extensionOrigin.originId);
		expect(first.originId).toBe(extensionOrigin.originId);
		expect(moved.originId).toBe(first.originId);
		expect(changed.originId).toBe(first.originId);
		expect(moved.definitionId).not.toBe(first.definitionId);
		expect(changed.definitionId).not.toBe(first.definitionId);
		expect(Object.isFrozen(extensionOrigin)).toBe(true);
	});

	test("precomputed directory origin retains exact location and content definition domains", async () => {
		const temp = TempDir.createSync("omp-agent-definition-precomputed-origin-");
		tempDirs.push(temp);
		const packageRoot = path.join(path.resolve(temp.path()), "package");
		const firstPath = path.join(packageRoot, "agents", "first.md");
		const secondPath = path.join(packageRoot, "agents", "second.md");
		const firstContent = "---\nname: first\ndescription: first\n---\nfirst body\n";
		const secondContent = "---\nname: second\ndescription: second\n---\nsecond body\n";
		await fs.mkdir(path.dirname(firstPath), { recursive: true });
		await Promise.all([Bun.write(firstPath, firstContent), Bun.write(secondPath, secondContent)]);

		const origin = await createAgentDefinitionOriginIdentity("extension", packageRoot);
		const first = await createAgentDefinitionIdentityFromOrigin(origin, firstPath, firstContent);
		const second = await createAgentDefinitionIdentityFromOrigin(origin, secondPath, secondContent);
		const changed = await createAgentDefinitionIdentityFromOrigin(origin, firstPath, `${firstContent}changed\n`);
		const standalone = await createAgentDefinitionIdentity("extension", packageRoot, firstPath, firstContent);

		expect(first).toEqual(standalone);
		expect(first).toMatchObject(origin);
		expect(second).toMatchObject(origin);
		expect(changed).toMatchObject(origin);
		expect(second.definitionId).not.toBe(first.definitionId);
		expect(changed.definitionId).not.toBe(first.definitionId);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(second)).toBe(true);
	});
});
