//! NVD (`nvd.nist.gov/vuln/detail/<CVE>`): the CVE record from the NVD 2.0 API,
//! with scores, weaknesses, affected CPEs and references.

use std::{fmt::Write as _, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, iso_date, str_of, strs_of};

/// Registry entry.
pub const SITE: Site = Site { name: "nvd", open };

const METHOD: &str = "nvd";
/// Affected CPEs listed before eliding.
const MAX_CPES: usize = 20;
/// References listed before eliding.
const MAX_REFERENCES: usize = 15;

static CVE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?i)/vuln/detail/(CVE-\d{4}-\d+)").expect("valid CVE pattern"));

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("nvd.nist.gov") {
		return None;
	}
	let cve = CVE
		.captures(url.path())?
		.get(1)?
		.as_str()
		.to_ascii_uppercase();
	let api = format!("https://services.nvd.nist.gov/rest/json/cves/2.0?cveId={cve}");
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let vuln = arr_of(&data, "vulnerabilities").first()?.get("cve")?;
		let markdown = render(vuln)?;
		Done::new(markdown, METHOD)
			.title(str_of(vuln, "id").unwrap_or_default())
			.note("Fetched via NVD API")
			.finish()
	})
}

/// The `YYYY-MM-DD` of a date field, empty when absent or malformed.
fn date<'a>(cve: &'a Value, key: &str) -> &'a str {
	str_of(cve, key).and_then(iso_date).unwrap_or("")
}

fn render(vuln: &Value) -> Option<String> {
	let mut md = format!("# {}\n\n", str_of(vuln, "id").unwrap_or_default());
	if let Some(status) = str_of(vuln, "vulnStatus") {
		let _ = writeln!(md, "**Status:** {status}");
	}
	let _ = write!(md, "**Published:** {}", date(vuln, "published"));
	let _ = write!(md, " · **Modified:** {}\n\n", date(vuln, "lastModified"));

	let description = arr_of(vuln, "descriptions")
		.iter()
		.find(|entry| str_of(entry, "lang") == Some("en"))
		.and_then(|entry| str_of(entry, "value"));
	if let Some(description) = description {
		let _ = write!(md, "## Description\n\n{description}\n\n");
	}

	let metrics = vuln.get("metrics");
	let v31 = metrics.and_then(|metrics| arr_of(metrics, "cvssMetricV31").first());
	let v30 = metrics.and_then(|metrics| arr_of(metrics, "cvssMetricV30").first());
	let v2 = metrics.and_then(|metrics| arr_of(metrics, "cvssMetricV2").first());
	if v31.is_some() || v30.is_some() || v2.is_some() {
		md.push_str("## CVSS Scores\n\n");
	}
	if let Some(metric) = v31 {
		let data = metric.get("cvssData")?;
		md.push_str("### CVSS 3.1\n\n");
		let _ = writeln!(
			md,
			"- **Base Score:** {} ({})",
			number(data, "baseScore"),
			str_of(data, "baseSeverity").unwrap_or_default()
		);
		let _ = writeln!(md, "- **Vector:** `{}`", str_of(data, "vectorString").unwrap_or_default());
		if let Some(score) = metric.get("exploitabilityScore").and_then(Value::as_f64) {
			let _ = writeln!(md, "- **Exploitability:** {score}");
		}
		if let Some(score) = metric.get("impactScore").and_then(Value::as_f64) {
			let _ = writeln!(md, "- **Impact:** {score}");
		}
		md.push('\n');
	}
	if let Some(metric) = v30
		&& v31.is_none()
	{
		let data = metric.get("cvssData")?;
		md.push_str("### CVSS 3.0\n\n");
		let _ = writeln!(
			md,
			"- **Base Score:** {} ({})",
			number(data, "baseScore"),
			str_of(data, "baseSeverity").unwrap_or_default()
		);
		let _ =
			write!(md, "- **Vector:** `{}`\n\n", str_of(data, "vectorString").unwrap_or_default());
	}
	if let Some(metric) = v2 {
		let data = metric.get("cvssData")?;
		md.push_str("### CVSS 2.0\n\n");
		let _ = write!(md, "- **Base Score:** {}", number(data, "baseScore"));
		if let Some(severity) = str_of(data, "severity") {
			let _ = write!(md, " ({severity})");
		}
		let _ =
			write!(md, "\n- **Vector:** `{}`\n\n", str_of(data, "vectorString").unwrap_or_default());
	}

	let mut weaknesses = Vec::new();
	for weakness in arr_of(vuln, "weaknesses") {
		for entry in arr_of(weakness, "description") {
			if str_of(entry, "lang") == Some("en")
				&& let Some(value) = str_of(entry, "value")
				&& value != "NVD-CWE-Other"
				&& value != "NVD-CWE-noinfo"
			{
				weaknesses.push(value);
			}
		}
	}
	if !weaknesses.is_empty() {
		md.push_str("## Weaknesses\n\n");
		for weakness in &weaknesses {
			let _ = writeln!(md, "- {weakness}");
		}
		md.push('\n');
	}

	let cpes = extract_cpes(arr_of(vuln, "configurations"));
	if !cpes.is_empty() {
		md.push_str("## Affected Products\n\n");
		for cpe in cpes.iter().take(MAX_CPES) {
			let _ = writeln!(md, "- `{cpe}`");
		}
		if cpes.len() > MAX_CPES {
			let _ = write!(md, "\n[…{} CPEs elided…]\n", cpes.len() - MAX_CPES);
		}
		md.push('\n');
	}

	let references = arr_of(vuln, "references");
	if !references.is_empty() {
		md.push_str("## References\n\n");
		for reference in references.iter().take(MAX_REFERENCES) {
			let _ = write!(md, "- {}", str_of(reference, "url").unwrap_or_default());
			let tags = strs_of(reference, "tags");
			if !tags.is_empty() {
				let _ = write!(md, " ({})", tags.join(", "));
			}
			md.push('\n');
		}
		if references.len() > MAX_REFERENCES {
			let _ = write!(md, "\n[…{} references elided…]\n", references.len() - MAX_REFERENCES);
		}
	}
	Some(md)
}

