//! Semantic Scholar (`semanticscholar.org/paper/...`). The Graph API answers
//! one paper page in one request; the API's own URLs are left to the reader.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, i64_of, str_of, strs_of,
	u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "semantic-scholar", open };

const METHOD: &str = "semantic-scholar";
/// Fields asked of the Graph API, in the order the handler renders them.
const FIELDS: &str = "title,abstract,authors,year,citationCount,referenceCount,fieldsOfStudy,\
                      publicationTypes,journal,externalIds,tldr,openAccessPdf";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "semanticscholar.org" | "www.semanticscholar.org") {
		return None;
	}
	let id = paper_id(url)?.to_owned();
	let api = format!("https://api.semanticscholar.org/graph/v1/paper/{id}?fields={FIELDS}");
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let paper = reply.json_value()?;
		let title = str_of(&paper, "title").unwrap_or("Untitled").to_owned();
		let markdown = render(&paper, &id);
		Done::new(markdown, METHOD).title(title).finish()
	})
}

/// The 40-hex paper id after the `/paper/` segment of the path.
fn paper_id(url: &Url) -> Option<&str> {
	let mut segments = url.path_segments()?;
	segments.find(|segment| *segment == "paper")?;
	segments
		.find(|segment| segment.len() == 40 && segment.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn render(paper: &Value, fallback_id: &str) -> String {
	let mut out = format!("# {}\n\n", str_of(paper, "title").unwrap_or("Untitled"));

	let authors: Vec<&str> = arr_of(paper, "authors")
		.iter()
		.filter_map(|author| str_of(author, "name"))
		.collect();
	if !authors.is_empty() {
		let _ = write!(out, "**Authors:** {}\n\n", authors.join(", "));
	}

	let mut metadata = Vec::new();
	if let Some(year) = i64_of(paper, "year").filter(|year| *year != 0) {
		metadata.push(format!("Year: {year}"));
	}
	if let Some(venue) = paper
		.get("journal")
		.and_then(|journal| str_of(journal, "name"))
	{
		metadata.push(format!("Venue: {venue}"));
	}
	if let Some(citations) = u64_of(paper, "citationCount") {
		metadata.push(format!("Citations: {}", format_number(citations as f64)));
	}
	if let Some(references) = u64_of(paper, "referenceCount") {
		metadata.push(format!("References: {}", format_number(references as f64)));
	}
	if !metadata.is_empty() {
		let _ = write!(out, "{}\n\n", metadata.join(" • "));
	}

	let fields = strs_of(paper, "fieldsOfStudy");
	if !fields.is_empty() {
		let _ = write!(out, "**Fields:** {}\n\n", fields.join(", "));
	}
	if let Some(tldr) = paper.get("tldr").and_then(|tldr| str_of(tldr, "text")) {
		let _ = write!(out, "## TL;DR\n\n{tldr}\n\n");
	}
	if let Some(abstract_text) = str_of(paper, "abstract") {
		let _ = write!(out, "## Abstract\n\n{abstract_text}\n\n");
	}

	let empty = Value::Null;
	let external = paper.get("externalIds").unwrap_or(&empty);
	let mut links = Vec::new();
	if let Some(pdf) = paper
		.get("openAccessPdf")
		.and_then(|pdf| str_of(pdf, "url"))
	{
		links.push(format!("[PDF]({pdf})"));
	}
	if let Some(arxiv) = str_of(external, "ArXiv") {
		links.push(format!("[arXiv](https://arxiv.org/abs/{arxiv})"));
	}
	if let Some(doi) = str_of(external, "DOI") {
		links.push(format!("[DOI](https://doi.org/{doi})"));
	}
	if let Some(pubmed) = str_of(external, "PubMed") {
		links.push(format!("[PubMed](https://pubmed.ncbi.nlm.nih.gov/{pubmed}/)"));
	}
	let id = str_of(paper, "paperId").unwrap_or(fallback_id);
	links.push(format!("[Semantic Scholar](https://www.semanticscholar.org/paper/{id})"));
	let _ = write!(out, "## Links\n\n{}\n", links.join(" • "));
	out
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		FIELDS,
	};

	const PAPER_ID: &str = "204e3073870fae3d05bcbc2f6a8e263d9b72e776";

	#[test]
	fn a_paper_page_renders_the_graph_api_reply() {
		let paper = json!({
			"paperId": PAPER_ID, "title": "Attention Is All You Need",
			"abstract": "The dominant sequence transduction models are based on complex recurrent networks.",
			"authors": [{ "name": "Ashish Vaswani" }, { "name": "Noam Shazeer" }],
			"year": 2017, "citationCount": 100_000, "referenceCount": 40,
			"fieldsOfStudy": ["Computer Science"], "publicationTypes": ["JournalArticle"],
			"journal": { "name": "NeurIPS", "volume": "30" },
			"externalIds": { "DOI": "10.5555/3295222", "ArXiv": "1706.03762" },
			"tldr": { "text": "A new simple network architecture." },
			"openAccessPdf": { "url": "https://arxiv.org/pdf/1706.03762" }
		});
		let mut requests = Vec::new();
		let done = run(
			"https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
			|request| {
				requests.push(request.url.clone());
				Fetched::json(&paper)
			},
		)
		.unwrap();
		assert_eq!(requests, [format!(
			"https://api.semanticscholar.org/graph/v1/paper/{PAPER_ID}?fields={FIELDS}"
		)]);
		assert_eq!(
			(done.method, done.title.as_deref()),
			("semantic-scholar", Some("Attention Is All You Need"))
		);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Attention Is All You Need\n\n**Authors:** Ashish Vaswani, Noam Shazeer\n\n"
		));
		assert!(md.contains("Year: 2017 • Venue: NeurIPS • Citations: 100K • References: 40\n\n"));
		assert!(md.contains(
			"**Fields:** Computer Science\n\n## TL;DR\n\nA new simple network architecture.\n\n"
		));
		assert!(md.contains(
			"## Abstract\n\nThe dominant sequence transduction models are based on complex recurrent \
			 networks.\n\n"
		));
		assert!(md.contains("## Links\n\n[PDF](https://arxiv.org/pdf/1706.03762) • [arXiv](https://arxiv.org/abs/1706.03762) • [DOI](https://doi.org/10.5555/3295222) • [Semantic Scholar](https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776)\n"));
		assert!(done.notes.is_empty());
	}

	#[test]
	fn a_paper_id_directly_under_paper_is_accepted() {
		let done = run(&format!("https://semanticscholar.org/paper/{PAPER_ID}"), |request| {
			assert!(
				request
					.url
					.ends_with(&format!("/paper/{PAPER_ID}?fields={FIELDS}"))
			);
			Fetched::json(&json!({ "paperId": PAPER_ID, "title": "Bare", "citationCount": 0 }))
		})
		.unwrap();
		assert!(done.markdown.contains("Citations: 0\n\n"));
	}

	#[test]
	fn other_urls_and_api_failures_fall_through() {
		assert_eq!(
			run("https://www.semanticscholar.org/paper/invalid", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run(
				&format!("https://api.semanticscholar.org/graph/v1/paper/{PAPER_ID}?fields=title"),
				|_| panic!("no fetch expected")
			),
			None
		);
		assert_eq!(
			run(&format!("https://www.semanticscholar.org/paper/{PAPER_ID}"), |_| Fetched::status(
				429
			)),
			None
		);
	}
}
