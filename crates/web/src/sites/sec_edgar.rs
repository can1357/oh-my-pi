//! SEC EDGAR (`sec.gov`). A company URL — `?CIK=` query, `/cik/<n>` or
//! `/Archives/edgar/data/<n>/` directory — becomes the submissions profile from
//! the `data.sec.gov` API. Deeper Archives paths name a filing or one of its
//! documents and are left to the generic reader.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, segment, str_of, strs_of};

/// Registry entry.
pub const SITE: Site = Site { name: "sec-edgar", open };

const METHOD: &str = "sec-edgar";
/// Forms shown in the key-filings table.
const KEY_FORMS: &[&str] = &["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A"];
const KEY_FILINGS: usize = 15;
const ALL_FILINGS: usize = 20;

fn open(url: &Url, _: &Context) -> Option<Action> {
	let cik = extract_cik(url)?;
	let api = format!("https://data.sec.gov/submissions/CIK{cik}.json");
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let company = reply.json_value()?;
		let name = str_of(&company, "name")
			.unwrap_or("Unknown company")
			.to_owned();
		let markdown = profile(&cik, &company, &name);
		Done::new(markdown, METHOD)
			.title(name)
			.note("Fetched via SEC EDGAR API")
			.finish()
	})
}

/// The CIK a URL names, as ten digits, or `None` when it names a filing.
fn extract_cik(url: &Url) -> Option<String> {
	if !url.host_str()?.contains("sec.gov") {
		return None;
	}
	if let Some((_, cik)) = url
		.query_pairs()
		.find(|(key, _)| key.eq_ignore_ascii_case("cik"))
	{
		return Some(normalize_cik(&cik));
	}
	let path = url.path();
	let lower = path.to_lowercase();
	for rest in lower.split("/cik/").skip(1) {
		let digits = leading_digits(rest);
		if !digits.is_empty() {
			return Some(normalize_cik(digits));
		}
	}
	if let Some(rest) = lower.split("/submissions/cik").nth(1) {
		let digits = leading_digits(rest);
		if !digits.is_empty() && rest[digits.len()..].starts_with(".json") {
			return Some(normalize_cik(digits));
		}
	}
	if path.contains("/cgi-bin/browse-edgar")
		&& url
			.query_pairs()
			.any(|(key, value)| key == "company" && !value.is_empty())
	{
		return None;
	}
	let rest = path.strip_prefix("/Archives/edgar/data/")?;
	let digits = rest.strip_suffix('/').unwrap_or(rest);
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	Some(normalize_cik(digits))
}

/// Ten digits, zero-padded (`0000320193`).
fn normalize_cik(cik: &str) -> String {
	let digits: String = cik.chars().filter(|c| c.is_ascii_digit()).collect();
	format!("{digits:0>10}")
}

fn leading_digits(text: &str) -> &str {
	let end = text
		.find(|c: char| !c.is_ascii_digit())
		.unwrap_or(text.len());
	&text[..end]
}

/// One recent filing of the submissions feed.
struct Filing<'a> {
	date:        &'a str,
	form:        &'a str,
	accession:   &'a str,
	document:    &'a str,
	description: &'a str,
}