/// A CVSS number as written by the API (`10`, `9.8`).
fn number(data: &Value, key: &str) -> String {
	f64_of(data, key).map_or_else(String::new, |value| format!("{value}"))
}

fn extract_cpes(configurations: &[Value]) -> Vec<String> {
	let mut cpes: Vec<String> = Vec::new();
	for configuration in configurations {
		for node in arr_of(configuration, "nodes") {
			for matched in arr_of(node, "cpeMatch") {
				if matched.get("vulnerable").and_then(Value::as_bool) == Some(true)
					&& let Some(criteria) = str_of(matched, "criteria")
					&& !cpes.iter().any(|cpe| cpe == criteria)
				{
					cpes.push(criteria.to_owned());
				}
			}
		}
	}
	cpes
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_cve_page_renders_scores_weaknesses_products_and_references() {
		let data = json!({ "vulnerabilities": [{ "cve": {
			"id": "CVE-2021-44228", "vulnStatus": "Analyzed",
			"published": "2021-12-10T10:15:09.143Z", "lastModified": "2023-11-07T03:39:21.780Z",
			"descriptions": [{ "lang": "es", "value": "Spanish" }, { "lang": "en", "value": "Log4j RCE" }],
			"metrics": { "cvssMetricV31": [{ "cvssData": { "baseScore": 10.0, "baseSeverity": "CRITICAL",
				"vectorString": "CVSS:3.1/AV:N/AC:L" }, "exploitabilityScore": 3.9, "impactScore": 6.0 }] },
			"weaknesses": [{ "description": [
				{ "lang": "en", "value": "CWE-502" },
				{ "lang": "en", "value": "NVD-CWE-noinfo" }
			] }],
			"configurations": [{ "nodes": [{ "cpeMatch": [
				{ "criteria": "cpe:2.3:a:apache:log4j:*:*:*:*:*:*:*:*", "vulnerable": true },
				{ "criteria": "cpe:2.3:o:linux:kernel:*:*:*:*:*:*:*:*", "vulnerable": false }
			] }] }],
			"references": [{ "url": "https://logging.apache.org/log4j/2.x/security.html", "tags": ["Vendor Advisory"] }]
		} }] });
		let mut requests = Vec::new();
		let done = run("https://nvd.nist.gov/vuln/detail/cve-2021-44228", |request| {
			requests.push(request.url.clone());
			Fetched::json(&data)
		})
		.unwrap();
		assert_eq!(requests, [
			"https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("nvd", Some("CVE-2021-44228")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# CVE-2021-44228\n\n**Status:** Analyzed\n**Published:** 2021-12-10 · **Modified:** \
			 2023-11-07\n\n## Description\n\nLog4j RCE\n\n"
		));
		assert!(md.contains(
			"### CVSS 3.1\n\n- **Base Score:** 10 (CRITICAL)\n- **Vector:** `CVSS:3.1/AV:N/AC:L`\n- \
			 **Exploitability:** 3.9\n- **Impact:** 6\n"
		));
		assert!(md.contains("## Weaknesses\n\n- CWE-502\n"));
		assert!(
			md.contains("## Affected Products\n\n- `cpe:2.3:a:apache:log4j:*:*:*:*:*:*:*:*`\n\n")
		);
		assert!(md.contains(
			"## References\n\n- https://logging.apache.org/log4j/2.x/security.html (Vendor \
			 Advisory)\n"
		));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://nvd.nist.gov/vuln/search/results?query=log4j", |_| panic!(
				"no fetch expected"
			)),
			None
		);
		assert_eq!(
			run("https://example.test/vuln/detail/CVE-2021-44228", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://nvd.nist.gov/vuln/detail/CVE-2021-44228", |_| Fetched::status(403)),
			None
		);
	}
}
