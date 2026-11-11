import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { applyLinkMapSetting, matchLinkEntry, mappedLinkUri, parseLinkTarget } from "@oh-my-pi/pi-tui/render/link-map";

let homedir: Mock<typeof os.homedir>;
let userInfo: Mock<typeof os.userInfo>;

beforeEach(() => {
	homedir = spyOn(os, "homedir").mockReturnValue("/home/alice");
	userInfo = spyOn(os, "userInfo").mockReturnValue({ username: "alice" } as os.UserInfo<string>);
});

afterEach(() => {
	applyLinkMapSetting({});
	vi.restoreAllMocks();
});

describe("parseLinkTarget", () => {
	it("reads Windows-style file values as a drive URI ending in /", () => {
		for (const value of [
			"file:\\\\Z:\\data",
			"file://Z:/data",
			"file:\\\\Z:\\data\\",
			"file:///z:/data",
			" file:///Z:/data ",
		]) {
			expect(parseLinkTarget(value)).toBe("file:///Z:/data/");
		}
		expect(parseLinkTarget("file://Q:")).toBe("file:///Q:/");
		expect(parseLinkTarget("file://nas/share")).toBe("file://nas/share/");
	});

	it("accepts any scheme of two or more characters", () => {
		expect(parseLinkTarget("ompfile://devbox/work")).toBe("ompfile://devbox/work/");
		expect(parseLinkTarget("vscode://vscode-remote/ssh-remote+devbox/home/alice/src")).toBe(
			"vscode://vscode-remote/ssh-remote+devbox/home/alice/src/",
		);
		expect(parseLinkTarget("https://git.contoso.example/handbook/blob/main")).toBe(
			"https://git.contoso.example/handbook/blob/main/",
		);
	});

	it("rejects a drive read as a scheme, a bad scheme, a query and a fragment", () => {
		for (const value of ["Z:", "C:/x", "1x://h/", "no scheme", "file:///Z:/?q", "https://h/#x", "https://h/?", 3]) {
			expect(parseLinkTarget(value)).toBeUndefined();
		}
	});
});

describe.skipIf(process.platform === "win32")("matching", () => {
	it("appends the rest of the path one encoded segment at a time", () => {
		applyLinkMapSetting({ "/srv/handbook": "https://git.contoso.example/handbook/blob/main" });
		expect(mappedLinkUri("/srv/handbook/A B/#x?.md")).toBe(
			"https://git.contoso.example/handbook/blob/main/A%20B/%23x%3F.md",
		);
		expect(mappedLinkUri("/srv/handbook")).toBe("https://git.contoso.example/handbook/blob/main/");
	});

	it("lets the longest prefix win, whole segments only, case-sensitively", () => {
		applyLinkMapSetting({ "/mnt": "file:///M:/", "/mnt/projects": "file:///Z:/" });
		expect(mappedLinkUri("/mnt/projects/q3/report.csv")).toBe("file:///Z:/q3/report.csv");
		expect(mappedLinkUri("/mnt/projects-old/a")).toBe("file:///M:/projects-old/a");
		expect(mappedLinkUri("/MNT/projects/a")).toBeUndefined();
		expect(mappedLinkUri("/etc/hosts")).toBeUndefined();
	});

	it("covers every absolute path with a / entry, below any longer entry", () => {
		applyLinkMapSetting({ "/": "vscode://vscode-remote/ssh-remote+devbox/", "/mnt/projects": "file:///Z:/" });
		expect(mappedLinkUri("/etc/hosts")).toBe("vscode://vscode-remote/ssh-remote+devbox/etc/hosts");
		expect(mappedLinkUri("/mnt/projects/a")).toBe("file:///Z:/a");
	});

	it("resolves a relative path against the working directory", () => {
		applyLinkMapSetting({ [process.cwd()]: "file:///W:/" });
		expect(mappedLinkUri("src/a.ts")).toBe("file:///W:/src/a.ts");
	});

	it("expands ~ and <user>, and leaves <user> keys unmatched without a passwd entry", () => {
		applyLinkMapSetting({
			"~/notes": "file:///N:/",
			"/nfs/home/<user>": "file:///Y:/",
			"~/work/<user>": "file:///W:/",
		});
		expect(matchLinkEntry("/home/alice/notes/todo.md")).toEqual({ key: "~/notes", uri: "file:///N:/todo.md" });
		expect(mappedLinkUri("/nfs/home/alice/a")).toBe("file:///Y:/a");
		expect(mappedLinkUri("/nfs/home/bob/a")).toBeUndefined();
		expect(mappedLinkUri("/home/alice/work/alice/a")).toBe("file:///W:/a");

		userInfo.mockImplementation(() => {
			throw new Error("no passwd entry");
		});
		applyLinkMapSetting({ "/nfs/home/<user>": "file:///Y:/" });
		expect(mappedLinkUri("/nfs/home/alice/a")).toBeUndefined();
	});

	it("matches ~ through a home directory reached by a symlink", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-map-home-"));
		try {
			const real = path.join(root, "real");
			const link = path.join(root, "link");
			fs.mkdirSync(real);
			fs.symlinkSync(real, link);
			homedir.mockReturnValue(link);
			applyLinkMapSetting({ "~": "file:///Z:/" });
			const realHome = fs.realpathSync(link);
			expect(mappedLinkUri(path.join(link, "a.md"))).toBe("file:///Z:/a.md");
			expect(mappedLinkUri(path.join(realHome, "a.md"))).toBe("file:///Z:/a.md");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores invalid entries and keeps the valid ones", () => {
		spyOn(logger, "warn").mockImplementation(() => {});
		applyLinkMapSetting({
			"/mnt/projects": "file:///Z:/",
			"/a": "1x://host/x/",
			"/b": "https://host/x/?q=1",
			"/c": "Z:",
			"/d": 3,
			relative: "file:///Q:/",
			"/e": "",
		});
		for (const p of ["/a/x", "/b/x", "/c/x", "/d/x", "/e/x", path.resolve("relative/x")]) {
			expect(mappedLinkUri(p)).toBeUndefined();
		}
		expect(mappedLinkUri("/mnt/projects/a")).toBe("file:///Z:/a");
		for (const bad of [undefined, null, "file:///Z:/", ["file:///Z:/"]]) {
			applyLinkMapSetting(bad);
			expect(mappedLinkUri("/mnt/projects/a")).toBeUndefined();
		}
	});
});
