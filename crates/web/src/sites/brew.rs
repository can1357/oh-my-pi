//! Homebrew (`formulae.brew.sh/formula/<name>` and `/cask/<token>`): version,
//! install counts, dependency and caveat lists from the formulae.brew.sh API in
//! one request.

use std::{fmt::Write, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, segment, str_of, strs_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "brew", open };

const METHOD: &str = "brew";
const API: &str = "https://formulae.brew.sh/api";

static FORMULA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/formula/([^/]+)/?$").unwrap());
static CASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/cask/([^/]+)/?$").unwrap());

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "formulae.brew.sh" {
		return None;
	}
	let path = url.path();
	let (kind, name) = match (FORMULA.captures(path), CASK.captures(path)) {
		(Some(formula), _) => ("formula", decode_segment(formula.get(1)?.as_str())),
		(_, Some(cask)) => ("cask", decode_segment(cask.get(1)?.as_str())),
		_ => return None,
	};
	fetch(
		Fetch::get(format!("{API}/{kind}/{}.json", segment(&name))).accept_json(),
		move |reply, _| {
			let item = reply.json_value()?;
			let markdown = if kind == "formula" {
				formula(&item)
			} else {
				cask(&item)
			};
			Done::new(markdown, METHOD)
				.note(format!("Fetched via Homebrew {kind} API"))
				.finish()
		},
	)
}

fn formula(item: &Value) -> String {
	let name = str_of(item, "full_name")
		.or_else(|| str_of(item, "name"))
		.unwrap_or("Formula");
	let mut md = format!("# {name}\n\n");
	if let Some(description) = str_of(item, "desc") {
		let _ = write!(md, "{description}\n\n");
	}

	let stable = item
		.get("versions")
		.and_then(|versions| str_of(versions, "stable"))
		.unwrap_or("unknown");
	let _ = write!(md, "**Version:** {stable}");
	if let Some(license) = str_of(item, "license") {
		let _ = write!(md, " · **License:** {license}");
	}
	md.push('\n');
	if let Some(installs) = install_count(item) {
		let _ = writeln!(md, "**Installs (30d):** {}", format_number(installs));
	}
	let _ =
		write!(md, "\n```bash\nbrew install {}\n```\n\n", str_of(item, "name").unwrap_or_default());
	if let Some(homepage) = str_of(item, "homepage") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}

	bullets(&mut md, "Dependencies", &strs_of(item, "dependencies"));
	bullets(&mut md, "Build Dependencies", &strs_of(item, "build_dependencies"));
	bullets(&mut md, "Conflicts With", &strs_of(item, "conflicts_with"));
	if let Some(caveats) = str_of(item, "caveats") {
		let _ = write!(md, "\n## Caveats\n\n{caveats}\n");
	}
	md
}

fn cask(item: &Value) -> String {
	let token = str_of(item, "token").unwrap_or("Cask");
	let name = arr_of(item, "name")
		.first()
		.and_then(Value::as_str)
		.unwrap_or(token);
	let mut md = format!("# {name}\n\n");
	if let Some(description) = str_of(item, "desc") {
		let _ = write!(md, "{description}\n\n");
	}

	let _ = writeln!(md, "**Version:** {}", str_of(item, "version").unwrap_or("unknown"));
	if let Some(installs) = install_count(item) {
		let _ = writeln!(md, "**Installs (30d):** {}", format_number(installs));
	}
	let _ = write!(md, "\n```bash\nbrew install --cask {token}\n```\n\n");
	if let Some(homepage) = str_of(item, "homepage") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}

	let conflicts = item
		.get("conflicts_with")
		.and_then(|conflicts| conflicts.get("cask"))
		.and_then(Value::as_array)
		.map_or_default(|casks| casks.iter().filter_map(Value::as_str).collect::<Vec<_>>());
	bullets(&mut md, "Conflicts With", &conflicts);
	if let Some(caveats) = str_of(item, "caveats") {
		let _ = write!(md, "\n## Caveats\n\n{caveats}\n");
	}
	md
}

/// A `\n## Heading\n\n` section followed by one bullet per item; nothing when
/// there are no items.
fn bullets(md: &mut String, heading: &str, items: &[&str]) {
	if items.is_empty() {
		return;
	}
	let _ = writeln!(md, "\n## {heading}\n");
	for item in items {
		let _ = writeln!(md, "- {item}");
	}
}

/// Sum of the last 30 days' install counts; `None` without analytics.
fn install_count(item: &Value) -> Option<f64> {
	let counts = item
		.get("analytics")?
		.get("install")?
		.get("30d")?
		.as_object()?;
	Some(counts.values().filter_map(Value::as_f64).sum())
}

