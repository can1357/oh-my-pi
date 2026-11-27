//! Chocolatey (`community.chocolatey.org/packages/<name>[/<version>]`): package
//! metadata from the `NuGet` v2 `OData` endpoint, which answers JSON when asked
//! for it and Atom XML otherwise.

use std::fmt::Write as _;

use url::Url;

use super::{
	Action, Context, Done, Fetch, Fetched, Site, arr_of, fetch, format_number, iso_date, segment,
	str_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "chocolatey", open };

const METHOD: &str = "chocolatey";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("chocolatey.org") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "packages" {
		return None;
	}
	let name = segments.next().filter(|name| !name.is_empty())?.to_owned();
	let version = segments
		.next()
		.filter(|version| !version.is_empty())
		.map(str::to_owned);

	let filter = format!("Id%20eq%20'{}'", segment(&name));
	let query = match &version {
		Some(version) => format!("$filter={filter}%20and%20Version%20eq%20'{}'", segment(version)),
		None => format!("$filter={filter}&$orderby=Version%20desc&$top=1"),
	};
	let api = format!("https://community.chocolatey.org/api/v2/Packages()?{query}");

	let request = Fetch::get(api).header("Accept", "application/atom+xml, application/xml");
	fetch(request, move |reply, _| {
		if !reply.ok() {
			return None;
		}
		let package = json_package(&reply).or_else(|| xml_package(&reply))?;
		let title = package.title.clone().unwrap_or_else(|| package.id.clone());
		Done::new(markdown(&package, &name), METHOD)
			.title(title)
			.note("Fetched via Chocolatey NuGet API")
			.finish()
	})
}

/// Package fields the `OData` entry (JSON or XML) may carry.
#[derive(Default)]
struct Package {
	id:                     String,
	version:                String,
	title:                  Option<String>,
	description:            Option<String>,
	summary:                Option<String>,
	authors:                Option<String>,
	project_url:            Option<String>,
	source_url:             Option<String>,
	tags:                   Option<String>,
	download_count:         Option<u64>,
	version_download_count: Option<u64>,
	published:              Option<String>,
	license_url:            Option<String>,
	release_notes:          Option<String>,
	dependencies:           Option<String>,
}

fn json_package(reply: &Fetched) -> Option<Package> {
	let data = reply.json_value()?;
	let entry = arr_of(data.get("d")?, "results").first()?;
	Some(Package {
		id:                     str_of(entry, "Id").unwrap_or_default().to_owned(),
		version:                str_of(entry, "Version").unwrap_or_default().to_owned(),
		title:                  str_of(entry, "Title").map(str::to_owned),
		description:            str_of(entry, "Description").map(str::to_owned),
		summary:                str_of(entry, "Summary").map(str::to_owned),
		authors:                str_of(entry, "Authors").map(str::to_owned),
		project_url:            str_of(entry, "ProjectUrl").map(str::to_owned),
		source_url:             str_of(entry, "PackageSourceUrl").map(str::to_owned),
		tags:                   str_of(entry, "Tags").map(str::to_owned),
		download_count:         u64_of(entry, "DownloadCount"),
		version_download_count: u64_of(entry, "VersionDownloadCount"),
		published:              str_of(entry, "Published").map(str::to_owned),
		license_url:            str_of(entry, "LicenseUrl").map(str::to_owned),
		release_notes:          str_of(entry, "ReleaseNotes").map(str::to_owned),
		dependencies:           str_of(entry, "Dependencies").map(str::to_owned),
	})
}

