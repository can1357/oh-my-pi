import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embedTargetUrl, resolveEmbedSource } from "@oh-my-pi/pi-tui/chat/embed-target";

describe("resolveEmbedSource", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "embed-target-")));
		await Bun.write(path.join(cwd, "out/report.html"), "<p>report</p>");
		await Bun.write(path.join(cwd, "my chart.png"), "");
		await Bun.write(path.join(cwd, "notes.io/index.html"), "");
		await Bun.write(path.join(cwd, "what?.html"), "");
	});

	afterAll(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	const url = (src: string) => {
		const target = resolveEmbedSource(src, cwd);
		return target?.kind === "url" ? target.url : target;
	};
	const file = (src: string) => {
		const target = resolveEmbedSource(src, cwd);
		return target?.kind === "file" ? path.relative(cwd, target.path) + target.suffix : target;
	};

	it("reads a web address written with a missing or broken scheme", () => {
		expect(url("https://example.com/docs")).toBe("https://example.com/docs");
		expect(url("example.com/docs")).toBe("https://example.com/docs");
		expect(url("www.example.com")).toBe("https://www.example.com/");
		expect(url("//cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
		expect(url("http:/example.com/x")).toBe("http://example.com/x");
		expect(url("HTTPS:example.com")).toBe("https://example.com/");
		// A dev server is plain http, whatever names it.
		expect(url("localhost:3000/app")).toBe("http://localhost:3000/app");
		expect(url("localhost")).toBe("http://localhost/");
		expect(url("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
		expect(url("staging.example.com:8443/x")).toBe("http://staging.example.com:8443/x");
	});

	it("reads a file written as a bare path or as a file: URL in any spelling", () => {
		expect(file("out/report.html")).toBe("out/report.html");
		expect(file("./out/report.html")).toBe("out/report.html");
		expect(file(path.join(cwd, "out/report.html"))).toBe("out/report.html");
		expect(file(`file://${cwd}/out/report.html`)).toBe("out/report.html");
		expect(file(`file:${cwd}/out/report.html`)).toBe("out/report.html");
		expect(file(`file://localhost${cwd}/out/report.html`)).toBe("out/report.html");
		expect(file("file:out/report.html")).toBe("out/report.html");
		expect(file("file://out/report.html")).toBe("out/report.html");
		const home = resolveEmbedSource("~/shot.png", cwd);
		expect(home).toEqual({ kind: "file", path: path.join(os.homedir(), "shot.png"), suffix: "" });
	});

	it("drops what was left around the value and reads an encoded name as the file that exists", () => {
		expect(file(` "out/report.html" `)).toBe("out/report.html");
		expect(file("<out/report.html>")).toBe("out/report.html");
		expect(file("my chart.png")).toBe("my chart.png");
		expect(file("my%20chart.png")).toBe("my chart.png");
	});

	it("keeps a page's query and fragment apart from its file, unless they are the file's name", () => {
		expect(file("out/report.html?tab=2#top")).toBe("out/report.html?tab=2#top");
		expect(file("what?.html")).toBe("what?.html");
		const target = resolveEmbedSource("out/report.html#top", cwd);
		expect(target && embedTargetUrl(target)).toBe(`${Bun.pathToFileURL(path.join(cwd, "out/report.html")).href}#top`);
	});

	it("lets the disk decide between a domain and a file that look alike", () => {
		// A directory named like a domain holds the file; the same shape with no file is a site.
		expect(file("notes.io/index.html")).toBe("notes.io/index.html");
		expect(url("blog.io/index.html")).toBe("https://blog.io/index.html");
		// A lone name with a file's extension is a file even before it exists.
		expect(file("chart.png")).toBe("chart.png");
		expect(url("chart.dev")).toBe("https://chart.dev/");
	});

	it("refuses what is neither a web address nor a file", () => {
		for (const src of ["", "  ", "javascript:alert(1)", "about:blank", "ftp://example.com/a.png", "mailto:a@b.c"]) {
			expect(resolveEmbedSource(src, cwd)).toBeUndefined();
		}
		expect(resolveEmbedSource("data:image/png;base64,AAAA", cwd)).toEqual({
			kind: "data",
			uri: "data:image/png;base64,AAAA",
		});
	});
});
