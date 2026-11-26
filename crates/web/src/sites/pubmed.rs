//! `PubMed` (`pubmed.ncbi.nlm.nih.gov/<pmid>`,
//! `ncbi.nlm.nih.gov/pubmed/<pmid>`): article metadata, abstract and `MeSH`
//! terms from the NCBI E-utilities.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Fetched, Next, Site, arr_of, fetch, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "pubmed", open };

const METHOD: &str = "pubmed";
const EUTILS: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TEXT_ACCEPT: &str = "text/plain, */*;q=0.8";

fn open(url: &Url, _: &Context) -> Option<Action> {
	let pmid = match url.host_str()? {
		"pubmed.ncbi.nlm.nih.gov" => pmid_of(url.path(), ""),
		"ncbi.nlm.nih.gov" if url.path().starts_with("/pubmed") => pmid_of(url.path(), "/pubmed/"),
		_ => return None,
	}?;

	let summary_url = format!("{EUTILS}/esummary.fcgi?db=pubmed&id={pmid}&retmode=json");
	fetch_retry(
		Fetch::get(summary_url).accept_json(),
		Box::new(move |reply: Fetched, _: &Context| {
			let data = reply.json_value()?;
			let article = data.get("result")?.get(&pmid)?.clone();
			let title = str_of(&article, "title")
				.unwrap_or("PubMed Article")
				.to_owned();

			let abstract_url =
				format!("{EUTILS}/efetch.fcgi?db=pubmed&id={pmid}&rettype=abstract&retmode=text");
			fetch_retry(
				Fetch::get(abstract_url).header("Accept", TEXT_ACCEPT),
				Box::new(move |abstract_reply: Fetched, _: &Context| {
					let mut notes: Vec<String> = Vec::new();
					let abstract_text = abstract_reply
						.body_text()
						.map(|text| text.trim().to_owned());
					if abstract_text.is_some() {
						notes.push("Fetched abstract via NCBI E-utilities".to_owned());
					}

					let mesh_url =
						format!("{EUTILS}/efetch.fcgi?db=pubmed&id={pmid}&rettype=medline&retmode=text");
					fetch(Fetch::get(mesh_url).header("Accept", TEXT_ACCEPT), move |mesh_reply, _| {
						let mesh = mesh_reply
							.body_text()
							.map_or_default(|text| mesh_terms(&text));
						if !mesh.is_empty() {
							notes.push("Fetched MeSH terms via NCBI E-utilities".to_owned());
						}
						if notes.is_empty() {
							notes.push("Fetched via NCBI E-utilities".to_owned());
						}
						let abstract_text = abstract_text.as_deref().filter(|text| !text.is_empty());
						let mut done =
							Done::new(article_markdown(&pmid, &article, abstract_text, &mesh), METHOD)
								.title(title);
						for note in notes {
							done = done.note(note);
						}
						done.finish()
					})
				}),
			)
		}),
	)
}

/// PMID digits: the 10-or-so digits of the first all-digit path segment after
/// `after`.
fn pmid_of(path: &str, after: &str) -> Option<String> {
	let rest = path.strip_prefix(after)?;
	rest
		.split('/')
		.find(|segment| !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit()))
		.map(str::to_owned)
}

fn article_markdown(
	pmid: &str,
	article: &Value,
	abstract_text: Option<&str>,
	mesh: &[String],
) -> String {
	let title = str_of(article, "title").unwrap_or("PubMed Article");
	let mut md = format!("# {title}\n\n");

	let authors: Vec<&str> = arr_of(article, "authors")
		.iter()
		.filter_map(|author| str_of(author, "name"))
		.collect();
	if !authors.is_empty() {
		let _ = writeln!(md, "**Authors:** {}", authors.join(", "));
	}

	if let Some(journal) = str_of(article, "fulljournalname") {
		let _ = write!(md, "**Journal:** {journal}");
		if let Some(date) = str_of(article, "pubdate") {
			let _ = write!(md, " ({date})");
		}
		md.push('\n');
	}

	let mut citation: Vec<String> = Vec::new();
	if let Some(volume) = str_of(article, "volume") {
		citation.push(format!("Vol {volume}"));
	}
	if let Some(issue) = str_of(article, "issue") {
		citation.push(format!("Issue {issue}"));
	}
	if let Some(pages) = str_of(article, "pages") {
		citation.push(format!("pp {pages}"));
	}
	if !citation.is_empty() {
		let _ = writeln!(md, "**Citation:** {}", citation.join(", "));
	}

	let _ = writeln!(md, "**PMID:** {pmid}");
	let (doi, pmcid) = ids(article);
	if let Some(doi) = doi {
		let _ = writeln!(md, "**DOI:** {doi}");
	}
	if let Some(pmcid) = pmcid {
		let _ = writeln!(md, "**PMCID:** {pmcid}");
	}

	md.push_str("\n---\n\n");
	match abstract_text {
		Some(text) => {
			let _ = write!(md, "## Abstract\n\n{text}\n");
		},
		None => md.push_str("## Abstract\n\nNo abstract available.\n"),
	}

	if !mesh.is_empty() {
		md.push_str("\n## MeSH Terms\n\n");
		for term in mesh {
			let _ = writeln!(md, "- {term}");
		}
	}
	md
}

