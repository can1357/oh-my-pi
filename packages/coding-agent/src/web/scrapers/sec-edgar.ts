import { tryParseJson, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

interface SecFiling {
	accessionNumber: string;
	filingDate: string;
	reportDate: string;
	acceptanceDateTime: string;
	form: string;
	primaryDocument: string;
	primaryDocDescription: string;
}

interface SecCompany {
	cik: string;
	entityType: string;
	sic: string;
	sicDescription: string;
	name: string;
	tickers: string[];
	exchanges: string[];
	ein: string;
	stateOfIncorporation: string;
	fiscalYearEnd: string;
	addresses: {
		business: {
			street1?: string;
			street2?: string;
			city?: string;
			stateOrCountry?: string;
			zipCode?: string;
		};
		mailing: {
			street1?: string;
			street2?: string;
			city?: string;
			stateOrCountry?: string;
			zipCode?: string;
		};
	};
	filings: {
		recent: {
			accessionNumber: string[];
			filingDate: string[];
			reportDate: string[];
			acceptanceDateTime: string[];
			form: string[];
			primaryDocument: string[];
			primaryDocDescription: string[];
		};
	};
}

/**
 * Extract CIK from various SEC EDGAR URL patterns
 */
function extractCik(url: URL): string | null {
	const { hostname, pathname, searchParams } = url;

	// Check hostname
	if (!hostname.includes("sec.gov")) return null;

	// Pattern: ?CIK=xxx or ?cik=xxx
	const cikParam = searchParams.get("CIK") || searchParams.get("cik");
	if (cikParam) {
		return normalizeCik(cikParam);
	}

	// Pattern: /cik/XXXXXXXXXX or /cik/XXXXXXXXXX/...
	const cikPathMatch = pathname.match(/\/cik\/(\d+)/i);
	if (cikPathMatch) {
		return normalizeCik(cikPathMatch[1]);
	}

	// Pattern: /submissions/CIK*.json
	const submissionsMatch = pathname.match(/\/submissions\/CIK(\d+)\.json/i);
	if (submissionsMatch) {
		return normalizeCik(submissionsMatch[1]);
	}

	// Pattern: /cgi-bin/browse-edgar with company search (no CIK yet)
	if (pathname.includes("/cgi-bin/browse-edgar") && searchParams.get("company")) {
		// Company name search - we'd need to search first, skip for now
		return null;
	}

	// Pattern: Filing URLs like /Archives/edgar/data/XXXXXXXXXX/...
	const archivesMatch = pathname.match(/\/Archives\/edgar\/data\/(\d+)/);
	if (archivesMatch) {
		return normalizeCik(archivesMatch[1]);
	}

	return null;
}

/**
 * Normalize CIK to 10 digits with leading zeros
 */
function normalizeCik(cik: string): string {
	const cleaned = cik.replace(/\D/g, "");
	return cleaned.padStart(10, "0");
}

/**
 * Format address for display
 */
function formatAddress(addr: SecCompany["addresses"]["business"]): string {
	const parts: string[] = [];
	if (addr.street1) parts.push(addr.street1);
	if (addr.street2) parts.push(addr.street2);

	const cityLine: string[] = [];
	if (addr.city) cityLine.push(addr.city);
	if (addr.stateOrCountry) cityLine.push(addr.stateOrCountry);
	if (addr.zipCode) cityLine.push(addr.zipCode);
	if (cityLine.length) parts.push(cityLine.join(", "));

	return parts.join("\n");
}

/**
 * Get recent filings of specific types
 */
function getRecentFilings(company: SecCompany, formTypes: string[], limit = 10): SecFiling[] {
	const { recent } = company.filings;
	const filings: SecFiling[] = [];

	for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
		if (formTypes.length === 0 || formTypes.includes(recent.form[i])) {
			filings.push({
				accessionNumber: recent.accessionNumber[i],
				filingDate: recent.filingDate[i],
				reportDate: recent.reportDate[i],
				acceptanceDateTime: recent.acceptanceDateTime[i],
				form: recent.form[i],
				primaryDocument: recent.primaryDocument[i],
				primaryDocDescription: recent.primaryDocDescription[i],
			});
		}
	}

	return filings;
}

