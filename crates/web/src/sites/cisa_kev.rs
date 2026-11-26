//! CISA Known Exploited Vulnerabilities
//! (`cisa.gov/known-exploited-vulnerabilities-*` with a CVE id in the path or
//! query): the matching entry of the KEV feed.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "cisa-kev", open };

const METHOD: &str = "cisa-kev";
const KEV_FEED: &str =
	"https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.to_lowercase().ends_with("cisa.gov") {
		return None;
	}
	if !url
		.path()
		.to_lowercase()
		.contains("known-exploited-vulnerabilities")
	{
		return None;
	}
	let cve_id = find_cve(url.path()).or_else(|| find_cve(url.query().unwrap_or_default()))?;

	fetch(Fetch::get(KEV_FEED).accept_json(), move |reply, _| {
		let catalog = reply.json_value()?;
		let entry = arr_of(&catalog, "vulnerabilities")
			.iter()
			.find(|entry| str_of(entry, "cveID").is_some_and(|id| id.eq_ignore_ascii_case(&cve_id)))?;
		Done::new(markdown(entry), METHOD)
			.title(cve_id)
			.note("Fetched via CISA KEV feed")
			.finish()
	})
}

/// The `CVE-\d{4}-\d{4,7}` scan of the TS handler, uppercased.
fn find_cve(text: &str) -> Option<String> {
	let bytes = text.as_bytes();
	let mut index = 0;
	while index + 4 <= bytes.len() {
		if bytes[index..index + 4].eq_ignore_ascii_case(b"CVE-") {
			let mut cursor = index + 4;
			let year_start = cursor;
			while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
				cursor += 1;
			}
			if cursor - year_start == 4 && bytes.get(cursor) == Some(&b'-') {
				let sequence_start = cursor + 1;
				cursor = sequence_start;
				while cursor < bytes.len()
					&& bytes[cursor].is_ascii_digit()
					&& cursor - sequence_start < 7
				{
					cursor += 1;
				}
				if (4..=7).contains(&(cursor - sequence_start)) {
					return Some(text[index..cursor].to_ascii_uppercase());
				}
			}
		}
		index += 1;
	}
	None
}

fn markdown(entry: &Value) -> String {
	let mut md = format!("# {}\n\n", str_of(entry, "cveID").unwrap_or_default());
	if let Some(name) = str_of(entry, "vulnerabilityName") {
		let _ = write!(md, "{name}\n\n");
	}
	md.push_str("## Metadata\n\n");
	for (label, key) in [
		("Vendor", "vendorProject"),
		("Product", "product"),
		("Date Added", "dateAdded"),
		("Due Date", "dueDate"),
	] {
		if let Some(value) = str_of(entry, key) {
			let _ = writeln!(md, "**{label}:** {value}");
		}
	}
	md.push('\n');
	if let Some(description) = str_of(entry, "shortDescription") {
		let _ = write!(md, "## Description\n\n{description}\n\n");
	}
	if let Some(action) = str_of(entry, "requiredAction") {
		let _ = write!(md, "## Required Action\n\n{action}\n\n");
	}
	md
}

#[cfg(test)]
mod tests {
	use serde_json::{Value, json};

	use super::super::{Fetched, testing::run};

	fn catalog() -> Value {
		json!({
			"title": "CISA Catalog of Known Exploited Vulnerabilities",
			"count": 2,
			"vulnerabilities": [
				{
					"cveID": "CVE-2021-44228", "vendorProject": "Apache", "product": "Log4j2",
					"vulnerabilityName": "Apache Log4j2 Remote Code Execution Vulnerability",
					"shortDescription": "Apache Log4j2 contains a vulnerability allowing remote code execution.",
					"requiredAction": "Apply updates per vendor instructions.",
					"dateAdded": "2021-12-10", "dueDate": "2021-12-24"
				},
				{
					"cveID": "CVE-2017-0144", "vendorProject": "Microsoft", "product": "SMBv1 server",
					"vulnerabilityName": "EternalBlue", "shortDescription": "SMBv1 has a buffer overflow.",
					"requiredAction": "Apply updates.", "dateAdded": "2022-02-15", "dueDate": "2022-03-01"
				}
			]
		})
	}

	#[test]
	fn a_catalog_page_renders_the_entry_named_in_the_query() {
		let mut requests = Vec::new();
		let done = run(
			"https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2021-44228",
			|request| {
				requests.push(request.url.clone());
				Fetched::json(&catalog())
			},
		)
		.unwrap();
		assert_eq!(requests, [
			"https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("cisa-kev", Some("CVE-2021-44228")));
		assert_eq!(
			done.markdown,
			"# CVE-2021-44228\n\nApache Log4j2 Remote Code Execution Vulnerability\n\n## \
			 Metadata\n\n**Vendor:** Apache\n**Product:** Log4j2\n**Date Added:** 2021-12-10\n**Due \
			 Date:** 2021-12-24\n\n## Description\n\nApache Log4j2 contains a vulnerability allowing \
			 remote code execution.\n\n## Required Action\n\nApply updates per vendor \
			 instructions.\n\n"
		);
	}

	#[test]
	fn a_cve_in_the_path_is_matched_case_insensitively_against_the_feed() {
		let done = run("https://www.cisa.gov/known-exploited-vulnerabilities-catalog/cve-2017-0144", |request| {
			assert_eq!(request.url, "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
			Fetched::json(&catalog())
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("CVE-2017-0144"));
		assert!(
			done.markdown.starts_with(
				"# CVE-2017-0144\n\nEternalBlue\n\n## Metadata\n\n**Vendor:** Microsoft\n"
			)
		);
	}

	#[test]
	fn other_pages_unknown_cves_and_failures_fall_through() {
		assert_eq!(
			run("https://www.cisa.gov/news-events/alerts/2021/12/10/apache-log4j", |_| panic!(
				"no fetch expected"
			)),
			None
		);
		assert_eq!(
			run("https://www.cisa.gov/known-exploited-vulnerabilities-catalog", |_| panic!(
				"no fetch expected"
			)),
			None
		);
		assert_eq!(
			run(
				"https://example.com/known-exploited-vulnerabilities-catalog?cve=CVE-2021-44228",
				|_| panic!("no fetch expected")
			),
			None
		);
		assert_eq!(
			run(
				"https://www.cisa.gov/known-exploited-vulnerabilities-catalog?cve=CVE-2021-44228",
				|_| Fetched::status(503)
			),
			None
		);
		assert_eq!(
			run(
				"https://www.cisa.gov/known-exploited-vulnerabilities-catalog?cve=CVE-2020-9999",
				|_| Fetched::json(&catalog())
			),
			None
		);
	}
}
