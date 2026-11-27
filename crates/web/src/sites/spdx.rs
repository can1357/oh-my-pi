//! SPDX (`spdx.org/licenses/<id>`). The license list's JSON carries the
//! metadata, cross references and full license text in one request.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, html_to_markdown, i64_of, segment, str_of,
	strs_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "spdx", open };

const METHOD: &str = "spdx-api";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "spdx.org" | "www.spdx.org") {
		return None;
	}
	let rest = url.path().strip_prefix("/licenses/")?;
	let rest = rest.strip_suffix('/').unwrap_or(rest);
	let encoded = strip_html_suffix(rest);
	if encoded.is_empty() || encoded.contains('/') {
		return None;
	}
	let license_id = percent_decode(encoded).filter(|id| !id.is_empty())?;
	let api = format!("https://spdx.org/licenses/{}.json", segment(&license_id));
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let license = reply.json_value()?;
		let id = str_of(&license, "licenseId").unwrap_or(&license_id);
		let title = str_of(&license, "name")
			.or_else(|| str_of(&license, "licenseId"))
			.unwrap_or(&license_id)
			.to_owned();
		let mut md = format!(
			"# {title}\n\n**License ID:** `{id}`\n**OSI Approved:** {}\n**FSF Libre:** {}\n",
			yes_no(license.get("isOsiApproved")),
			yes_no(license.get("isFsfLibre"))
		);
		if let Some(description) =
			str_of(&license, "licenseComments").or_else(|| str_of(&license, "comment"))
		{
			let _ = write!(md, "\n## Description\n\n{description}\n");
		}
		let references = cross_references(&license);
		if !references.is_empty() {
			md.push_str("\n## Cross References\n\n");
			for reference in &references {
				let _ = writeln!(md, "- {reference}");
			}
		}
		let text = str_of(&license, "licenseText")
			.map(str::to_owned)
			.or_else(|| str_of(&license, "licenseTextHtml").map(|html| html_to_markdown(html, None)));
		if let Some(text) = text {
			let _ = write!(md, "\n## License Text\n\n```\n{text}\n```\n");
		}
		Done::new(md, METHOD)
			.title(title)
			.note("Fetched via SPDX license API")
			.finish()
	})
}

/// Drop a trailing `.html` (case-insensitive), as the TS path pattern does.
fn strip_html_suffix(path: &str) -> &str {
	let Some(suffix) = path.get(path.len().saturating_sub(5)..) else {
		return path;
	};
	if path.len() > 5 && suffix.eq_ignore_ascii_case(".html") {
		&path[..path.len() - 5]
	} else {
		path
	}
}

fn yes_no(value: Option<&Value>) -> &'static str {
	match value.and_then(Value::as_bool) {
		Some(true) => "Yes",
		Some(false) => "No",
		None => "Unknown",
	}
}

/// The cross-reference URLs by `order`, then the `seeAlso` URLs, without
/// repeats.
fn cross_references(license: &Value) -> Vec<String> {
	let mut ordered: Vec<(i64, &str)> = arr_of(license, "crossRef")
		.iter()
		.filter_map(|reference| {
			Some((i64_of(reference, "order").unwrap_or(0), str_of(reference, "url")?))
		})
		.collect();
	ordered.sort_by_key(|(order, _)| *order);
	let mut references: Vec<String> = ordered.into_iter().map(|(_, url)| url.to_owned()).collect();
	for url in strs_of(license, "seeAlso") {
		if !references.iter().any(|seen| seen == url) {
			references.push(url.to_owned());
		}
	}
	references
}

/// Percent-decode a path segment (`decodeURIComponent`); `None` on a malformed
/// escape.
fn percent_decode(text: &str) -> Option<String> {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let hex = bytes.get(index + 1..index + 3)?;
			out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
			index += 3;
		} else {
			out.push(bytes[index]);
			index += 1;
		}
	}
	Some(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_license_page_renders_metadata_references_and_text() {
		let license = json!({
			"licenseId": "MIT", "name": "MIT License", "isOsiApproved": true, "isFsfLibre": true,
			"licenseText": "Permission is hereby granted, free of charge.",
			"licenseComments": "A permissive license.",
			"crossRef": [
				{ "url": "https://x.test/dup", "order": 2 },
				{ "url": "https://spdx.org/licenses/MIT.json", "order": 1 }
			],
			"seeAlso": ["https://opensource.org/licenses/MIT", "https://x.test/dup"]
		});
		let mut requests = Vec::new();
		let done = run("https://spdx.org/licenses/MIT", |request| {
			requests.push(request.url.clone());
			Fetched::json(&license)
		})
		.unwrap();
		assert_eq!(requests, ["https://spdx.org/licenses/MIT.json"]);
		assert_eq!((done.method, done.title.as_deref()), ("spdx-api", Some("MIT License")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# MIT License\n\n**License ID:** `MIT`\n**OSI Approved:** Yes\n**FSF Libre:** Yes\n"
		));
		assert!(md.contains("\n## Description\n\nA permissive license.\n"));
		assert!(md.contains("\n## Cross References\n\n- https://spdx.org/licenses/MIT.json\n- https://x.test/dup\n- https://opensource.org/licenses/MIT\n"));
		assert!(md.contains(
			"\n## License Text\n\n```\nPermission is hereby granted, free of charge.\n```\n"
		));
		assert_eq!(done.notes, ["Fetched via SPDX license API"]);
	}

	#[test]
	fn the_html_text_and_missing_flags_are_handled() {
		let done = run("https://www.spdx.org/licenses/X.html", |request| {
			assert_eq!(request.url, "https://spdx.org/licenses/X.json");
			Fetched::json(
				&json!({ "licenseId": "X", "name": "X License", "licenseTextHtml": "<p>Read <b>me</b>.</p>" }),
			)
		})
		.unwrap();
		assert!(
			done
				.markdown
				.contains("**OSI Approved:** Unknown\n**FSF Libre:** Unknown\n")
		);
		assert!(
			done
				.markdown
				.contains("\n## License Text\n\n```\nRead **me**.\n```\n")
		);
		assert!(!done.markdown.contains("## Description"));
	}

	#[test]
	fn other_paths_and_api_failures_fall_through() {
		for url in [
			"https://spdx.org/licenses/",
			"https://spdx.org/licenses/MIT/extra",
			"https://example.test/licenses/MIT",
		] {
			assert_eq!(run(url, |_| panic!("no fetch expected")), None, "{url}");
		}
		assert_eq!(run("https://spdx.org/licenses/MIT", |_| Fetched::status(404)), None);
	}
}