/// DOI and PMCID from `articleids`, with the DOI falling back to `elocationid`.
fn ids(article: &Value) -> (Option<String>, Option<String>) {
	let mut doi = None;
	let mut pmcid = None;
	for id in arr_of(article, "articleids") {
		match str_of(id, "idtype") {
			Some("doi") => doi = str_of(id, "value").map(str::to_owned),
			Some("pmc") => pmcid = str_of(id, "value").map(str::to_owned),
			_ => {},
		}
	}
	if doi.is_none() {
		doi = str_of(article, "elocationid").map(str::to_owned);
	}
	(doi, pmcid)
}

/// `MH  - ` terms of a MEDLINE record.
fn mesh_terms(text: &str) -> Vec<String> {
	text
		.lines()
		.filter_map(|line| {
			line
				.strip_prefix("MH  - ")
				.map(|term| term.trim().to_owned())
		})
		.filter(|term| !term.is_empty())
		.collect()
}

/// One retry on a non-2xx reply, then hand the last reply to `next`.
fn fetch_retry(request: Fetch, next: Next) -> Option<Action> {
	fetch(request.clone(), move |reply, context| {
		if reply.ok() {
			return next(reply, context);
		}
		fetch(request, move |reply, context| next(reply, context))
	})
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn summary() -> serde_json::Value {
		json!({
			"result": {
				"12345678": {
					"title": "A study of things",
					"authors": [{ "name": "Ada Lovelace" }, { "name": "Alan Turing" }],
					"fulljournalname": "Nature",
					"pubdate": "2020 Jan",
					"volume": "10",
					"issue": "2",
					"pages": "1-9",
					"articleids": [
						{ "idtype": "pubmed", "value": "12345678" },
						{ "idtype": "doi", "value": "10.1000/x" },
						{ "idtype": "pmc", "value": "PMC123" }
					]
				}
			}
		})
	}

	fn serve(request: &super::super::Fetch) -> Fetched {
		if request.url.contains("esummary.fcgi") {
			Fetched::json(&summary())
		} else if request.url.contains("rettype=abstract") {
			Fetched::text("text/plain", "  1. Nature. 2020 Jan.\n\nAbstract text here.  ")
		} else if request.url.contains("rettype=medline") {
			Fetched::text("text/plain", "MH  - Humans\nMH  - COVID-19\n")
		} else {
			panic!("unexpected request: {}", request.url)
		}
	}

	#[test]
	fn an_article_renders_metadata_abstract_and_mesh_terms() {
		let mut requests = Vec::new();
		let done = run("https://pubmed.ncbi.nlm.nih.gov/12345678/", |request| {
			requests.push(request.url.clone());
			serve(request)
		})
		.unwrap();
		assert_eq!(requests, [
			"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=12345678&retmode=json",
			"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=12345678&rettype=abstract&retmode=text",
			"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=12345678&rettype=medline&retmode=text"
		]);
		assert_eq!(done.method, "pubmed");
		assert_eq!(done.title.as_deref(), Some("A study of things"));
		assert_eq!(done.notes, [
			"Fetched abstract via NCBI E-utilities",
			"Fetched MeSH terms via NCBI E-utilities"
		]);
		assert_eq!(
			done.markdown,
			"# A study of things\n\n**Authors:** Ada Lovelace, Alan Turing\n**Journal:** Nature \
			 (2020 Jan)\n**Citation:** Vol 10, Issue 2, pp 1-9\n**PMID:** 12345678\n**DOI:** \
			 10.1000/x\n**PMCID:** PMC123\n\n---\n\n## Abstract\n\n1. Nature. 2020 Jan.\n\nAbstract \
			 text here.\n\n## MeSH Terms\n\n- Humans\n- COVID-19\n"
		);
	}

	#[test]
	fn the_legacy_ncbi_url_and_an_abstractless_record_still_render() {
		let done = run("https://ncbi.nlm.nih.gov/pubmed/87654321", |request| {
			if request.url.contains("esummary.fcgi") {
				Fetched::json(&json!({ "result": { "87654321": { "title": "Old paper" } } }))
			} else if request.url.contains("rettype=abstract") {
				Fetched::status(500)
			} else {
				Fetched::text("text/plain", "no terms here\n")
			}
		})
		.unwrap();
		assert!(done.markdown.starts_with(
			"# Old paper\n\n**PMID:** 87654321\n\n---\n\n## Abstract\n\nNo abstract available.\n"
		));
		assert_eq!(done.notes, ["Fetched via NCBI E-utilities"]);
	}

	#[test]
	fn other_pages_and_summary_failures_fall_through() {
		assert_eq!(
			run("https://ncbi.nlm.nih.gov/books/NBK1/", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://pubmed.ncbi.nlm.nih.gov/?term=things", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://pubmed.ncbi.nlm.nih.gov/12345678/", |_| Fetched::status(500)), None);
	}
}