fn xml_package(reply: &Fetched) -> Option<Package> {
	let xml = reply.body_text()?;
	let id = xml_field(&xml, "Id")?;
	Some(Package {
		id,
		version: xml_field(&xml, "Version").unwrap_or_default(),
		title: xml_field(&xml, "Title"),
		description: xml_field(&xml, "Description"),
		summary: xml_field(&xml, "Summary"),
		authors: xml_field(&xml, "Authors"),
		project_url: xml_field(&xml, "ProjectUrl"),
		source_url: xml_field(&xml, "PackageSourceUrl"),
		tags: xml_field(&xml, "Tags"),
		download_count: xml_field(&xml, "DownloadCount").and_then(|value| value.parse().ok()),
		version_download_count: xml_field(&xml, "VersionDownloadCount")
			.and_then(|value| value.parse().ok()),
		published: xml_field(&xml, "Published"),
		license_url: xml_field(&xml, "LicenseUrl"),
		release_notes: xml_field(&xml, "ReleaseNotes"),
		dependencies: xml_field(&xml, "Dependencies"),
	})
}

/// First `<d:field ...>value</d:field>` of an `OData` Atom reply
/// (case-insensitive).
fn xml_field(xml: &str, field: &str) -> Option<String> {
	let lower = xml.to_ascii_lowercase();
	let field = field.to_ascii_lowercase();
	let open = format!("<d:{field}");
	let close = format!("</d:{field}>");
	let mut search = 0;
	while let Some(offset) = lower[search..].find(&open) {
		let after_open = search + offset + open.len();
		search = after_open;
		let Some(tag_end) = lower[after_open..].find('>') else {
			continue;
		};
		let start = after_open + tag_end + 1;
		let Some(end) = lower[start..].find(&close) else {
			continue;
		};
		if let Some(value) = xml
			.get(start..start + end)
			.map(str::trim)
			.filter(|value| !value.is_empty())
		{
			return Some(value.to_owned());
		}
		search = start;
	}
	None
}

