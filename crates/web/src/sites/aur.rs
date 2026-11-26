//! AUR (`aur.archlinux.org/packages/<name>`): package metadata, dependencies
//! and install instructions from the AUR RPC API in one request.

use std::{fmt::Write, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, segment, str_of,
	strs_of, u64_of, unix_date,
};

/// Registry entry.
pub const SITE: Site = Site { name: "aur", open };

const METHOD: &str = "aur";
const API: &str = "https://aur.archlinux.org/rpc/?v=5&type=info&arg=";

static PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/packages/([^/?#]+)").unwrap());

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "aur.archlinux.org" {
		return None;
	}
	let name = decode_segment(PATH.captures(url.path())?.get(1)?.as_str());
	fetch(Fetch::get(format!("{API}{}", segment(&name))).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		if u64_of(&data, "resultcount").unwrap_or(0) == 0 {
			return None;
		}
		let package = arr_of(&data, "results").first()?;
		Done::new(markdown(package), METHOD)
			.title(str_of(package, "Name").unwrap_or(&name))
			.note("Fetched via AUR RPC API")
			.finish()
	})
}

fn markdown(package: &Value) -> String {
	let name = str_of(package, "Name").unwrap_or("Unknown");
	let mut md = format!("# {name}\n\n");
	if let Some(description) = str_of(package, "Description") {
		let _ = write!(md, "{description}\n\n");
	}

	let _ = write!(md, "**Version:** {}", str_of(package, "Version").unwrap_or("unknown"));
	if let Some(out_of_date) = u64_of(package, "OutOfDate").filter(|date| *date > 0) {
		let _ = write!(md, " (flagged out-of-date: {})", unix_date(out_of_date as i64));
	}
	md.push('\n');

	if let Some(maintainer) = str_of(package, "Maintainer") {
		let _ = writeln!(
			md,
			"**Maintainer:** [{maintainer}](https://aur.archlinux.org/account/{maintainer})"
		);
	} else {
		md.push_str("**Maintainer:** Orphaned\n");
	}

	let _ = writeln!(
		md,
		"**Votes:** {} · **Popularity:** {:.2}",
		format_number(u64_of(package, "NumVotes").unwrap_or(0) as f64),
		f64_of(package, "Popularity").unwrap_or(0.0)
	);

	let _ = writeln!(
		md,
		"**Last Updated:** {} · **First Submitted:** {}",
		u64_of(package, "LastModified")
			.map_or_else(|| "unknown".to_owned(), |date| unix_date(date as i64)),
		u64_of(package, "FirstSubmitted")
			.map_or_else(|| "unknown".to_owned(), |date| unix_date(date as i64))
	);

	let licenses = strs_of(package, "License");
	if !licenses.is_empty() {
		let _ = writeln!(md, "**License:** {}", licenses.join(", "));
	}
	if let Some(url) = str_of(package, "URL") {
		let _ = writeln!(md, "**Upstream:** {url}");
	}
	let keywords = strs_of(package, "Keywords");
	if !keywords.is_empty() {
		let _ = writeln!(md, "**Keywords:** {}", keywords.join(", "));
	}

	let dependencies = strs_of(package, "Depends");
	if !dependencies.is_empty() {
		let _ = write!(md, "\n## Dependencies ({})\n\n", dependencies.len());
		for dependency in dependencies {
			let _ = writeln!(md, "- {dependency}");
		}
	}
	let make = strs_of(package, "MakeDepends");
	if !make.is_empty() {
		let _ = write!(md, "\n## Make Dependencies ({})\n\n", make.len());
		for dependency in make {
			let _ = writeln!(md, "- {dependency}");
		}
	}
	for (key, heading) in [
		("OptDepends", "Optional Dependencies"),
		("CheckDepends", "Check Dependencies"),
		("Provides", "Provides"),
		("Conflicts", "Conflicts"),
		("Replaces", "Replaces"),
	] {
		let items = strs_of(package, key);
		if !items.is_empty() {
			let _ = write!(md, "\n## {heading}\n\n");
			for item in items {
				let _ = writeln!(md, "- {item}");
			}
		}
	}

	let base = str_of(package, "PackageBase").unwrap_or(name);
	md.push_str("\n---\n\n## Installation\n\n```bash\n");
	md.push_str("# Using an AUR helper (e.g., yay, paru)\n");
	let _ = write!(md, "yay -S {name}\n\n# Manual installation\n");
	let _ =
		write!(md, "git clone https://aur.archlinux.org/{base}.git\ncd {base}\nmakepkg -si\n```\n");
	md
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

	fn api(out_of_date: serde_json::Value, maintainer: serde_json::Value) -> serde_json::Value {
		json!({
			"version": 5, "type": "multiinfo", "resultcount": 1, "results": [{
				"Name": "yay", "Version": "12.3.5", "Description": "Yet another yogurt. Pacman wrapper.",
				"Maintainer": maintainer, "NumVotes": 2345, "Popularity": 25.678,
				"Depends": ["git", "pacman"], "MakeDepends": ["go"], "OptDepends": ["sudo: privilege escalation"],
				"LastModified": 1_700_000_000, "FirstSubmitted": 1_500_000_000,
				"URL": "https://github.com/Jguer/yay", "PackageBase": "yay",
				"License": ["GPL-3.0-only"], "Keywords": ["aur", "helper"], "Provides": ["yay-bin"],
				"Conflicts": ["yay-git"], "OutOfDate": out_of_date
			}]
		})
	}

	#[test]
	fn a_package_page_renders_the_rpc_response() {
		let mut requests = Vec::new();
		let done = run("https://aur.archlinux.org/packages/yay", |request| {
			requests.push(request.url.clone());
			Fetched::json(&api(serde_json::Value::Null, json!("jguer")))
		})
		.unwrap();
		assert_eq!(requests, ["https://aur.archlinux.org/rpc/?v=5&type=info&arg=yay"]);
		assert_eq!((done.method, done.title.as_deref()), ("aur", Some("yay")));
		assert_eq!(done.notes, ["Fetched via AUR RPC API"]);
		let md = &done.markdown;
		assert!(md.starts_with("# yay\n\nYet another yogurt. Pacman wrapper.\n\n**Version:** 12.3.5\n**Maintainer:** [jguer](https://aur.archlinux.org/account/jguer)\n"));
		assert!(md.contains("**Votes:** 2.3K · **Popularity:** 25.68\n"));
		assert!(md.contains("**Last Updated:** 2023-11-14 · **First Submitted:** 2017-07-14\n"));
		assert!(md.contains(
			"**License:** GPL-3.0-only\n**Upstream:** https://github.com/Jguer/yay\n**Keywords:** \
			 aur, helper\n"
		));
		assert!(md.contains("## Dependencies (2)\n\n- git\n- pacman\n"));
		assert!(md.contains("## Make Dependencies (1)\n\n- go\n"));
		assert!(md.contains("## Optional Dependencies\n\n- sudo: privilege escalation\n"));
		assert!(md.contains("## Provides\n\n- yay-bin\n\n## Conflicts\n\n- yay-git\n"));
		assert!(!md.contains("## Replaces"));
		assert!(md.contains("---\n\n## Installation\n\n```bash\n# Using an AUR helper (e.g., yay, paru)\nyay -S yay\n\n# Manual installation\ngit clone https://aur.archlinux.org/yay.git\ncd yay\nmakepkg -si\n```\n"));
	}

	#[test]
	fn an_orphaned_flagged_package_says_so() {
		let done = run("https://aur.archlinux.org/packages/yay", |_| {
			Fetched::json(&api(json!(1_700_000_000), serde_json::Value::Null))
		})
		.unwrap();
		assert!(
			done
				.markdown
				.contains("**Version:** 12.3.5 (flagged out-of-date: 2023-11-14)\n")
		);
		assert!(done.markdown.contains("**Maintainer:** Orphaned\n"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://aur.archlinux.org/rpc/?v=5&type=search&arg=yay", |_| panic!(
				"no fetch expected"
			)),
			None
		);
		assert_eq!(run("https://example.test/packages/yay", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://aur.archlinux.org/packages/yay", |_| Fetched::status(500)), None);
		let empty = json!({ "version": 5, "type": "multiinfo", "resultcount": 0, "results": [] });
		assert_eq!(run("https://aur.archlinux.org/packages/nope", |_| Fetched::json(&empty)), None);
	}
}
