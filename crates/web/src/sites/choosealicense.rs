//! Choose a License (`choosealicense.com/licenses/<slug>` and `/appendix`):
//! the license's YAML front matter (title, SPDX id, permissions, conditions,
//! limitations) plus its full text, from the site's own raw files.

use std::fmt::Write as _;

use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch};

/// Registry entry.
pub const SITE: Site = Site { name: "choosealicense", open };

const METHOD: &str = "choosealicense";
const RAW: &str = "https://raw.githubusercontent.com/github/choosealicense.com/gh-pages";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "choosealicense.com" | "www.choosealicense.com") {
		return None;
	}
	let path = url.path();
	let license = license_slug(path);
	let is_appendix = license.is_none()
		&& path
			.strip_suffix('/')
			.unwrap_or(path)
			.eq_ignore_ascii_case("/appendix");
	if license.is_none() && !is_appendix {
		return None;
	}
	let slug =
		license.map_or_else(|| "appendix".to_owned(), |slug| percent_decode(slug).to_lowercase());
	let is_license = license.is_some();
	let raw = if is_license {
		format!("{RAW}/_licenses/{slug}.txt")
	} else {
		format!("{RAW}/_pages/appendix.md")
	};

	fetch(Fetch::get(raw).header("Accept", "text/plain"), move |reply, _| {
		let content = reply.body_text()?;
		let (frontmatter, body) = parse_frontmatter(&content);
		let title = frontmatter.title.unwrap_or_else(|| format_label(&slug));
		let spdx_id = frontmatter.spdx_id.unwrap_or_else(|| "Unknown".to_owned());
		let source = if is_license {
			format!("/licenses/{slug}/")
		} else {
			"/appendix".to_owned()
		};

		let mut md = format!("# {title}\n\n");
		if let Some(description) = frontmatter.description.as_deref() {
			let _ = write!(md, "{description}\n\n");
		}
		let _ = writeln!(md, "**SPDX ID:** {spdx_id}");
		let _ = write!(md, "**Source:** https://choosealicense.com{source}\n\n");
		section(&mut md, "Permissions", &frontmatter.permissions);
		section(&mut md, "Conditions", &frontmatter.conditions);
		section(&mut md, "Limitations", &frontmatter.limitations);
		let text = body.trim();
		if !text.is_empty() {
			let _ = write!(md, "---\n\n## License Text\n\n{text}\n");
		}
		Done::new(md, METHOD)
			.title(title)
			.note("Fetched via Choose a License")
			.finish()
	})
}

/// `^\/licenses\/([^/]+)\/?$`: the still-encoded slug of a license page.
fn license_slug(path: &str) -> Option<&str> {
	let rest = path.strip_suffix('/').unwrap_or(path).strip_prefix('/')?;
	let (prefix, slug) = rest.split_once('/')?;
	(prefix.eq_ignore_ascii_case("licenses") && !slug.is_empty() && !slug.contains('/'))
		.then_some(slug)
}

#[derive(Default)]
struct Frontmatter {
	title:       Option<String>,
	spdx_id:     Option<String>,
	description: Option<String>,
	permissions: Vec<String>,
	conditions:  Vec<String>,
	limitations: Vec<String>,
}

/// Split a `---`-delimited front matter off `content`; no front matter leaves
/// the whole content as the body.
fn parse_frontmatter(content: &str) -> (Frontmatter, String) {
	let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
	let mut frontmatter = Frontmatter::default();
	let Some(rest) = normalized.strip_prefix("---") else {
		return (frontmatter, normalized.trim().to_owned());
	};
	let (metadata, body) = if let Some(end) = rest.find("\n---\n") {
		(&rest[..end], rest[end + 5..].trim().to_owned())
	} else if let Some(metadata) = rest.strip_suffix("\n---") {
		(metadata, String::new())
	} else {
		return (frontmatter, normalized.trim().to_owned());
	};
	let mut key: Option<String> = None;
	for line in metadata.lines() {
		let line = line.trim();
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		if let Some(item) = line.strip_prefix("- ") {
			let item = item.trim();
			let list = match key.as_deref() {
				Some("permissions") => &mut frontmatter.permissions,
				Some("conditions") => &mut frontmatter.conditions,
				Some("limitations") => &mut frontmatter.limitations,
				_ => continue,
			};
			if !item.is_empty() {
				list.push(item.to_owned());
			}
			continue;
		}
		let Some((name, value)) = line.split_once(':') else {
			continue;
		};
		let name = name.trim();
		let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
		key = Some(name.to_owned());
		match name {
			"title" => frontmatter.title = non_empty(value),
			"spdx-id" | "spdxId" => frontmatter.spdx_id = non_empty(value),
			"description" => frontmatter.description = non_empty(value),
			"permissions" => frontmatter.permissions = split_list(value),
			"conditions" => frontmatter.conditions = split_list(value),
			"limitations" => frontmatter.limitations = split_list(value),
			_ => {},
		}
	}
	(frontmatter, body)
}

