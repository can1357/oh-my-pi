//! `OpenCorporates` (`opencorporates.com/companies/<jurisdiction>/<number>`):
//! the company record from the v0.4 API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "opencorporates", open };

const METHOD: &str = "opencorporates";
/// Former officers listed before eliding.
const MAX_FORMER_OFFICERS: usize = 10;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("opencorporates.com") {
		return None;
	}
	let path = url.path();
	if !path.get(..11)?.eq_ignore_ascii_case("/companies/") {
		return None;
	}
	let mut segments = path[11..].split('/');
	let jurisdiction = percent_decode(segments.next()?);
	let number = percent_decode(segments.next()?);
	if jurisdiction.is_empty() || number.is_empty() {
		return None;
	}
	let api = format!("https://api.opencorporates.com/v0.4/companies/{jurisdiction}/{number}");
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let company = reply.json_value()?.get("results")?.get("company")?.clone();
		let markdown = render(&company)?;
		let mut done = Done::new(markdown, METHOD)
			.title(str_of(&company, "name").unwrap_or_default())
			.note("Fetched via OpenCorporates API");
		done.url = str_of(&company, "opencorporates_url").map(str::to_owned);
		done.finish()
	})
}

fn render(company: &Value) -> Option<String> {
	let mut md = format!("# {}\n\n", str_of(company, "name").unwrap_or_default());
	md.push_str("| Field | Value |\n|-------|-------|\n");
	let _ = writeln!(
		md,
		"| **Company Number** | {} |",
		str_of(company, "company_number").unwrap_or_default()
	);
	let _ = writeln!(
		md,
		"| **Jurisdiction** | {} |",
		str_of(company, "jurisdiction_code")?.to_uppercase()
	);
	for (label, key) in [
		("Status", "current_status"),
		("Company Type", "company_type"),
		("Incorporated", "incorporation_date"),
		("Dissolved", "dissolution_date"),
	] {
		if let Some(value) = str_of(company, key) {
			let _ = writeln!(md, "| **{label}** | {value} |");
		}
	}
	if let Some(branch) = str_of(company, "branch") {
		let status =
			str_of(company, "branch_status").map_or_else(String::new, |status| format!(" ({status})"));
		let _ = writeln!(md, "| **Branch** | {branch}{status} |");
	}
	if let Some(native) = str_of(company, "native_company_number")
		&& Some(native) != str_of(company, "company_number")
	{
		let _ = writeln!(md, "| **Native Number** | {native} |");
	}
	md.push('\n');

	address(company, &mut md);
	agent(company, &mut md);
	officers(company, &mut md);
	industry_codes(company, &mut md);
	identifiers(company, &mut md);
	previous_names(company, &mut md);
	alternative_names(company, &mut md);

	md.push_str("---\n\n");
	if let Some(publisher) = company
		.get("source")
		.and_then(|source| str_of(source, "publisher"))
	{
		let _ = write!(md, "**Source:** {publisher}");
		if let Some(url) = company
			.get("source")
			.and_then(|source| str_of(source, "url"))
		{
			let _ = write!(md, " ([registry]({url}))");
		}
		md.push('\n');
	}
	if let Some(registry) = str_of(company, "registry_url") {
		let _ = writeln!(md, "**Official Registry:** {registry}");
	}
	if let Some(retrieved) = str_of(company, "retrieved_at") {
		let _ = writeln!(md, "**Data Retrieved:** {retrieved}");
	}
	Some(md)
}

fn address(company: &Value, md: &mut String) {
	if let Some(full) = str_of(company, "registered_address_in_full") {
		let _ = write!(md, "## Registered Address\n\n{full}\n\n");
	} else if let Some(address) = company.get("registered_address") {
		let parts: Vec<&str> = ["street_address", "locality", "region", "postal_code", "country"]
			.iter()
			.filter_map(|key| str_of(address, key))
			.collect();
		if !parts.is_empty() {
			let _ = write!(md, "## Registered Address\n\n{}\n\n", parts.join(", "));
		}
	}
}

