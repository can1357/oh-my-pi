//! OSV (`osv.dev/vulnerability/<id>`): one OSV API request for the full
//! vulnerability record: metadata, details, affected packages, references and
//! credits.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, iso_date, str_of, strs_of};

/// Registry entry.
pub const SITE: Site = Site { name: "osv", open };

const METHOD: &str = "osv";
/// Versions listed per affected package before eliding.
const MAX_VERSIONS: usize = 10;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "osv.dev" {
		return None;
	}
	let id = url
		.path()
		.strip_prefix("/vulnerability/")
		.filter(|id| {
			!id.is_empty()
				&& id
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
		})?
		.to_owned();
	fetch(Fetch::get(format!("https://api.osv.dev/v1/vulns/{id}")).accept_json(), move |reply, _| {
		let vuln = reply.json_value()?;
		let title = str_of(&vuln, "id").unwrap_or(id.as_str()).to_owned();
		Done::new(markdown(&vuln), METHOD)
			.title(title)
			.note("Fetched via OSV API")
			.finish()
	})
}

fn markdown(vuln: &Value) -> String {
	let mut md = format!("# {}\n\n", str_of(vuln, "id").unwrap_or_default());
	if let Some(summary) = str_of(vuln, "summary") {
		let _ = write!(md, "{summary}\n\n");
	}

	md.push_str("## Metadata\n\n");
	let aliases = strs_of(vuln, "aliases");
	if !aliases.is_empty() {
		let _ = writeln!(md, "**Aliases:** {}", aliases.join(", "));
	}
	for (label, key) in
		[("Published", "published"), ("Modified", "modified"), ("Withdrawn", "withdrawn")]
	{
		if let Some(date) = str_of(vuln, key).and_then(iso_date) {
			let _ = writeln!(md, "**{label}:** {date}");
		}
	}
	let severities = severity_list(vuln);
	if !severities.is_empty() {
		let formatted = severities
			.iter()
			.map(|(kind, score)| format!("{kind}: {score}"))
			.collect::<Vec<_>>()
			.join(", ");
		let _ = writeln!(md, "**Severity:** {formatted}");
	}
	md.push('\n');

	if let Some(details) = str_of(vuln, "details") {
		let _ = write!(md, "## Details\n\n{details}\n\n");
	}

	let affected = arr_of(vuln, "affected");
	if !affected.is_empty() {
		md.push_str("## Affected Packages\n\n");
		for entry in affected {
			let Some(package) = entry.get("package") else {
				continue;
			};
			let _ = write!(
				md,
				"### {}: {}\n\n",
				str_of(package, "ecosystem").unwrap_or("?"),
				str_of(package, "name").unwrap_or("?")
			);
			for range in arr_of(entry, "ranges") {
				let mut parts: Vec<String> = Vec::new();
				for event in arr_of(range, "events") {
					for (label, key) in [
						("introduced", "introduced"),
						("fixed", "fixed"),
						("last_affected", "last_affected"),
						("limit", "limit"),
					] {
						if let Some(value) = str_of(event, key) {
							parts.push(format!("{label}: {value}"));
						}
					}
				}
				if !parts.is_empty() {
					let _ = writeln!(
						md,
						"- **{}:** {}",
						str_of(range, "type").unwrap_or("?"),
						parts.join(" → ")
					);
				}
			}
			let versions = strs_of(entry, "versions");
			if !versions.is_empty() {
				let listed = if versions.len() > MAX_VERSIONS {
					format!("{}… ({} total)", versions[..MAX_VERSIONS].join(", "), versions.len())
				} else {
					versions.join(", ")
				};
				let _ = writeln!(md, "- **Versions:** {listed}");
			}
			md.push('\n');
		}
	}

	let references = arr_of(vuln, "references");
	if !references.is_empty() {
		md.push_str("## References\n\n");
		for reference in references {
			let _ = writeln!(
				md,
				"- [{}]({})",
				str_of(reference, "type").unwrap_or("?"),
				str_of(reference, "url").unwrap_or_default()
			);
		}
		md.push('\n');
	}

	let credits = arr_of(vuln, "credits");
	if !credits.is_empty() {
		md.push_str("## Credits\n\n");
		for credit in credits {
			let name = str_of(credit, "name").unwrap_or_default();
			match str_of(credit, "type") {
				Some(kind) => {
					let _ = writeln!(md, "- {name} ({kind})");
				},
				None => {
					let _ = writeln!(md, "- {name}");
				},
			}
		}
	}
	md
}