fn non_empty(value: &str) -> Option<String> {
	(!value.is_empty()).then(|| value.to_owned())
}

/// A comma-separated (or bracket-flow) inline list.
fn split_list(value: &str) -> Vec<String> {
	let value = value
		.strip_prefix('[')
		.and_then(|rest| rest.strip_suffix(']'))
		.unwrap_or(value);
	value
		.split(',')
		.map(str::trim)
		.filter(|item| !item.is_empty())
		.map(str::to_owned)
		.collect()
}

/// `formatLabel`: slug-ish text to a human label.
fn format_label(value: &str) -> String {
	let mut cleaned = String::with_capacity(value.len());
	let mut spaced = false;
	for ch in value.chars() {
		if ch == '-' || ch == '_' || ch.is_whitespace() {
			if !spaced {
				cleaned.push(' ');
				spaced = true;
			}
		} else {
			cleaned.push(ch);
			spaced = false;
		}
	}
	let cleaned = cleaned.trim();
	if cleaned.is_empty() {
		return value.to_owned();
	}
	let mut chars = cleaned.chars();
	let first = chars.next().unwrap_or_default().to_uppercase();
	first.chain(chars).collect()
}

fn section(out: &mut String, title: &str, items: &[String]) {
	let _ = write!(out, "## {title}\n\n");
	if items.is_empty() {
		out.push_str("- None listed\n\n");
		return;
	}
	for item in items {
		let _ = writeln!(out, "- {}", format_label(item));
	}
	out.push('\n');
}

/// `decodeURIComponent` of a percent-encoded path; invalid escapes pass
/// through.
fn percent_decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& index + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
		{
			out.push(high * 16 + low);
			index += 3;
			continue;
		}
		out.push(bytes[index]);
		index += 1;
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
	use super::super::{Fetched, testing::run};

	const MIT: &str = concat!(
		"---\ntitle: MIT License\nspdx-id: MIT\nfeatured: true\n\n",
		"description: A short and simple permissive license.\n\n",
		"using:\n  Babel: https://github.com/babel/babel/blob/master/LICENSE\n\n",
		"permissions:\n  - commercial-use\n  - modifications\n\nconditions:\n  - \
		 include-copyright\n\n",
		"limitations:\n  - liability\n  - warranty\n\n---\n",
		"MIT License\n\nCopyright (c) [year] [fullname]\n\nPermission is hereby granted...\n"
	);

	#[test]
	fn a_license_page_reads_the_raw_license_and_its_metadata() {
		let mut requests = Vec::new();
		let done = run("https://choosealicense.com/licenses/mit/", |request| {
			requests.push(request.url.clone());
			Fetched::text("text/plain", MIT)
		})
		.unwrap();
		assert_eq!(requests, [
			"https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_licenses/mit.txt"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("choosealicense", Some("MIT License")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# MIT License\n\nA short and simple permissive license.\n\n**SPDX ID:** MIT\n**Source:** https://choosealicense.com/licenses/mit/\n\n"
		));
		assert!(md.contains("## Permissions\n\n- Commercial use\n- Modifications\n\n"));
		assert!(md.contains("## Conditions\n\n- Include copyright\n\n"));
		assert!(md.contains("## Limitations\n\n- Liability\n- Warranty\n\n"));
		assert!(md.ends_with(
			"---\n\n## License Text\n\nMIT License\n\nCopyright (c) [year] [fullname]\n\nPermission \
			 is hereby granted...\n"
		));
	}

	#[test]
	fn a_page_without_front_matter_gets_placeholder_sections() {
		let done = run("https://www.choosealicense.com/appendix/", |request| {
			assert_eq!(request.url, "https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_pages/appendix.md");
			Fetched::text("text/plain", "# Appendix\n\nSome prose.\n")
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("Appendix"));
		assert_eq!(
			done.markdown,
			"# Appendix\n\n**SPDX ID:** Unknown\n**Source:** https://choosealicense.com/appendix\n\n## Permissions\n\n- None listed\n\n## Conditions\n\n- None listed\n\n## Limitations\n\n- None listed\n\n---\n\n## License Text\n\n# Appendix\n\nSome prose.\n"
		);
	}

	#[test]
	fn other_hosts_other_paths_and_failures_fall_through() {
		assert_eq!(run("https://choosealicense.com/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.com/licenses/mit", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://choosealicense.com/licenses/mit", |_| Fetched::status(404)), None);
	}
}