/// Percent-decode one URL path segment (`decodeURIComponent`).
fn decode_segment(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%'
			&& i + 2 < bytes.len()
			&& bytes[i + 1].is_ascii_hexdigit()
			&& bytes[i + 2].is_ascii_hexdigit()
		{
			out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap_or(bytes[i]));
			i += 3;
		} else {
			out.push(bytes[i]);
			i += 1;
		}
	}
	String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_formula_page_renders_the_api_response() {
		let formula = json!({
			"name": "wget", "full_name": "wget", "desc": "Internet file retriever",
			"homepage": "https://www.gnu.org/software/wget/", "license": "GPL-3.0-or-later",
			"versions": { "stable": "1.24.5", "head": null, "bottle": true },
			"dependencies": ["libidn2", "openssl@3"], "build_dependencies": ["pkg-config"],
			"conflicts_with": ["wget2"], "caveats": "The first `brew install` may take a while.",
			"analytics": { "install": { "30d": { "wget": 1_200_000, "wget--HEAD": 300 } } }
		});
		let mut requests = Vec::new();
		let done = run("https://formulae.brew.sh/formula/wget", |request| {
			requests.push(request.url.clone());
			Fetched::json(&formula)
		})
		.unwrap();
		assert_eq!(requests, ["https://formulae.brew.sh/api/formula/wget.json"]);
		assert_eq!(done.method, "brew");
		assert_eq!(done.notes, ["Fetched via Homebrew formula API"]);
		let md = &done.markdown;
		assert!(md.starts_with("# wget\n\nInternet file retriever\n\n**Version:** 1.24.5 · **License:** GPL-3.0-or-later\n**Installs (30d):** 1.2M\n\n```bash\nbrew install wget\n```\n\n**Homepage:** https://www.gnu.org/software/wget/\n"));
		assert!(md.contains("\n## Dependencies\n\n- libidn2\n- openssl@3\n"));
		assert!(md.contains("\n## Build Dependencies\n\n- pkg-config\n"));
		assert!(md.contains("\n## Conflicts With\n\n- wget2\n"));
		assert!(md.contains("\n## Caveats\n\nThe first `brew install` may take a while.\n"));
	}

	#[test]
	fn a_cask_page_renders_its_conflicts_and_caveats() {
		let cask = json!({
			"token": "firefox", "name": ["Mozilla Firefox"], "desc": "Web browser",
			"homepage": "https://www.mozilla.org/firefox/", "version": "132.0", "sha256": "abc",
			"caveats": "Requires a manual update.", "depends_on": { "macos": {} },
			"conflicts_with": { "cask": ["firefox-esr"] },
			"analytics": { "install": { "30d": { "firefox": 2_000_000 } } }
		});
		let done = run("https://formulae.brew.sh/cask/firefox", |_| Fetched::json(&cask)).unwrap();
		assert_eq!(done.notes, ["Fetched via Homebrew cask API"]);
		let md = &done.markdown;
		assert!(md.starts_with("# Mozilla Firefox\n\nWeb browser\n\n**Version:** 132.0\n**Installs (30d):** 2M\n\n```bash\nbrew install --cask firefox\n```\n\n**Homepage:** https://www.mozilla.org/firefox/\n"));
		assert!(md.contains("\n## Conflicts With\n\n- firefox-esr\n"));
		assert!(md.contains("\n## Caveats\n\nRequires a manual update.\n"));
	}

	#[test]
	fn an_encoded_name_is_decoded_before_the_api_lookup() {
		let mut requests = Vec::new();
		let _ = run("https://formulae.brew.sh/formula/foo%40bar", |request| {
			requests.push(request.url.clone());
			Fetched::json(&json!({ "name": "foo@bar" }))
		});
		assert_eq!(requests, ["https://formulae.brew.sh/api/formula/foo%40bar.json"]);
	}

	#[test]
	fn missing_metadata_is_left_out() {
		let done =
			run("https://formulae.brew.sh/cask/tiny", |_| Fetched::json(&json!({ "token": "tiny" })))
				.unwrap();
		let md = &done.markdown;
		assert!(md.starts_with(
			"# tiny\n\n**Version:** unknown\n\n```bash\nbrew install --cask tiny\n```\n"
		));
		assert!(!md.contains("Installs"));
		assert!(!md.contains("Homepage"));
		assert!(!md.contains("Caveats"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://formulae.brew.sh/formula/wget/1.24", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://formulae.brew.sh/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/formula/wget", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://formulae.brew.sh/formula/wget", |_| Fetched::status(404)), None);
	}
}