/// `(type, score)` of the top-level severities, or of the affected packages
/// when the record has no top-level list (the TS used `||`).
fn severity_list(vuln: &Value) -> Vec<(String, String)> {
	let entries: Vec<&Value> = match vuln.get("severity") {
		Some(Value::Array(values)) => values.iter().collect(),
		_ => arr_of(vuln, "affected")
			.iter()
			.flat_map(|affected| arr_of(affected, "severity"))
			.collect(),
	};
	entries
		.into_iter()
		.filter_map(|entry| {
			Some((str_of(entry, "type")?.to_owned(), str_of(entry, "score")?.to_owned()))
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn vuln() -> serde_json::Value {
		json!({
			"id": "GHSA-jfh8-c2jp-5v3q",
			"summary": "Remote code execution in Log4j",
			"details": "JNDI features lead to RCE.",
			"aliases": ["CVE-2021-44228"],
			"published": "2021-12-10T00:00:00Z",
			"modified": "2022-01-01T00:00:00Z",
			"severity": [{ "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L" }],
			"affected": [{
				"package": { "ecosystem": "Maven", "name": "org.apache.logging.log4j:log4j-core" },
				"ranges": [{ "type": "ECOSYSTEM", "events": [
					{ "introduced": "2.0-beta9" }, { "fixed": "2.3.1" }, { "fixed": "2.12.2" }
				] }],
				"versions": ["2.0", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11"]
			}],
			"references": [{ "type": "WEB", "url": "https://logging.apache.org/log4j/2.x/security.html" }],
			"credits": [{ "name": "Chen Zhaojun", "type": "FINDER" }]
		})
	}

	#[test]
	fn a_vulnerability_renders_every_section() {
		let done = run("https://osv.dev/vulnerability/GHSA-jfh8-c2jp-5v3q", |request| {
			assert_eq!(request.url, "https://api.osv.dev/v1/vulns/GHSA-jfh8-c2jp-5v3q");
			assert!(
				request
					.headers
					.iter()
					.any(|(name, value)| name == "Accept" && value == "application/json")
			);
			Fetched::json(&vuln())
		})
		.unwrap();
		assert_eq!(done.method, "osv");
		assert_eq!(done.title.as_deref(), Some("GHSA-jfh8-c2jp-5v3q"));
		assert_eq!(done.notes, ["Fetched via OSV API"]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# GHSA-jfh8-c2jp-5v3q\n\nRemote code execution in Log4j\n\n## Metadata\n\n**Aliases:** \
			 CVE-2021-44228\n**Published:** 2021-12-10\n**Modified:** 2022-01-01\n**Severity:** \
			 CVSS_V3: CVSS:3.1/AV:N/AC:L\n\n## Details\n\nJNDI features lead to RCE.\n\n"
		));
		assert!(md.contains(
			"### Maven: org.apache.logging.log4j:log4j-core\n\n- **ECOSYSTEM:** introduced: \
			 2.0-beta9 → fixed: 2.3.1 → fixed: 2.12.2\n"
		));
		assert!(md.contains(
			"- **Versions:** 2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9… (12 total)\n"
		));
		assert!(md.contains(
			"## References\n\n- [WEB](https://logging.apache.org/log4j/2.x/security.html)\n\n## \
			 Credits\n\n- Chen Zhaojun (FINDER)\n"
		));
	}

	#[test]
	fn severities_fall_back_to_the_affected_packages() {
		let done = run("https://osv.dev/vulnerability/PYSEC-2021-19", |_| {
			Fetched::json(&json!({
				"id": "PYSEC-2021-19",
				"affected": [{ "package": { "ecosystem": "PyPI", "name": "pillow" }, "severity": [{ "type": "CVSS_V3", "score": "9.8" }] }]
			}))
		})
		.unwrap();
		assert!(done.markdown.contains("**Severity:** CVSS_V3: 9.8\n"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://osv.dev/list", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://osv.dev/vulnerability/GHSA-x/extra", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://osv.dev/vulnerability/GHSA-jfh8-c2jp-5v3q", |_| Fetched::status(404)),
			None
		);
	}
}
