import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, htmlToBasicMarkdown, loadPage } from "./types";

interface GoModuleInfo {
	Version: string;
	Time: string;
}

/**
 * Handle pkg.go.dev URLs via proxy API and page parsing
 */
export const handleGoPkg: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "pkg.go.dev") return null;

		// Extract module path and version from URL
		// Patterns: /module, /module@version, /module/subpackage
		const pathname = parsed.pathname.slice(1); // remove leading /
		if (!pathname) return null;

		let modulePath: string;
		let version = "latest";

		// Parse @version if present
		const atIndex = pathname.indexOf("@");
		if (atIndex !== -1) {
			const beforeAt = pathname.slice(0, atIndex);
			const afterAt = pathname.slice(atIndex + 1);

			// Check if there's a subpackage after version
			const slashIndex = afterAt.indexOf("/");
			if (slashIndex !== -1) {
				version = afterAt.slice(0, slashIndex);
				modulePath = beforeAt;
			} else {
				version = afterAt;
				modulePath = beforeAt;
			}
		} else {
			// No version specified, check for subpackage
			// Need to determine where module ends and subpackage begins
			// For now, treat the whole path as module path (we'll refine from proxy response)
			modulePath = pathname;
		}

		const notes: string[] = [];
		const sections: string[] = [];

		// Fetch module info from proxy
		let moduleInfo: GoModuleInfo | null = null;
		let actualModulePath = modulePath;

		if (version === "latest") {
			try {
				const proxyUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@latest`;
				const proxyResult = await loadPage(proxyUrl, { timeout, signal });

				if (proxyResult.ok) {
					moduleInfo = tryParseJson<GoModuleInfo>(proxyResult.content);
					if (moduleInfo) {
						version = moduleInfo.Version;
					}
				}
			} catch {
				// If @latest fails, might be a subpackage - will extract from page
			}
		} else {
			try {
				const proxyUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@v/${encodeURIComponent(version)}.info`;
				const proxyResult = await loadPage(proxyUrl, { timeout, signal });

				if (proxyResult.ok) {
					moduleInfo = tryParseJson<GoModuleInfo>(proxyResult.content);
				}
			} catch {
				// Proxy lookup failed, will rely on page data
			}
		}

		// Fetch the pkg.go.dev page
		const pageResult = await loadPage(url, { timeout, signal });
		if (!pageResult.ok) {
			return buildResult(`Failed to fetch pkg.go.dev page (status: ${pageResult.status ?? "unknown"})`, {
				url,
				finalUrl: pageResult.finalUrl,
				method: "go-pkg",
				fetchedAt: new Date().toISOString(),
				notes: ["error"],
				contentType: "text/plain",
			});
		}

		const { parseHTML } = await import("@oh-my-pi/pi-utils/dom");
		const doc = parseHTML(pageResult.content).document;

		// Extract actual module path from breadcrumb or header
		const breadcrumb = doc.querySelector(".go-Breadcrumb");
		if (breadcrumb) {
			const moduleLink = breadcrumb.querySelector("a[href^='/']");
			if (moduleLink) {
				const href = moduleLink.getAttribute("href");
				if (href) {
					actualModulePath = href.slice(1).split("@")[0];
				}
			}
		}

		// Extract version if not from proxy
		if (!moduleInfo) {
			const versionBadge = doc.querySelector(".go-Chip");
			if (versionBadge) {
				const versionText = versionBadge.textContent?.trim();
				if (versionText?.startsWith("v")) {
					version = versionText;
				}
			}
		}

		// Extract license
		const licenseLink = doc.querySelector("a[data-test-id='UnitHeader-license']");
		const license = licenseLink?.textContent?.trim() || "Unknown";

		// Extract import path
		const importPathInput = doc.querySelector("input[data-test-id='UnitHeader-importPath']");
		const importPath = importPathInput?.getAttribute("value") || actualModulePath;

		// Build header
		sections.push(`# ${importPath}`);
		sections.push("");
		sections.push(`**Module:** ${actualModulePath}`);
		sections.push(`**Version:** ${version}`);
		sections.push(`**License:** ${license}`);
		sections.push("");

		// Extract package synopsis
		const synopsis = doc.querySelector(".go-Main-headerContent p");
		if (synopsis) {
			const synopsisText = synopsis.textContent?.trim();
			if (synopsisText) {
				sections.push(`## Synopsis`);
				sections.push("");
				sections.push(synopsisText);
				sections.push("");
			}
		}

		// Extract documentation overview
		const docSection = doc.querySelector("#section-documentation");
		if (docSection) {
			sections.push("## Documentation");
			sections.push("");

			// Get overview paragraph
			const overview = docSection.querySelector(".go-Message");
			if (overview) {
				const overviewMd = await htmlToBasicMarkdown(overview.innerHTML);
				sections.push(overviewMd);
				sections.push("");
			}

			// Get package-level documentation
			const docContent = docSection.querySelector(".Documentation-content");
			if (docContent) {
				// Extract first few paragraphs
				const paragraphs = docContent.querySelectorAll("p");
				const docParts: string[] = [];
				for (let i = 0; i < Math.min(3, paragraphs.length); i++) {
					const p = paragraphs[i];
					const text = (await htmlToBasicMarkdown(p.innerHTML)).trim();
					if (text) {
						docParts.push(text);
					}
				}

				if (docParts.length > 0) {
					sections.push(docParts.join("\n\n"));
					sections.push("");
				}
			}
		}

		// Extract index of exported identifiers
		const indexSection = doc.querySelector("#section-index");
		if (indexSection) {
			const indexList = indexSection.querySelector(".Documentation-indexList");
			if (indexList) {
				sections.push("## Index");
				sections.push("");

				const items = indexList.querySelectorAll("li");
				const exported: string[] = [];

				for (const item of items) {
					const link = item.querySelector("a");
					if (link) {
						const name = link.textContent?.trim();
						if (name) {
							exported.push(`- ${name}`);
						}
					}
				}

				if (exported.length > 0) {
					// Limit to first 50 exports
					sections.push(exported.slice(0, 50).join("\n"));
					if (exported.length > 50) {
						notes.push(`showing 50 of ${exported.length} exports`);
						sections.push(`\n[…${exported.length - 50} exports elided…]`);
					}
					sections.push("");
				}
			}
		}

		// Extract dependencies/imports
		const importsSection = doc.querySelector("#section-imports");
		if (importsSection) {
			const importsList = importsSection.querySelector(".go-Message");
			if (importsList) {
				sections.push("## Imports");
				sections.push("");

				const links = importsList.querySelectorAll("a");
				const imports: string[] = [];

				for (const link of links) {
					const imp = link.textContent?.trim();
					if (imp) {
						imports.push(`- ${imp}`);
					}
				}

				if (imports.length > 0) {
					sections.push(imports.slice(0, 20).join("\n"));
					if (imports.length > 20) {
						notes.push(`showing 20 of ${imports.length} imports`);
						sections.push(`\n[…${imports.length - 20} imports elided…]`);
					}
					sections.push("");
				}
			}
		}

		if (moduleInfo) {
			notes.push(`published ${moduleInfo.Time}`);
		}

		const content = sections.join("\n");

		return buildResult(content, {
			url,
			finalUrl: pageResult.finalUrl,
			method: "go-pkg",
			fetchedAt: new Date().toISOString(),
			notes,
		});
	} catch {
		return null;
	}
};