fn profile(cik: &str, company: &Value, name: &str) -> String {
	let mut md = format!("# {name}\n\n");
	let _ = write!(md, "**CIK:** {}", str_of(company, "cik").unwrap_or(cik));
	let tickers = strs_of(company, "tickers");
	if !tickers.is_empty() {
		let label = if tickers.len() > 1 {
			"Tickers"
		} else {
			"Ticker"
		};
		let _ = write!(md, " · **{label}:** {}", tickers.join(", "));
	}
	let exchanges = strs_of(company, "exchanges");
	if !exchanges.is_empty() {
		let _ = write!(md, " ({})", exchanges.join(", "));
	}
	md.push('\n');
	if let Some(entity_type) = str_of(company, "entityType") {
		let _ = writeln!(md, "**Entity Type:** {entity_type}");
	}
	if let Some(sic) = str_of(company, "sic") {
		let _ =
			writeln!(md, "**SIC:** {sic} - {}", str_of(company, "sicDescription").unwrap_or_default());
	}
	if let Some(state) = str_of(company, "stateOfIncorporation") {
		let _ = writeln!(md, "**State of Incorporation:** {state}");
	}
	if let Some(ein) = str_of(company, "ein") {
		let _ = writeln!(md, "**EIN:** {ein}");
	}
	if let Some(fiscal_year_end) = str_of(company, "fiscalYearEnd") {
		let month = fiscal_year_end.get(..2).unwrap_or(fiscal_year_end);
		let day = fiscal_year_end.get(2..).unwrap_or_default();
		let _ = writeln!(md, "**Fiscal Year End:** {month}/{day}");
	}
	md.push('\n');

	if let Some(address) = company
		.get("addresses")
		.and_then(|addresses| addresses.get("business"))
	{
		let address = format_address(address);
		if !address.is_empty() {
			let _ = write!(md, "## Business Address\n\n{address}\n\n");
		}
	}
	if let Some(filings) =
		filing_table(cik, company, KEY_FORMS, KEY_FILINGS, "Recent Filings (10-K, 10-Q, 8-K)")
	{
		md.push_str(&filings);
	}
	if let Some(filings) = filing_table(cik, company, &[], ALL_FILINGS, "All Recent Filings") {
		md.push_str(&filings);
	}

	let search = segment(name);
	let _ = write!(
		md,
		"## Links\n\n- [SEC EDGAR Filings](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=&dateb=&owner=include&count=40)\n\
		 - [Company Search](https://www.sec.gov/cgi-bin/browse-edgar?company={search}&CIK=&type=&owner=include&count=40&action=getcompany)\n"
	);
	md
}

/// The street lines of an address, city line last.
fn format_address(address: &Value) -> String {
	let mut parts: Vec<String> = ["street1", "street2"]
		.iter()
		.filter_map(|key| str_of(address, key))
		.map(str::to_owned)
		.collect();
	let city_line: Vec<&str> = ["city", "stateOrCountry", "zipCode"]
		.iter()
		.filter_map(|key| str_of(address, key))
		.collect();
	if !city_line.is_empty() {
		parts.push(city_line.join(", "));
	}
	parts.join("\n")
}

/// The filings matching `forms` (all when empty), newest first, as a table.
fn filing_table(
	cik: &str,
	company: &Value,
	forms: &[&str],
	limit: usize,
	title: &str,
) -> Option<String> {
	let filings = recent_filings(company, forms, limit);
	if filings.is_empty() {
		return None;
	}
	let mut md =
		format!("## {title}\n\n| Date | Form | Description |\n|------|------|-------------|\n");
	for filing in &filings {
		let description = if filing.description.is_empty() {
			filing.form
		} else {
			filing.description
		};
		let url = filing_url(cik, filing.accession, filing.document);
		let _ = writeln!(md, "| {} | [{}]({url}) | {description} |", filing.date, filing.form);
	}
	md.push('\n');
	Some(md)
}

/// The parallel arrays of `filings.recent`, read index by index.
fn recent_filings<'a>(company: &'a Value, forms: &[&str], limit: usize) -> Vec<Filing<'a>> {
	let Some(recent) = company
		.get("filings")
		.and_then(|filings| filings.get("recent"))
	else {
		return Vec::new();
	};
	let entries = arr_of(recent, "form");
	let dates = arr_of(recent, "filingDate");
	let accessions = arr_of(recent, "accessionNumber");
	let documents = arr_of(recent, "primaryDocument");
	let descriptions = arr_of(recent, "primaryDocDescription");
	let mut filings = Vec::new();
	for (index, form) in entries.iter().enumerate() {
		let Some(form) = form.as_str() else { continue };
		if !forms.is_empty() && !forms.contains(&form) {
			continue;
		}
		if filings.len() >= limit {
			break;
		}
		filings.push(Filing {
			date: text_at(dates, index),
			form,
			accession: text_at(accessions, index),
			document: text_at(documents, index),
			description: text_at(descriptions, index),
		});
	}
	filings
}

fn text_at(values: &[Value], index: usize) -> &str {
	values
		.get(index)
		.and_then(Value::as_str)
		.unwrap_or_default()
}