fn markdown(package: &Package, name: &str) -> String {
	let mut md = format!("# {}\n\n", package.title.as_deref().unwrap_or(&package.id));
	if let Some(summary) = package.summary.as_deref() {
		let _ = write!(md, "{summary}\n\n");
	} else if let Some(description) = package.description.as_deref() {
		let _ = write!(md, "{}\n\n", description.split("\n\n").next().unwrap_or(description));
	}

	let _ = write!(md, "**Version:** {}", package.version);
	if let Some(authors) = package.authors.as_deref() {
		let _ = write!(md, " · **Authors:** {authors}");
	}
	md.push('\n');

	if let Some(downloads) = package.download_count {
		let _ = write!(md, "**Total Downloads:** {}", format_number(downloads as f64));
		if let Some(version_downloads) = package.version_download_count {
			let _ =
				write!(md, " · **Version Downloads:** {}", format_number(version_downloads as f64));
		}
		md.push('\n');
	}
	if let Some(date) = package.published.as_deref().and_then(iso_date) {
		let _ = writeln!(md, "**Published:** {date}");
	}
	md.push('\n');

	for (label, value) in [
		("Project URL", &package.project_url),
		("Source", &package.source_url),
		("License", &package.license_url),
	] {
		if let Some(value) = value.as_deref() {
			let _ = writeln!(md, "**{label}:** {value}");
		}
	}
	if let Some(tags) = package.tags.as_deref() {
		let tags: Vec<&str> = tags.split_whitespace().collect();
		if !tags.is_empty() {
			let _ = writeln!(md, "**Tags:** {}", tags.join(", "));
		}
	}

	if let Some(description) = package.description.as_deref()
		&& Some(description) != package.summary.as_deref()
	{
		let _ = write!(md, "\n## Description\n\n{description}\n");
	}
	if let Some(notes) = package.release_notes.as_deref() {
		let _ = write!(md, "\n## Release Notes\n\n{notes}\n");
	}

	let dependencies: Vec<&str> = package
		.dependencies
		.as_deref()
		.unwrap_or_default()
		.split('|')
		.filter(|dependency| !dependency.trim().is_empty())
		.collect();
	if !dependencies.is_empty() {
		md.push_str("\n## Dependencies\n\n");
		for dependency in dependencies {
			let mut parts = dependency.split(':');
			let id = parts.next().unwrap_or_default();
			match parts.next() {
				Some(version) => {
					let _ = writeln!(md, "- {id}: {version}");
				},
				None => {
					let _ = writeln!(md, "- {id}");
				},
			}
		}
	}

	let _ = write!(md, "\n---\n**Install:** `choco install {name}`\n");
	md
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_package_page_renders_the_json_odata_entry() {
		let entry = json!({ "d": { "results": [{
			"Id": "git", "Version": "2.45.1", "Title": "Git", "Summary": "Distributed version control",
			"Authors": "The Git Development Community", "ProjectUrl": "https://git-scm.com/",
			"PackageSourceUrl": "https://github.com/chocolatey-community/chocolatey-packages",
			"Tags": "git  vcs", "DownloadCount": 12_345_678, "VersionDownloadCount": 1_234,
			"Published": "2024-04-30T12:00:00Z", "LicenseUrl": "https://git-scm.com/about/free-and-open-source",
			"ReleaseNotes": "Security fixes", "Dependencies": "chocolatey-core.extension:1.4.0|git.install:2.45.1",
			"Description": "Git is a distributed version control system.\n\nA longer second paragraph."
		}] } });
		let mut requests = Vec::new();
		let done = run("https://community.chocolatey.org/packages/git", |request| {
			requests.push(request.url.clone());
			Fetched::json(&entry)
		})
		.unwrap();
		assert_eq!(
			requests,
			["https://community.chocolatey.org/api/v2/Packages()?$filter=Id%20eq%20'git'&$orderby=Version%20desc&$top=1"]
		);
		assert_eq!((done.method, done.title.as_deref()), ("chocolatey", Some("Git")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Git\n\nDistributed version control\n\n**Version:** 2.45.1 · **Authors:** The Git \
			 Development Community\n**Total Downloads:** 12M · **Version Downloads:** \
			 1.2K\n**Published:** 2024-04-30\n\n"
		));
		assert!(md.contains(
			"**Project URL:** https://git-scm.com/\n**Source:** https://github.com/chocolatey-community/chocolatey-packages\n**License:** https://git-scm.com/about/free-and-open-source\n"
		));
		assert!(md.contains("**Tags:** git, vcs\n"));
		assert!(md.contains(
			"\n## Description\n\nGit is a distributed version control system.\n\nA longer second \
			 paragraph.\n"
		));
		assert!(md.contains("\n## Release Notes\n\nSecurity fixes\n"));
		assert!(md.contains(
			"\n## Dependencies\n\n- chocolatey-core.extension: 1.4.0\n- git.install: 2.45.1\n"
		));
		assert!(md.ends_with("\n---\n**Install:** `choco install git`\n"));
	}

	#[test]
	fn the_atom_xml_reply_is_parsed_when_the_api_answers_xml() {
		let xml = concat!(
			r#"<feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">"#,
			r#"<entry><content><m:properties><d:Id>git</d:Id><d:Version>2.44.0</d:Version>"#,
			r#"<d:Description>Git for Windows</d:Description>"#,
			r#"<d:Dependencies>git.install:2.44.0</d:Dependencies></m:properties></content></entry></feed>"#
		);
		let done = run("https://community.chocolatey.org/packages/git/2.44.0", |request| {
			assert_eq!(
				request.url,
				"https://community.chocolatey.org/api/v2/Packages()?$filter=Id%20eq%20'git'%20and%20Version%20eq%20'2.44.0'"
			);
			Fetched::text("application/atom+xml", xml)
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("git"));
		assert!(
			done
				.markdown
				.starts_with("# git\n\nGit for Windows\n\n**Version:** 2.44.0\n")
		);
		assert!(
			done
				.markdown
				.contains("\n## Dependencies\n\n- git.install: 2.44.0\n")
		);
	}

	#[test]
	fn other_hosts_other_paths_and_failures_fall_through() {
		assert_eq!(run("https://example.com/packages/git", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://community.chocolatey.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://community.chocolatey.org/packages/git", |_| Fetched::status(503)),
			None
		);
		assert_eq!(
			run("https://community.chocolatey.org/packages/git", |_| Fetched::text(
				"application/atom+xml",
				"<feed/>"
			)),
			None
		);
	}
}
