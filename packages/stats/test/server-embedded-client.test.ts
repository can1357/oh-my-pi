import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";

const tempDirs: string[] = [];
const children: Array<Subprocess<"ignore", "pipe", "pipe">> = [];
const clientFiles = {
	"index.html": '<!doctype html><html><body><script type="module" src="/index.js"></script></body></html>',
	"index.js": 'document.documentElement.dataset.loaded = "true";',
	"styles.css": "body { color: blue; }",
};

async function startEmbeddedDashboard(): Promise<{ url: string; tmpDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-embedded-"));
	tempDirs.push(root);
	const tmpDir = path.join(root, "tmp");
	await fs.mkdir(tmpDir);
	const archive = Buffer.from(Bun.gzipSync(await new Bun.Archive(clientFiles).bytes())).toString("base64");
	const preload = path.join(root, "preload.ts");
	const entrypoint = path.join(root, "server.ts");
	// Keep the embedded-archive loader and directory overrides in a child process.
	await Bun.write(
		preload,
		`Bun.plugin({
	name: "embedded-stats-client-fixture",
	setup(build) {
		build.onLoad({ filter: /embedded-client\\.generated\\.txt$/ }, () => ({
			exports: { default: ${JSON.stringify(archive)} }, loader: "object",
		}));
	},
});`,
	);
	await Bun.write(
		entrypoint,
		`import { startServer } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/server.ts"))};
const server = await startServer(0);
process.stdout.write(JSON.stringify({ url: "http://" + server.hostname + ":" + server.port }));`,
	);
	const child = Bun.spawn([process.execPath, "--preload", preload, entrypoint], {
		cwd: root,
		env: {
			...process.env,
			HOME: root,
			USERPROFILE: root,
			TMPDIR: tmpDir,
			TMP: tmpDir,
			TEMP: tmpDir,
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent"),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_CACHE_HOME: path.join(root, "cache"),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const ready = await reader.read();
	reader.releaseLock();
	if (ready.done) {
		throw new Error(`Dashboard failed to start: ${await new Response(child.stderr).text()}`);
	}
	const { url }: { url: string } = JSON.parse(new TextDecoder().decode(ready.value));
	return { url, tmpDir };
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill();
		await child.exited;
	}
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("embedded dashboard serves its assets and SPA routes after temporary files are removed", async () => {
	const { url, tmpDir } = await startEmbeddedDashboard();
	const initial = await fetch(url);
	expect(initial.status).toBe(200);
	expect(await initial.text()).toBe(clientFiles["index.html"]);

	// Model OS cleanup while the server remains alive, without touching the real TMPDIR.
	await fs.rm(tmpDir, { recursive: true, force: true });

	const requests = [
		{ route: "/", file: "index.html", mime: "text/html" },
		{ route: "/index.js", file: "index.js", mime: "text/javascript" },
		{ route: "/styles.css", file: "styles.css", mime: "text/css" },
		{ route: "/traces/session", file: "index.html", mime: "text/html" },
	] as const;
	await Promise.all(
		requests.map(async ({ route, file, mime }) => {
			const response = await fetch(url + route);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toStartWith(mime);
			expect(await response.text()).toBe(clientFiles[file]);
		}),
	);
});
