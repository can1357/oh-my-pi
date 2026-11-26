//! bioRxiv and medRxiv (`biorxiv.org/content/<doi>`): preprint metadata and
//! abstract from the bioRxiv/medRxiv details API in one request.

use std::{fmt::Write as _, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "biorxiv", open };

static DOI: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^/content/(10\.\d{4,}/[^\s?#]+)").unwrap());
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"v\d+$").unwrap());
static FULL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.full(\.pdf)?$").unwrap());

fn open(url: &Url, _: &Context) -> Option<Action> {
	let server = match url.host_str()? {
		"biorxiv.org" | "www.biorxiv.org" => "biorxiv",
		"medrxiv.org" | "www.medrxiv.org" => "medrxiv",
		_ => return None,
	};
	let path = url.path();
	let doi = DOI.captures(path)?.get(1)?.as_str().to_owned();
	let doi = VERSION.replace(&doi, "").into_owned();
	let doi = FULL.replace(&doi, "").into_owned();
	fetch(
		Fetch::get(format!("https://api.{server}.org/details/{server}/{doi}/na/json")).accept_json(),
		move |reply, _| {
			let data = reply.json_value()?;
			let paper = arr_of(&data, "collection").last()?;
			let server_name = if server == "biorxiv" {
				"bioRxiv"
			} else {
				"medRxiv"
			};
			Done::new(markdown(server, server_name, &doi, paper), server)
				.title(str_of(paper, "title").unwrap_or("Untitled Preprint"))
				.note(format!("Fetched via {server_name} API"))
				.finish()
		},
	)
}