fn agent(company: &Value, md: &mut String) {
	let Some(name) = str_of(company, "agent_name") else {
		return;
	};
	let _ = write!(md, "## Registered Agent\n\n**{name}**");
	if let Some(address) = str_of(company, "agent_address") {
		let _ = write!(md, "\n{address}");
	}
	md.push_str("\n\n");
}

fn officer_ended(officer: &Value) -> bool {
	officer.get("inactive").and_then(Value::as_bool) == Some(true)
		|| str_of(officer, "end_date").is_some()
}

fn officers(company: &Value, md: &mut String) {
	let entries = arr_of(company, "officers");
	if entries.is_empty() {
		return;
	}
	let people: Vec<&Value> = entries
		.iter()
		.filter_map(|entry| entry.get("officer"))
		.collect();
	let active: Vec<&Value> = people
		.iter()
		.copied()
		.filter(|officer| !officer_ended(officer))
		.collect();
	let former: Vec<&Value> = people
		.iter()
		.copied()
		.filter(|officer| officer_ended(officer))
		.collect();

	if !active.is_empty() {
		let _ = write!(md, "## Current Officers ({})\n\n", active.len());
		for officer in &active {
			let _ = write!(md, "- **{}**", str_of(officer, "name").unwrap_or_default());
			if let Some(position) = str_of(officer, "position") {
				let _ = write!(md, " - {position}");
			}
			if let Some(start) = str_of(officer, "start_date") {
				let _ = write!(md, " (since {start})");
			}
			if let Some(occupation) = str_of(officer, "occupation") {
				let _ = write!(md, " [{occupation}]");
			}
			if let Some(nationality) = str_of(officer, "nationality") {
				let _ = write!(md, " ({nationality})");
			}
			md.push('\n');
		}
		md.push('\n');
	}

	if !former.is_empty() {
		let _ = write!(md, "## Former Officers ({})\n\n", former.len());
		for officer in former.iter().take(MAX_FORMER_OFFICERS) {
			let _ = write!(md, "- **{}**", str_of(officer, "name").unwrap_or_default());
			if let Some(position) = str_of(officer, "position") {
				let _ = write!(md, " - {position}");
			}
			match (str_of(officer, "start_date"), str_of(officer, "end_date")) {
				(Some(start), Some(end)) => {
					let _ = write!(md, " ({start} to {end})");
				},
				(None, Some(end)) => {
					let _ = write!(md, " (until {end})");
				},
				_ => {},
			}
			md.push('\n');
		}
		if former.len() > MAX_FORMER_OFFICERS {
			let _ =
				write!(md, "\n[…{} former officers elided…]\n", former.len() - MAX_FORMER_OFFICERS);
		}
		md.push('\n');
	}
}

fn industry_codes(company: &Value, md: &mut String) {
	let codes = arr_of(company, "industry_codes");
	if codes.is_empty() {
		return;
	}
	md.push_str("## Industry Codes\n\n");
	for code in codes {
		let _ = write!(md, "- **{}**", str_of(code, "code").unwrap_or_default());
		if let Some(description) = str_of(code, "description") {
			let _ = write!(md, ": {description}");
		}
		if let Some(scheme) = str_of(code, "code_scheme_name") {
			let _ = write!(md, " ({scheme})");
		}
		md.push('\n');
	}
	md.push('\n');
}

fn identifiers(company: &Value, md: &mut String) {
	let identifiers = arr_of(company, "identifiers");
	if identifiers.is_empty() {
		return;
	}
	md.push_str("## Identifiers\n\n");
	for identifier in identifiers {
		let name = str_of(identifier, "identifier_system_name")
			.or_else(|| str_of(identifier, "identifier_system_code"))
			.unwrap_or_default();
		let _ =
			writeln!(md, "- **{name}**: {}", str_of(identifier, "identifier_uid").unwrap_or_default());
	}
	md.push('\n');
}

fn previous_names(company: &Value, md: &mut String) {
	let names = arr_of(company, "previous_names");
	if names.is_empty() {
		return;
	}
	md.push_str("## Previous Names\n\n");
	for name in names {
		let _ = write!(md, "- {}", str_of(name, "company_name").unwrap_or_default());
		if let Some(date) = str_of(name, "con_date") {
			let _ = write!(md, " (until {date})");
		}
		md.push('\n');
	}
	md.push('\n');
}

