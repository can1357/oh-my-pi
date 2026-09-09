import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

/**
 * Common Wikidata property IDs mapped to human-readable names
 */
const PROPERTY_LABELS: Record<string, string> = {
	P31: "Instance of",
	P279: "Subclass of",
	P17: "Country",
	P131: "Located in",
	P625: "Coordinates",
	P18: "Image",
	P154: "Logo",
	P571: "Founded",
	P576: "Dissolved",
	P169: "CEO",
	P112: "Founded by",
	P159: "Headquarters",
	P452: "Industry",
	P1128: "Employees",
	P2139: "Revenue",
	P856: "Website",
	P21: "Sex/Gender",
	P27: "Citizenship",
	P569: "Born",
	P570: "Died",
	P19: "Birthplace",
	P20: "Death place",
	P106: "Occupation",
	P108: "Employer",
	P69: "Educated at",
	P22: "Father",
	P25: "Mother",
	P26: "Spouse",
	P40: "Child",
	P166: "Award",
	P136: "Genre",
	P495: "Country of origin",
	P577: "Publication date",
	P50: "Author",
	P123: "Publisher",
	P364: "Original language",
	P86: "Composer",
	P57: "Director",
	P161: "Cast member",
	P170: "Creator",
	P178: "Developer",
	P275: "License",
	P306: "Operating system",
	P277: "Programming language",
	P348: "Version",
	P1566: "GeoNames ID",
	P214: "VIAF ID",
	P227: "GND ID",
	P213: "ISNI",
	P496: "ORCID",
};

interface WikidataEntity {
	type: string;
	id: string;
	labels?: Record<string, { language: string; value: string }>;
	descriptions?: Record<string, { language: string; value: string }>;
	aliases?: Record<string, Array<{ language: string; value: string }>>;
	claims?: Record<string, WikidataClaim[]>;
	sitelinks?: Record<string, { site: string; title: string }>;
}

interface WikidataClaim {
	mainsnak: {
		snaktype: string;
		property: string;
		datavalue?: {
			type: string;
			value: WikidataValue;
		};
	};
	rank: string;
}

type WikidataValue =
	| string
	| { "entity-type": string; id: string; "numeric-id": number }
	| { time: string; precision: number; calendarmodel: string }
	| { amount: string; unit: string }
	| { text: string; language: string }
	| { latitude: number; longitude: number; precision: number };

/**
 * Handle Wikidata URLs via EntityData API
 */
export const handleWikidata: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("wikidata.org")) return null;

		// Extract Q-id from /wiki/Q123 or /entity/Q123
		const qidMatch = parsed.pathname.match(/\/(?:wiki|entity)\/(Q\d+)/i);
		if (!qidMatch) return null;

		const qid = qidMatch[1].toUpperCase();
		const fetchedAt = new Date().toISOString();

		// Fetch entity data from API
		const apiUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
		const result = await loadPage(apiUrl, { timeout, signal });

		if (!result.ok) return null;

		const data = tryParseJson<{ entities: Record<string, WikidataEntity> }>(result.content);
		if (!data) return null;

		const entity = data.entities[qid];
		if (!entity) return null;

		// Get label and description (prefer English)
		const label = getLocalizedValue(entity.labels, "en") || qid;
		const description = getLocalizedValue(entity.descriptions, "en");
		const aliases = getLocalizedAliases(entity.aliases, "en");

		let md = `# ${label} (${qid})\n\n`;
		if (description) md += `*${description}*\n\n`;
		if (aliases.length > 0) md += `**Also known as:** ${aliases.join(", ")}\n\n`;

		// Count sitelinks
		const sitelinkCount = entity.sitelinks ? Object.keys(entity.sitelinks).length : 0;
		if (sitelinkCount > 0) {
			md += `**Wikipedia articles:** ${formatNumber(sitelinkCount)} languages\n\n`;
		}

		// Process claims
		if (entity.claims && Object.keys(entity.claims).length > 0) {
			md += "## Properties\n\n";

			// Collect entity IDs we need to resolve
			const entityIdsToResolve = new Set<string>();
			for (const claims of Object.values(entity.claims)) {
				for (const claim of claims) {
					if (claim.mainsnak.datavalue?.type === "wikibase-entityid") {
						const val = claim.mainsnak.datavalue.value as { id: string };
						entityIdsToResolve.add(val.id);
					}
				}
			}

			// Fetch labels for referenced entities (limit to 50)
			const entityLabels = await resolveEntityLabels(Array.from(entityIdsToResolve).slice(0, 50), timeout, signal);

			// Group claims by property
			const processedProperties: string[] = [];
			for (const [propId, claims] of Object.entries(entity.claims)) {
				const propLabel = PROPERTY_LABELS[propId] || propId;
				const values: string[] = [];

				for (const claim of claims) {
					if (claim.rank === "deprecated") continue;
					const value = formatClaimValue(claim, entityLabels);
					if (value && !values.includes(value)) {
						values.push(value);
					}
				}

				if (values.length > 0) {
					// Limit values shown per property
					const displayValues = values.slice(0, 10);
					const overflow = values.length > 10 ? ` […${values.length - 10} values elided…]` : "";
					processedProperties.push(`- **${propLabel}:** ${displayValues.join(", ")}${overflow}`);
				}
			}

			// Sort: known properties first, then by property ID
			processedProperties.sort((a, b) => {
				const aKnown = Object.values(PROPERTY_LABELS).some(l => a.includes(`**${l}:**`));
				const bKnown = Object.values(PROPERTY_LABELS).some(l => b.includes(`**${l}:**`));
				if (aKnown && !bKnown) return -1;
				if (!aKnown && bKnown) return 1;
				return a.localeCompare(b);
			});

			// Limit total properties shown
			const maxProps = 50;
			md += processedProperties.slice(0, maxProps).join("\n");
			if (processedProperties.length > maxProps) {
				md += `\n\n[…${processedProperties.length - maxProps} properties elided…]`;
			}
			md += "\n";
		}

		// Add notable sitelinks
		if (entity.sitelinks) {
			const notableSites = ["enwiki", "dewiki", "frwiki", "eswiki", "jawiki", "zhwiki"];
			const links: string[] = [];

			for (const site of notableSites) {
				const sitelink = entity.sitelinks[site];
				if (sitelink) {
					const lang = site.replace("wiki", "");
					const wikiUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(sitelink.title)}`;
					links.push(`[${lang.toUpperCase()}](${wikiUrl})`);
				}
			}

			if (links.length > 0) {
				md += `\n## Wikipedia Links\n\n${links.join(" · ")}\n`;
			}
		}

		return buildResult(md, { url, method: "wikidata", fetchedAt, notes: ["Fetched via Wikidata EntityData API"] });
	} catch {}

	return null;
};