/// The Archives URL of a filing document (`cik` without leading zeros).
fn filing_url(cik: &str, accession: &str, document: &str) -> String {
	let accession: String = accession.chars().filter(|c| *c != '-').collect();
	let cik = cik.trim_start_matches('0');
	let cik = if cik.is_empty() { "0" } else { cik };
	format!("https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}")
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn company() -> serde_json::Value {
		json!({
			"cik": "0000320193", "entityType": "operating", "sic": "3571", "sicDescription": "Computers",
			"name": "Apple Inc.", "tickers": ["AAPL"], "exchanges": ["Nasdaq"], "ein": "942404110",
			"stateOfIncorporation": "CA", "fiscalYearEnd": "0930",
			"addresses": {
				"business": { "street1": "One Apple Park Way", "city": "Cupertino", "stateOrCountry": "CA", "zipCode": "95014" },
				"mailing": {}
			},
			"filings": { "recent": {
				"accessionNumber": ["0000320193-24-000123", "0000320193-24-000100"],
				"filingDate": ["2024-11-01", "2024-08-02"],
				"reportDate": ["2024-09-28", "2024-06-29"],
				"acceptanceDateTime": ["", ""],
				"form": ["10-K", "10-Q"],
				"primaryDocument": ["aapl-20240928.htm", "aapl-20240629.htm"],
				"primaryDocDescription": ["10-K", ""]
			} }
		})
	}

	#[test]
	fn a_company_directory_reads_the_submissions_api() {
		let mut requests = Vec::new();
		let done = run("https://www.sec.gov/Archives/edgar/data/320193/", |request| {
			requests.push(request.url.clone());
			Fetched::json(&company())
		})
		.unwrap();
		assert_eq!(requests, ["https://data.sec.gov/submissions/CIK0000320193.json"]);
		assert_eq!((done.method, done.title.as_deref()), ("sec-edgar", Some("Apple Inc.")));
		let md = &done.markdown;
		assert!(md.starts_with("# Apple Inc.\n\n**CIK:** 0000320193 · **Ticker:** AAPL (Nasdaq)\n"));
		assert!(md.contains(
			"**Entity Type:** operating\n**SIC:** 3571 - Computers\n**State of Incorporation:** \
			 CA\n**EIN:** 942404110\n**Fiscal Year End:** 09/30\n"
		));
		assert!(md.contains("## Business Address\n\nOne Apple Park Way\nCupertino, CA, 95014\n\n"));
		assert!(md.contains(
			"## Recent Filings (10-K, 10-Q, 8-K)\n\n| Date | Form | Description \
			 |\n|------|------|-------------|\n"
		));
		assert!(md.contains("| 2024-11-01 | [10-K](https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm) | 10-K |\n"));
		assert!(md.contains("| 2024-08-02 | [10-Q](https://www.sec.gov/Archives/edgar/data/320193/000032019324000100/aapl-20240629.htm) | 10-Q |\n"));
		assert!(md.contains("## All Recent Filings\n\n"));
		assert!(md.contains("## Links\n\n- [SEC EDGAR Filings](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=&dateb=&owner=include&count=40)\n- [Company Search](https://www.sec.gov/cgi-bin/browse-edgar?company=Apple%20Inc.&CIK=&type=&owner=include&count=40&action=getcompany)\n"));
		assert_eq!(done.notes, ["Fetched via SEC EDGAR API"]);
	}

	#[test]
	fn a_cik_query_names_the_same_company() {
		let done =
			run("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=320193", |request| {
				assert_eq!(request.url, "https://data.sec.gov/submissions/CIK0000320193.json");
				Fetched::json(&company())
			})
			.unwrap();
		assert!(done.markdown.starts_with("# Apple Inc.\n"));
	}

	#[test]
	fn filings_documents_and_api_failures_fall_through() {
		for url in [
			"https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
			"https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/",
			"https://www.sec.gov/cgi-bin/browse-edgar?company=apple",
			"https://example.test/?CIK=320193",
		] {
			assert_eq!(run(url, |_| panic!("no fetch expected")), None, "{url}");
		}
		assert_eq!(
			run("https://www.sec.gov/Archives/edgar/data/320193/", |_| Fetched::status(403)),
			None
		);
	}
}
