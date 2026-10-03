// Adapted from markit-ai (MIT). See ../NOTICE.

import { archiveEntryText, readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { XMLParser } from "@oh-my-pi/pi-utils/xml";
import { createTurndown, normalizeTablesHtml } from "../../utils/turndown";
import type { ConversionResult, Converter, StreamInfo } from "../types";

const EXTENSIONS = [".epub"];
const MIMETYPES = ["application/epub", "application/epub+zip", "application/x-epub+zip"];

/** A metadata value: a bare string, or a node carrying `#text` and/or array children. */
type MetaValue = string | MetaNode;
interface MetaNode {
	"#text"?: string;
	[index: number]: MetaValue;
}
interface Metadata {
	"dc:title"?: MetaValue;
	"dc:creator"?: MetaValue;
	"dc:language"?: MetaValue;
	"dc:publisher"?: MetaValue;
	"dc:date"?: MetaValue;
	"dc:description"?: MetaValue;
}
interface ManifestItem {
	"@_id": string;
	"@_href": string;
}
interface SpineItem {
	"@_idref": string;
}
interface OpfDoc {
	package?: {
		metadata?: Metadata;
		manifest?: { item?: ManifestItem | ManifestItem[] };
		spine?: { itemref?: SpineItem | SpineItem[] };
	};
}
interface Rootfile {
	"@_full-path": string;
}
interface ContainerDoc {
	container?: { rootfiles?: { rootfile?: Rootfile | Rootfile[] } };
}

export class EpubConverter implements Converter {
	name = "epub";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) return true;
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) return true;
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const entries = await readArchiveEntries({ bytes: input, format: "zip" });
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			processEntities: { maxTotalExpansions: 1_000_000 },
		});
		// Find content.opf path from container.xml
		const containerXml = archiveEntryText(entries, "META-INF/container.xml");
		if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
		const container = parser.parse(containerXml) as ContainerDoc;
		const rootfile = container.container?.rootfiles?.rootfile;
		const opfPath = Array.isArray(rootfile) ? rootfile[0]["@_full-path"] : rootfile?.["@_full-path"];
		if (!opfPath) throw new Error("Invalid EPUB: missing rootfile path");
		// Parse content.opf
		const opfXml = archiveEntryText(entries, opfPath);
		if (!opfXml) throw new Error("Invalid EPUB: missing content.opf");
		const opf = parser.parse(opfXml) as OpfDoc;
		// Extract metadata
		const meta: Metadata = opf.package?.metadata ?? {};
		const metadata: Record<string, string | undefined> = {
			title: this.getText(meta["dc:title"]),
			authors: this.getTextArray(meta["dc:creator"]).join(", ") || undefined,
			language: this.getText(meta["dc:language"]),
			publisher: this.getText(meta["dc:publisher"]),
			date: this.getText(meta["dc:date"]),
			description: this.getText(meta["dc:description"]),
		};
		// Build manifest map (id → href)
		const manifestItems = opf.package?.manifest?.item;
		const itemList = Array.isArray(manifestItems) ? manifestItems : manifestItems ? [manifestItems] : [];
		const manifest = new Map<string, string>();
		for (const item of itemList) {
			manifest.set(item["@_id"], item["@_href"]);
		}
		// Get spine order
		const spineItems = opf.package?.spine?.itemref;
		const spineList = Array.isArray(spineItems) ? spineItems : spineItems ? [spineItems] : [];
		const spineOrder = spineList.map(s => s["@_idref"]);
		// Resolve file paths
		const basePath = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/")) : "";
		const turndown = createTurndown();
		const sections: string[] = [];
		// Add metadata header
		const metaLines: string[] = [];
		for (const key in metadata) {
			const value = metadata[key];
			if (value) metaLines.push(`**${key.charAt(0).toUpperCase() + key.slice(1)}:** ${value}`);
		}
		if (metaLines.length > 0) sections.push(metaLines.join("\n"));
		// Convert spine files
		for (const idref of spineOrder) {
			const href = manifest.get(idref);
			if (!href) continue;
			const filePath = basePath ? `${basePath}/${href}` : href;
			const html = archiveEntryText(entries, filePath);
			if (!html) continue;
			// Strip script/style, convert to markdown
			const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
			const md = turndown.turndown(normalizeTablesHtml(cleaned)).trim();
			if (md) sections.push(md);
		}
		return {
			markdown: sections.join("\n\n").trim(),
			title: metadata.title,
		};
	}

	getText(node: MetaValue | undefined): string | undefined {
		if (!node) return undefined;
		if (typeof node === "string") return node;
		if (node["#text"]) return String(node["#text"]);
		if (Array.isArray(node)) return this.getText(node[0]);
		return undefined;
	}

	getTextArray(node: MetaValue | undefined): (string | undefined)[] {
		if (!node) return [];
		const list = Array.isArray(node) ? node : [node];
		return list.map(n => this.getText(n)).filter(Boolean);
	}
}
