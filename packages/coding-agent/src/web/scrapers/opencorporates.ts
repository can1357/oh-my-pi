import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

interface Officer {
	id: number;
	name: string;
	position?: string;
	start_date?: string;
	end_date?: string;
	occupation?: string;
	nationality?: string;
	inactive?: boolean;
}

interface Address {
	street_address?: string;
	locality?: string;
	region?: string;
	postal_code?: string;
	country?: string;
}

interface CompanyData {
	name: string;
	company_number: string;
	jurisdiction_code: string;
	incorporation_date?: string;
	dissolution_date?: string;
	company_type?: string;
	registry_url?: string;
	branch?: string;
	branch_status?: string;
	inactive?: boolean;
	current_status?: string;
	created_at?: string;
	updated_at?: string;
	retrieved_at?: string;
	opencorporates_url?: string;
	source?: {
		publisher?: string;
		url?: string;
		retrieved_at?: string;
	};
	registered_address?: Address;
	registered_address_in_full?: string;
	industry_codes?: Array<{
		code: string;
		description?: string;
		code_scheme_name?: string;
	}>;
	identifiers?: Array<{
		identifier_system_code: string;
		identifier_system_name?: string;
		identifier_uid: string;
	}>;
	previous_names?: Array<{
		company_name: string;
		con_date?: string;
	}>;
	alternative_names?: Array<{
		company_name: string;
		type?: string;
	}>;
	officers?: Array<{ officer: Officer }>;
	agent_name?: string;
	agent_address?: string;
	number_of_employees?: string;
	native_company_number?: string;
}

interface ApiResponse {
	api_version: string;
	results: {
		company: CompanyData;
	};
}

/**
 * Handle OpenCorporates URLs via API
 */