/**
 * Get localized value with fallback
 */
function getLocalizedValue(
	values: Record<string, { language: string; value: string }> | undefined,
	preferredLang: string,
): string | null {
	if (!values) return null;
	if (values[preferredLang]) return values[preferredLang].value;
	// Fallback to any available
	const first = Object.values(values)[0];
	return first?.value || null;
}

/**
 * Get aliases for a language
 */
function getLocalizedAliases(
	aliases: Record<string, Array<{ language: string; value: string }>> | undefined,
	preferredLang: string,
): string[] {
	if (!aliases) return [];
	const langAliases = aliases[preferredLang];
	if (!langAliases) return [];
	return langAliases.map(a => a.value);
}

/**
 * Resolve entity IDs to their labels via wbgetentities API
 */
async function resolveEntityLabels(
	entityIds: string[],
	timeout: number,
	signal?: AbortSignal,
): Promise<Record<string, string>> {
	if (entityIds.length === 0) return {};

	const labels: Record<string, string> = {};

	// Fetch in batches of 50
	const batchSize = 50;
	for (let i = 0; i < entityIds.length; i += batchSize) {
		const batch = entityIds.slice(i, i + batchSize);
		const apiUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join("|")}&props=labels&languages=en&format=json`;

		try {
			const result = await loadPage(apiUrl, { timeout: Math.min(timeout, 10), signal });
			if (result.ok) {
				const data = JSON.parse(result.content) as {
					entities: Record<string, { labels?: Record<string, { value: string }> }>;
				};
				for (const [id, entity] of Object.entries(data.entities)) {
					const label = entity.labels?.en?.value;
					if (label) labels[id] = label;
				}
			}
		} catch {}
	}

	return labels;
}

/**
 * Format a claim value to human-readable string
 */
function formatClaimValue(claim: WikidataClaim, entityLabels: Record<string, string>): string | null {
	const snak = claim.mainsnak;
	if (snak.snaktype !== "value" || !snak.datavalue) return null;

	const { type, value } = snak.datavalue;

	switch (type) {
		case "wikibase-entityid": {
			const entityVal = value as { id: string };
			return entityLabels[entityVal.id] || entityVal.id;
		}
		case "string":
			return value as string;
		case "time": {
			const timeVal = value as { time: string; precision: number };
			return formatWikidataTime(timeVal.time, timeVal.precision);
		}
		case "quantity": {
			const qtyVal = value as { amount: string; unit: string };
			const amount = qtyVal.amount.replace(/^\+/, "");
			// Extract unit Q-id if present
			const unitMatch = qtyVal.unit.match(/Q\d+$/);
			const unit = unitMatch ? entityLabels[unitMatch[0]] || "" : "";
			return unit ? `${amount} ${unit}` : amount;
		}
		case "monolingualtext": {
			const textVal = value as { text: string; language: string };
			return textVal.text;
		}
		case "globecoordinate": {
			const coordVal = value as { latitude: number; longitude: number };
			return `${coordVal.latitude.toFixed(4)}, ${coordVal.longitude.toFixed(4)}`;
		}
		default:
			return null;
	}
}

/**
 * Format Wikidata time value to readable date
 */
function formatWikidataTime(time: string, precision: number): string {
	// Time format: +YYYY-MM-DDT00:00:00Z
	const match = time.match(/^([+-]?\d+)-(\d{2})-(\d{2})/);
	if (!match) return time;

	const [, year, month, day] = match;
	const yearNum = Number.parseInt(year, 10);
	const absYear = Math.abs(yearNum);
	const era = yearNum < 0 ? " BCE" : "";

	// Precision: 9=year, 10=month, 11=day
	if (precision >= 11) {
		return `${day}/${month}/${absYear}${era}`;
	}
	if (precision >= 10) {
		return `${month}/${absYear}${era}`;
	}
	return `${absYear}${era}`;
}
