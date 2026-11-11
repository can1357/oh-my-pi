import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { ClaudeArtifactsClient, claudeArtifactUrl } from "../src/publish/claude-artifacts";
import { PagePublisher, PageStore } from "../src/publish/pages";
import { cfgPublishBackends } from "../src/publish/settings";

interface FakeObjectStore {
	objects: Map<string, string>;
	endpoint: string;
	stop(): void;
}

/** Minimal path-style S3 endpoint: PUT stores, GET serves, DELETE removes. */
function fakeObjectStore(): FakeObjectStore {
	const objects = new Map<string, string>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const key = new URL(request.url).pathname;
			if (request.method === "PUT") {
				objects.set(key, await request.text());
				return new Response(null, { status: 200 });
			}
			if (request.method === "DELETE") {
				objects.delete(key);
				return new Response(null, { status: 204 });
			}
			return new Response(null, { status: 404 });
		},
	});
	return { objects, endpoint: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function minioSettings(endpoint: string, backends: string[]): Settings {
	return Settings.isolated({
		"publish.backends": backends,
		"images.urls.options": { minio: { endpoint, bucket: "pages", publicBaseUrl: `${endpoint}/pages` } },
		"images.urls.credentials": { minio: { accessKeyId: "id", secretAccessKey: "secret" } },
	});
}

describe("PagePublisher", () => {
	let root: string;
	let store: FakeObjectStore;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publish-"));
		store = fakeObjectStore();
	});

	afterEach(async () => {
		store.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("keeps one URL across versions and deletes every remote copy", async () => {
		const publisher = new PagePublisher(minioSettings(store.endpoint, ["minio"]), { store: new PageStore(root) });
		const first = await publisher.publish({ html: "<p>one</p>", title: "T", source: "a.html", projectDir: root });
		const asset = await publisher.uploadAsset(first.page, "chart.png", new TextEncoder().encode("img"), "image/png");
		const second = await publisher.publish({
			html: "<p>two</p>",
			title: "T",
			source: "a.html",
			projectDir: root,
			existing: first.page,
		});

		expect(second.version.version).toBe(2);
		expect(second.version.url).toBe(first.version.url);
		expect(new URL(asset.publication.url).pathname).toBe(`/pages/${first.page.id}/chart.png`);
		expect(store.objects.get(`/pages/${first.page.id}/index.html`)).toBe("<p>two</p>");
		expect(await publisher.store.readVersion(first.page.id, 1)).toBe("<p>one</p>");

		const removal = await publisher.remove(second.page);
		expect(removal.removed).toBe(true);
		expect(removal.errors).toEqual([]);
		expect(store.objects.size).toBe(0);
		expect(await publisher.store.load(first.page.id)).toBeNull();
	});

	it("falls through to the next destination and reports every failure when all fail", async () => {
		// `ftp` without a host cannot upload; the chain must continue to minio.
		const publisher = new PagePublisher(minioSettings(store.endpoint, ["ftp", "minio"]), {
			store: new PageStore(root),
		});
		const { version } = await publisher.publish({ html: "<p/>", title: "T", source: "a.html", projectDir: root });
		expect(version.publication?.destination).toBe("minio");

		store.stop();
		const failing = publisher.publish({ html: "<p/>", title: "T", source: "a.html", projectDir: root });
		await expect(failing).rejects.toThrow(/Every publish destination failed:\nftp: .+\nminio: /);
	});

	it("uses claude.ai only while no destination is configured, then keeps each page on its host", async () => {
		const deploys: Record<string, unknown>[] = [];
		const claude = new ClaudeArtifactsClient(
			async () => "sk-ant-oat01-test",
			async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				deploys.push(body);
				const version = `v${deploys.length}`;
				return Response.json({ slug: (body.slug as string | undefined) ?? "art-1", version });
			},
		);
		const settings = minioSettings(store.endpoint, []);
		const publisher = new PagePublisher(settings, { store: new PageStore(root), claude });

		const created = await publisher.publish({ html: "<p>a</p>", title: "T", source: "a.html", projectDir: root });
		expect(created.version.url).toBe(claudeArtifactUrl("art-1"));
		expect(deploys[0]).toEqual({ title: "T", content: "<!DOCTYPE html>\n<p>a</p>" });
		await expect(publisher.uploadAsset(created.page, "x.png", new Uint8Array([1]), "image/png")).rejects.toThrow(
			/inline/,
		);

		// Configuring a destination overrides claude.ai for new pages; the existing page stays on claude.ai.
		cfgPublishBackends.override(settings, ["minio"]);
		const updated = await publisher.publish({
			html: "<!doctype html><p>b</p>",
			title: "T",
			source: "a.html",
			projectDir: root,
			existing: created.page,
		});
		expect(deploys[1]).toEqual({ slug: "art-1", baseVersion: "v1", title: "T", content: "<!doctype html><p>b</p>" });
		expect(updated.version.url).toBe(created.version.url);

		const fresh = await publisher.publish({ html: "<p>c</p>", title: "U", source: "c.html", projectDir: root });
		expect(fresh.version.publication?.destination).toBe("minio");
		expect(deploys).toHaveLength(2);
	});

	it("refuses to overwrite a claude.ai version changed elsewhere unless forced", async () => {
		const bases: unknown[] = [];
		const claude = new ClaudeArtifactsClient(
			async () => "sk-ant-oat01-test",
			async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { baseVersion?: string };
				bases.push(body.baseVersion);
				if (body.baseVersion === "stale") return Response.json({ conflict: true, live: "theirs" }, { status: 409 });
				return Response.json({ slug: "art-1", version: "mine" });
			},
		);
		const deploy = (force?: boolean) =>
			claude.deploy({ slug: "art-1", baseVersion: "stale", title: "T", content: "<!DOCTYPE html>", force });

		await expect(deploy()).rejects.toThrow(/changed on claude\.ai.*live version theirs.*force/);
		expect(await deploy(true)).toEqual({ slug: "art-1", version: "mine" });
		expect(bases).toEqual(["stale", "stale", "theirs"]);
	});
});