fn alternative_names(company: &Value, md: &mut String) {
	let names = arr_of(company, "alternative_names");
	if names.is_empty() {
		return;
	}
	md.push_str("## Alternative Names\n\n");
	for name in names {
		let _ = write!(md, "- {}", str_of(name, "company_name").unwrap_or_default());
		if let Some(kind) = str_of(name, "type") {
			let _ = write!(md, " ({kind})");
		}
		md.push('\n');
	}
	md.push('\n');
}

/// Decode `%XX` escapes; invalid escapes pass through.
fn percent_decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& index + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
		{
			out.push(high << 4 | low);
			index += 3;
		} else {
			out.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8_lossy(&out).into_owned()
}

const fn hex(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_company_page_renders_table_officers_and_source() {
		let data = json!({ "api_version": "0.4", "results": { "company": {
			"name": "Apple Inc", "company_number": "2927442", "jurisdiction_code": "us_de",
			"incorporation_date": "1977-01-03", "company_type": "Corporation", "current_status": "Active",
			"registered_address_in_full": "1 Infinite Loop, Cupertino, CA 95014",
			"opencorporates_url": "https://opencorporates.com/companies/us_de/2927442",
			"source": { "publisher": "Delaware Division of Corporations", "url": "https://icis.corp.delaware.gov" },
			"officers": [
				{ "officer": { "name": "Tim Cook", "position": "CEO", "start_date": "2011-08-24" } },
				{ "officer": { "name": "Steve Jobs", "position": "CEO", "start_date": "1997", "end_date": "2011" } }
			],
			"industry_codes": [{ "code": "3571", "description": "Electronic Computers", "code_scheme_name": "SIC" }],
			"identifiers": [{ "identifier_system_code": "lei", "identifier_uid": "HWUPKR0MPOU8FGXBT394" }]
		} } });
		let mut requests = Vec::new();
		let done = run("https://opencorporates.com/companies/us_de/2927442", |request| {
			requests.push(request.url.clone());
			Fetched::json(&data)
		})
		.unwrap();
		assert_eq!(requests, ["https://api.opencorporates.com/v0.4/companies/us_de/2927442"]);
		assert_eq!((done.method, done.title.as_deref()), ("opencorporates", Some("Apple Inc")));
		assert_eq!(done.url.as_deref(), Some("https://opencorporates.com/companies/us_de/2927442"));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Apple Inc\n\n| Field | Value |\n|-------|-------|\n| **Company Number** | 2927442 \
			 |\n| **Jurisdiction** | US_DE |\n| **Status** | Active |\n| **Company Type** | \
			 Corporation |\n| **Incorporated** | 1977-01-03 |\n\n## Registered Address\n\n1 Infinite \
			 Loop, Cupertino, CA 95014\n\n"
		));
		assert!(
			md.contains("## Current Officers (1)\n\n- **Tim Cook** - CEO (since 2011-08-24)\n\n")
		);
		assert!(md.contains("## Former Officers (1)\n\n- **Steve Jobs** - CEO (1997 to 2011)\n\n"));
		assert!(md.contains("## Industry Codes\n\n- **3571**: Electronic Computers (SIC)\n"));
		assert!(md.contains("## Identifiers\n\n- **lei**: HWUPKR0MPOU8FGXBT394\n"));
		assert!(md.ends_with("**Source:** Delaware Division of Corporations ([registry](https://icis.corp.delaware.gov))\n"));
	}

	#[test]
	fn the_registered_address_can_be_assembled_from_parts() {
		let data = json!({ "results": { "company": {
			"name": "Example Ltd", "company_number": "1", "jurisdiction_code": "gb",
			"registered_address": { "street_address": "1 High Street", "locality": "London", "country": "United Kingdom" }
		} } });
		let done =
			run("https://opencorporates.com/companies/gb/1", |_| Fetched::json(&data)).unwrap();
		assert!(
			done
				.markdown
				.contains("## Registered Address\n\n1 High Street, London, United Kingdom\n\n")
		);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://opencorporates.com/about", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://opencorporates.com/companies/us_de/2927442", |_| Fetched::status(500)),
			None
		);
	}
}
