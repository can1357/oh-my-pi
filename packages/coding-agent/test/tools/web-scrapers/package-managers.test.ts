import { describe, expect, it } from "bun:test";
import { handleAur } from "@oh-my-pi/pi-coding-agent/web/scrapers/aur";
import { handleBrew } from "@oh-my-pi/pi-coding-agent/web/scrapers/brew";
import { handleMaven } from "@oh-my-pi/pi-coding-agent/web/scrapers/maven";
import { handleNuGet } from "@oh-my-pi/pi-coding-agent/web/scrapers/nuget";
import { handlePackagist } from "@oh-my-pi/pi-coding-agent/web/scrapers/packagist";
import { handleRubyGems } from "@oh-my-pi/pi-coding-agent/web/scrapers/rubygems";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleBrew", () => {
	it("fetches wget formula", async () => {
		const result = await handleBrew("https://formulae.brew.sh/formula/wget", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("brew");
		expect(result?.content).toContain("wget");
		expect(result?.content).toContain("brew install wget");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches firefox cask", async () => {
		const result = await handleBrew("https://formulae.brew.sh/cask/firefox", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("brew");
		expect(result?.content).toContain("Firefox");
		expect(result?.content).toContain("brew install --cask firefox");
		expect(result?.contentType).toBe("text/markdown");
	});
});

describe.skipIf(SKIP)("handleAur", () => {
	it("fetches yay package", async () => {
		const result = await handleAur("https://aur.archlinux.org/packages/yay", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("aur");
		expect(result?.content).toContain("yay");
		expect(result?.content).toContain("AUR helper");
		expect(result?.content).toContain("yay -S yay");
		expect(result?.contentType).toBe("text/markdown");
	});
});

describe.skipIf(SKIP)("handleRubyGems", () => {
	it("fetches rails gem", async () => {
		const result = await handleRubyGems("https://rubygems.org/gems/rails", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("rubygems");
		expect(result?.content).toContain("rails");
		expect(result?.content).toContain("Total Downloads");
		expect(result?.contentType).toBe("text/markdown");
	});
});

describe.skipIf(SKIP)("handleNuGet", () => {
	it("fetches Newtonsoft.Json package", async () => {
		const result = await handleNuGet("https://www.nuget.org/packages/Newtonsoft.Json", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("nuget");
		expect(result?.content).toContain("Newtonsoft.Json");
		expect(result?.content).toContain("JSON");
		expect(result?.contentType).toBe("text/markdown");
	});
});

describe.skipIf(SKIP)("handlePackagist", () => {
	it("fetches laravel/framework package", async () => {
		const result = await handlePackagist("https://packagist.org/packages/laravel/framework", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("packagist");
		expect(result?.content).toContain("laravel/framework");
		expect(result?.content).toContain("Downloads");
		expect(result?.contentType).toBe("text/markdown");
	});
});

describe.skipIf(SKIP)("handleMaven", () => {
	it("fetches commons-lang3 artifact from search.maven.org", async () => {
		const result = await handleMaven("https://search.maven.org/artifact/org.apache.commons/commons-lang3", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("maven");
		expect(result?.content).toContain("org.apache.commons");
		expect(result?.content).toContain("commons-lang3");
		expect(result?.content).toContain("<groupId>");
		expect(result?.content).toContain("implementation");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches commons-lang3 artifact from mvnrepository.com", async () => {
		const result = await handleMaven("https://mvnrepository.com/artifact/org.apache.commons/commons-lang3", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("maven");
		expect(result?.content).toContain("org.apache.commons");
		expect(result?.content).toContain("commons-lang3");
		expect(result?.contentType).toBe("text/markdown");
	}, 60000);
});