/**
 * Build SEC EDGAR filing URL
 */
function buildFilingUrl(cik: string, accessionNumber: string, document: string): string {
	const accessionNoDashes = accessionNumber.replace(/-/g, "");
	return `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accessionNoDashes}/${document}`;
}

/**
 * Handle SEC EDGAR URLs via data.sec.gov API
 */
export const handleSecEdgar: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);

		// Check if it's an SEC URL
		if (!parsed.hostname.includes("sec.gov")) return null;

		// Extract CIK from URL
		const cik = extractCik(parsed);
		if (!cik) return null;

		const fetchedAt = new Date().toISOString();

		// Fetch company data from SEC API
		// SEC requires a proper User-Agent with contact info
		const apiUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "application/json",
			},
		});

		if (!result.ok) return null;

		const company = tryParseJson<SecCompany>(result.content);
		if (!company) return null;

		// Build markdown output
		let md = `# ${company.name}\n\n`;

		// Basic info
		md += `**CIK:** ${company.cik}`;
		if (company.tickers?.length) {
			md += ` · **Ticker${company.tickers.length > 1 ? "s" : ""}:** ${company.tickers.join(", ")}`;
		}
		if (company.exchanges?.length) {
			md += ` (${company.exchanges.join(", ")})`;
		}
		md += "\n";

		if (company.entityType) md += `**Entity Type:** ${company.entityType}\n`;
		if (company.sic) md += `**SIC:** ${company.sic} - ${company.sicDescription}\n`;
		if (company.stateOfIncorporation) md += `**State of Incorporation:** ${company.stateOfIncorporation}\n`;
		if (company.ein) md += `**EIN:** ${company.ein}\n`;
		if (company.fiscalYearEnd) {
			const fy = company.fiscalYearEnd;
			md += `**Fiscal Year End:** ${fy.slice(0, 2)}/${fy.slice(2)}\n`;
		}
		md += "\n";

		// Business address
		if (company.addresses?.business) {
			const addr = formatAddress(company.addresses.business);
			if (addr) {
				md += `## Business Address\n\n${addr}\n\n`;
			}
		}

		// Recent key filings (10-K, 10-Q, 8-K)
		const keyFilings = getRecentFilings(company, ["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A"], 15);
		if (keyFilings.length) {
			md += `## Recent Filings (10-K, 10-Q, 8-K)\n\n`;
			md += "| Date | Form | Description |\n";
			md += "|------|------|-------------|\n";

			for (const filing of keyFilings) {
				const filingUrl = buildFilingUrl(cik, filing.accessionNumber, filing.primaryDocument);
				const desc = filing.primaryDocDescription || filing.form;
				md += `| ${filing.filingDate} | [${filing.form}](${filingUrl}) | ${desc} |\n`;
			}
			md += "\n";
		}

		// All recent filings (last 20)
		const allFilings = getRecentFilings(company, [], 20);
		if (allFilings.length) {
			md += `## All Recent Filings\n\n`;
			md += "| Date | Form | Description |\n";
			md += "|------|------|-------------|\n";

			for (const filing of allFilings) {
				const filingUrl = buildFilingUrl(cik, filing.accessionNumber, filing.primaryDocument);
				const desc = filing.primaryDocDescription || filing.form;
				md += `| ${filing.filingDate} | [${filing.form}](${filingUrl}) | ${desc} |\n`;
			}
			md += "\n";
		}

		// Links
		md += `## Links\n\n`;
		md += `- [SEC EDGAR Filings](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40)\n`;
		md += `- [Company Search](https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(company.name)}&CIK=&type=&owner=include&count=40&action=getcompany)\n`;

		return buildResult(md, { url, method: "sec-edgar", fetchedAt, notes: ["Fetched via SEC EDGAR API"] });
	} catch {}

	return null;
};