fn markdown(server: &str, server_name: &str, doi: &str, paper: &Value) -> String {
	let mut md = format!("# {}\n\n", str_of(paper, "title").unwrap_or("Untitled Preprint"));
	if let Some(authors) = str_of(paper, "authors") {
		let _ = writeln!(md, "**Authors:** {authors}");
	}
	if let Some(corresponding) = str_of(paper, "author_corresponding") {
		let institution = str_of(paper, "author_corresponding_institution")
			.map_or_else(String::new, |name| format!(" ({name})"));
		let _ = writeln!(md, "**Corresponding Author:** {corresponding}{institution}");
	}
	if let Some(date) = str_of(paper, "date") {
		let _ = writeln!(md, "**Posted:** {date}");
	}
	if let Some(category) = str_of(paper, "category") {
		let _ = writeln!(md, "**Category:** {category}");
	}
	if let Some(version) = str_of(paper, "version") {
		let _ = writeln!(md, "**Version:** {version}");
	}
	if let Some(license) = str_of(paper, "license") {
		let _ = writeln!(md, "**License:** {license}");
	}
	let paper_doi = str_of(paper, "biorxiv_doi")
		.or_else(|| str_of(paper, "medrxiv_doi"))
		.unwrap_or(doi);
	let _ = writeln!(md, "**DOI:** [{paper_doi}](https://doi.org/{paper_doi})");
	let _ = writeln!(md, "**Server:** {server_name}");
	if let Some(published) = str_of(paper, "published") {
		let _ =
			write!(md, "\n> **Published in journal:** [{published}](https://doi.org/{published})\n");
	}
	md.push_str("\n---\n\n## Abstract\n\n");
	md.push_str(str_of(paper, "abstract").unwrap_or("No abstract available."));
	md.push('\n');
	md.push_str("\n---\n\n## Links\n\n");
	let _ = writeln!(md, "- [View on {server_name}](https://www.{server}.org/content/{paper_doi})");
	let _ = writeln!(md, "- [PDF](https://www.{server}.org/content/{paper_doi}.full.pdf)");
	if let Some(jatsxml) = str_of(paper, "jatsxml") {
		let _ = writeln!(md, "- [JATS XML]({jatsxml})");
	}
	md
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!({ "collection": [
			{
				"title": "AlphaFold Protein Structure Database", "authors": "Varadi M; Anyango S",
				"author_corresponding": "Mihaly Varadi", "author_corresponding_institution": "EMBL-EBI",
				"abstract": "AlphaFold DB provides open access to protein structure predictions.",
				"date": "2021-10-05", "category": "bioinformatics", "version": "1", "license": "cc_by",
				"jatsxml": "https://www.biorxiv.org/content/10.1101/2021.10.04.463034v1.full.xml",
				"server": "bioRxiv", "biorxiv_doi": "10.1101/2021.10.04.463034", "published": "10.1093/nar/gkac998"
			},
			{ "title": "AlphaFold Protein Structure Database (v2)", "version": "2",
			  "biorxiv_doi": "10.1101/2021.10.04.463034" }
		] })
	}

	#[test]
	fn a_preprint_reads_the_details_api() {
		let mut requests = Vec::new();
		let done = run("https://www.biorxiv.org/content/10.1101/2021.10.04.463034v1", |request| {
			requests.push(request.url.clone());
			Fetched::json(&api())
		})
		.unwrap();
		assert_eq!(requests, [
			"https://api.biorxiv.org/details/biorxiv/10.1101/2021.10.04.463034/na/json"
		]);
		assert_eq!(
			(done.method, done.title.as_deref()),
			("biorxiv", Some("AlphaFold Protein Structure Database (v2)"))
		);
		assert_eq!(done.notes, ["Fetched via bioRxiv API"]);
		let md = &done.markdown;
		assert!(md.starts_with("# AlphaFold Protein Structure Database (v2)\n\n**Version:** 2\n**DOI:** [10.1101/2021.10.04.463034](https://doi.org/10.1101/2021.10.04.463034)\n**Server:** bioRxiv\n\n---\n\n## Abstract\n\nNo abstract available.\n"));
		assert!(md.contains("## Links\n\n- [View on bioRxiv](https://www.biorxiv.org/content/10.1101/2021.10.04.463034)\n- [PDF](https://www.biorxiv.org/content/10.1101/2021.10.04.463034.full.pdf)\n"));
		assert!(!md.contains("JATS XML"));
	}

	#[test]
	fn a_single_version_renders_every_metadata_line() {
		let single = json!({ "collection": [api()["collection"][0].clone()] });
		let done = run("https://biorxiv.org/content/10.1101/2021.10.04.463034.full", |_| {
			Fetched::json(&single)
		})
		.unwrap();
		let md = &done.markdown;
		assert!(md.contains(
			"**Authors:** Varadi M; Anyango S\n**Corresponding Author:** Mihaly Varadi (EMBL-EBI)\n"
		));
		assert!(md.contains(
			"**Posted:** 2021-10-05\n**Category:** bioinformatics\n**Version:** 1\n**License:** \
			 cc_by\n"
		));
		assert!(md.contains("\n> **Published in journal:** [10.1093/nar/gkac998](https://doi.org/10.1093/nar/gkac998)\n"));
		assert!(md.contains(
			"## Abstract\n\nAlphaFold DB provides open access to protein structure predictions.\n"
		));
		assert!(md.contains(
			"- [JATS XML](https://www.biorxiv.org/content/10.1101/2021.10.04.463034v1.full.xml)\n"
		));
	}

	#[test]
	fn medrxiv_urls_use_the_medrxiv_api() {
		let mut requests = Vec::new();
		let done = run("https://www.medrxiv.org/content/10.1101/2021.01.01.21249302v1", |request| {
			requests.push(request.url.clone());
			Fetched::json(&api())
		})
		.unwrap();
		assert_eq!(requests, [
			"https://api.medrxiv.org/details/medrxiv/10.1101/2021.01.01.21249302/na/json"
		]);
		assert_eq!(done.method, "medrxiv");
		assert!(done.markdown.contains("**Server:** medRxiv"));
		assert_eq!(done.notes, ["Fetched via medRxiv API"]);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://www.biorxiv.org/about", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://example.test/content/10.1101/2021.10.04.463034", |_| panic!(
				"no fetch expected"
			)),
			None
		);
		assert_eq!(
			run("https://www.biorxiv.org/content/10.1101/2021.10.04.463034", |_| Fetched::status(404)),
			None
		);
		let empty = json!({ "collection": [] });
		assert_eq!(
			run("https://www.biorxiv.org/content/10.1101/2021.10.04.463034", |_| Fetched::json(
				&empty
			)),
			None
		);
	}
}