export const handleOpenCorporates: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("opencorporates.com")) return null;

		// Extract jurisdiction and company number from /companies/{jurisdiction}/{number}
		const match = parsed.pathname.match(/^\/companies\/([^/]+)\/([^/]+)/);
		if (!match) return null;

		const jurisdiction = decodeURIComponent(match[1]);
		const companyNumber = decodeURIComponent(match[2]);

		const fetchedAt = new Date().toISOString();

		// Fetch from OpenCorporates API
		const apiUrl = `https://api.opencorporates.com/v0.4/companies/${jurisdiction}/${companyNumber}`;
		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) {
			const fallback = `# OpenCorporates Company\n\n**Jurisdiction:** ${jurisdiction.toUpperCase()}\n**Company Number:** ${companyNumber}\n\nOpenCorporates API request failed. Company details are currently unavailable.\n`;
			return buildResult(fallback, {
				url,
				method: "opencorporates",
				fetchedAt,
				notes: ["OpenCorporates API request failed"],
			});
		}

		const data = tryParseJson<ApiResponse>(result.content);
		if (!data) {
			const fallback = `# OpenCorporates Company\n\n**Jurisdiction:** ${jurisdiction.toUpperCase()}\n**Company Number:** ${companyNumber}\n\nOpenCorporates response could not be parsed.\n`;
			return buildResult(fallback, {
				url,
				method: "opencorporates",
				fetchedAt,
				notes: ["OpenCorporates API response parsing failed"],
			});
		}

		const company = data.results?.company;
		if (!company) {
			const fallback = `# OpenCorporates Company\n\n**Jurisdiction:** ${jurisdiction.toUpperCase()}\n**Company Number:** ${companyNumber}\n\nCompany details were not available from the OpenCorporates API.\n`;
			return buildResult(fallback, {
				url,
				method: "opencorporates",
				fetchedAt,
				notes: ["OpenCorporates company payload was missing"],
			});
		}

		let md = `# ${company.name}\n\n`;

		// Basic info table
		md += "| Field | Value |\n|-------|-------|\n";
		md += `| **Company Number** | ${company.company_number} |\n`;
		md += `| **Jurisdiction** | ${company.jurisdiction_code.toUpperCase()} |\n`;
		if (company.current_status) {
			md += `| **Status** | ${company.current_status} |\n`;
		}
		if (company.company_type) {
			md += `| **Company Type** | ${company.company_type} |\n`;
		}
		if (company.incorporation_date) {
			md += `| **Incorporated** | ${company.incorporation_date} |\n`;
		}
		if (company.dissolution_date) {
			md += `| **Dissolved** | ${company.dissolution_date} |\n`;
		}
		if (company.branch) {
			md += `| **Branch** | ${company.branch}${company.branch_status ? ` (${company.branch_status})` : ""} |\n`;
		}
		if (company.native_company_number && company.native_company_number !== company.company_number) {
			md += `| **Native Number** | ${company.native_company_number} |\n`;
		}
		md += "\n";

		// Registered address
		if (company.registered_address_in_full) {
			md += `## Registered Address\n\n${company.registered_address_in_full}\n\n`;
		} else if (company.registered_address) {
			const addr = company.registered_address;
			const parts = [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(
				Boolean,
			);
			if (parts.length > 0) {
				md += `## Registered Address\n\n${parts.join(", ")}\n\n`;
			}
		}

		// Agent info
		if (company.agent_name) {
			md += `## Registered Agent\n\n**${company.agent_name}**`;
			if (company.agent_address) {
				md += `\n${company.agent_address}`;
			}
			md += "\n\n";
		}

		// Officers/Directors
		if (company.officers && company.officers.length > 0) {
			const activeOfficers = company.officers.filter(o => !o.officer.inactive && !o.officer.end_date);
			const inactiveOfficers = company.officers.filter(o => o.officer.inactive || o.officer.end_date);

			if (activeOfficers.length > 0) {
				md += `## Current Officers (${activeOfficers.length})\n\n`;
				for (const { officer } of activeOfficers) {
					md += `- **${officer.name}**`;
					if (officer.position) md += ` - ${officer.position}`;
					if (officer.start_date) md += ` (since ${officer.start_date})`;
					if (officer.occupation) md += ` [${officer.occupation}]`;
					if (officer.nationality) md += ` (${officer.nationality})`;
					md += "\n";
				}
				md += "\n";
			}

			if (inactiveOfficers.length > 0) {
				md += `## Former Officers (${inactiveOfficers.length})\n\n`;
				for (const { officer } of inactiveOfficers.slice(0, 10)) {
					md += `- **${officer.name}**`;
					if (officer.position) md += ` - ${officer.position}`;
					if (officer.start_date && officer.end_date) {
						md += ` (${officer.start_date} to ${officer.end_date})`;
					} else if (officer.end_date) {
						md += ` (until ${officer.end_date})`;
					}
					md += "\n";
				}
				if (inactiveOfficers.length > 10) {
					md += `\n[…${inactiveOfficers.length - 10} former officers elided…]\n`;
				}
				md += "\n";
			}
		}

		// Industry codes
		if (company.industry_codes && company.industry_codes.length > 0) {
			md += `## Industry Codes\n\n`;
			for (const ic of company.industry_codes) {
				md += `- **${ic.code}**`;
				if (ic.description) md += `: ${ic.description}`;
				if (ic.code_scheme_name) md += ` (${ic.code_scheme_name})`;
				md += "\n";
			}
			md += "\n";
		}

		// Identifiers
		if (company.identifiers && company.identifiers.length > 0) {
			md += `## Identifiers\n\n`;
			for (const id of company.identifiers) {
				md += `- **${id.identifier_system_name || id.identifier_system_code}**: ${id.identifier_uid}\n`;
			}
			md += "\n";
		}

		// Previous names
		if (company.previous_names && company.previous_names.length > 0) {
			md += `## Previous Names\n\n`;
			for (const pn of company.previous_names) {
				md += `- ${pn.company_name}`;
				if (pn.con_date) md += ` (until ${pn.con_date})`;
				md += "\n";
			}
			md += "\n";
		}

		// Alternative names
		if (company.alternative_names && company.alternative_names.length > 0) {
			md += `## Alternative Names\n\n`;
			for (const an of company.alternative_names) {
				md += `- ${an.company_name}`;
				if (an.type) md += ` (${an.type})`;
				md += "\n";
			}
			md += "\n";
		}

		// Source info
		md += "---\n\n";
		if (company.source?.publisher) {
			md += `**Source:** ${company.source.publisher}`;
			if (company.source.url) md += ` ([registry](${company.source.url}))`;
			md += "\n";
		}
		if (company.registry_url) {
			md += `**Official Registry:** ${company.registry_url}\n`;
		}
		if (company.retrieved_at) {
			md += `**Data Retrieved:** ${company.retrieved_at}\n`;
		}

		return buildResult(md, {
			url,
			finalUrl: company.opencorporates_url || url,
			method: "opencorporates",
			fetchedAt,
			notes: ["Fetched via OpenCorporates API"],
		});
	} catch {}

	return null;
};
