//! Stack Exchange network (`stackoverflow.com`, `superuser.com`,
//! `*.stackexchange.com`, ...). The question and its answers come from the
//! Stack Exchange API in two requests.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, html_to_markdown, i64_of, str_of, strs_of,
	u64_of, unix_date,
};

/// Registry entry.
pub const SITE: Site = Site { name: "stackoverflow", open };

const METHOD: &str = "stackexchange";
/// Answers rendered under the question.
const MAX_ANSWERS: usize = 5;

/// Standalone Stack Exchange sites (not `*.stackexchange.com` subdomains).
const STANDALONE: &[(&str, &str)] = &[
	("stackoverflow.com", "stackoverflow"),
	("superuser.com", "superuser"),
	("serverfault.com", "serverfault"),
	("askubuntu.com", "askubuntu"),
	("mathoverflow.net", "mathoverflow"),
	("stackapps.com", "stackapps"),
];

fn open(url: &Url, _: &Context) -> Option<Action> {
	let site = site_param(url.host_str()?)?;
	let id = question_id(url.path())?.to_owned();
	let api = format!("https://api.stackexchange.com/2.3/questions/{id}?order=desc&sort=votes&site={site}&filter=withbody");
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let question = arr_of(&data, "items").first()?;
		let title = str_of(question, "title").unwrap_or("Untitled").to_owned();
		let mut md = question_markdown(question);
		let api = format!("https://api.stackexchange.com/2.3/questions/{id}/answers?order=desc&sort=votes&site={site}&filter=withbody");
		fetch(Fetch::get(api).accept_json(), move |reply, _| {
			if let Some(answers) = reply.json_value() {
				let items = arr_of(&answers, "items");
				if !items.is_empty() {
					md.push_str("---\n\n## Answers\n\n");
					for answer in items.iter().take(MAX_ANSWERS) {
						write_answer(&mut md, answer);
					}
				}
			}
			Done::new(md, METHOD)
				.title(title)
				.note(format!("Fetched via Stack Exchange API (site={site})"))
				.finish()
		})
	})
}

/// The API's `site` parameter for a hostname, or `None` for a non-SE site.
fn site_param(hostname: &str) -> Option<String> {
	let host = hostname.strip_prefix("www.").unwrap_or(hostname);
	if let Some((_, site)) = STANDALONE.iter().find(|(name, _)| *name == host) {
		return Some((*site).to_owned());
	}
	let subdomain = host.strip_suffix(".stackexchange.com")?;
	let valid = !subdomain.is_empty()
		&& subdomain
			.bytes()
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
	valid.then(|| subdomain.to_owned())
}

/// The id of the first `/questions/<id>` in a path.
fn question_id(path: &str) -> Option<&str> {
	for rest in path.split("/questions/").skip(1) {
		let end = rest
			.find(|c: char| !c.is_ascii_digit())
			.unwrap_or(rest.len());
		if end > 0 {
			return Some(&rest[..end]);
		}
	}
	None
}

/// Title, score, tags and body of the question.
fn question_markdown(question: &Value) -> String {
	let mut md = format!("# {}\n\n", str_of(question, "title").unwrap_or("Untitled"));
	let _ = write!(
		md,
		"**Score:** {} · **Answers:** {}",
		i64_of(question, "score").unwrap_or(0),
		u64_of(question, "answer_count").unwrap_or(0)
	);
	if is_true(question, "is_answered") {
		md.push_str(" (Answered)");
	}
	let _ = write!(md, "\n**Tags:** {}\n", strs_of(question, "tags").join(", "));
	let _ = write!(md, "**Asked by:** {} · {}\n\n", owner_name(question), timestamp(question));
	md.push_str("---\n\n## Question\n\n");
	md.push_str(&body(question));
	md.push_str("\n\n");
	md
}

fn write_answer(md: &mut String, answer: &Value) {
	let accepted = if is_true(answer, "is_accepted") {
		" (Accepted)"
	} else {
		""
	};
	let _ = write!(
		md,
		"### Score: {}{accepted} · by {}\n\n",
		i64_of(answer, "score").unwrap_or(0),
		owner_name(answer)
	);
	md.push_str(&body(answer));
	md.push_str("\n\n---\n\n");
}

fn body(item: &Value) -> String {
	str_of(item, "body").map_or_else(String::new, |html| html_to_markdown(html, None))
}

fn owner_name(item: &Value) -> &str {
	item
		.get("owner")
		.and_then(|owner| str_of(owner, "display_name"))
		.unwrap_or("[unknown]")
}

fn timestamp(item: &Value) -> String {
	i64_of(item, "creation_date").map_or_else(String::new, unix_date)
}

fn is_true(item: &Value, key: &str) -> bool {
	item.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn question() -> serde_json::Value {
		json!({ "items": [{
			"title": "What is a NullPointerException?", "body": "<p>It is a <b>runtime</b> error.</p>",
			"score": 42, "owner": { "display_name": "Alice" }, "creation_date": 1_160_418_111,
			"tags": ["java", "exception"], "answer_count": 2, "is_answered": true
		}] })
	}

	fn answers() -> serde_json::Value {
		json!({ "items": [
			{ "body": "<p>Because you dereferenced <code>null</code>.</p>", "score": 100, "is_accepted": true,
			  "owner": { "display_name": "Bob" }, "creation_date": 1_160_419_000 },
			{ "body": "<p>See the spec.</p>", "score": 5, "is_accepted": false,
			  "owner": { "display_name": "Carol" }, "creation_date": 1_160_420_000 }
		] })
	}

	#[test]
	fn a_question_page_reads_the_question_then_its_answers() {
		let mut requests = Vec::new();
		let done = run(
			"https://stackoverflow.com/questions/218384/what-is-a-nullpointerexception",
			|request| {
				requests.push(request.url.clone());
				if request.url.contains("/answers?") {
					Fetched::json(&answers())
				} else {
					Fetched::json(&question())
				}
			},
		)
		.unwrap();
		assert_eq!(requests, [
			"https://api.stackexchange.com/2.3/questions/218384?order=desc&sort=votes&site=stackoverflow&filter=withbody",
			"https://api.stackexchange.com/2.3/questions/218384/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody"
		]);
		assert_eq!(
			(done.method, done.title.as_deref()),
			("stackexchange", Some("What is a NullPointerException?"))
		);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# What is a NullPointerException?\n\n**Score:** 42 · **Answers:** 2 \
			 (Answered)\n**Tags:** java, exception\n**Asked by:** Alice · 2006-10-09\n\n"
		));
		assert!(
			md.contains("---\n\n## Question\n\nIt is a **runtime** error.\n\n---\n\n## Answers\n\n")
		);
		assert!(md.contains(
			"### Score: 100 (Accepted) · by Bob\n\nBecause you dereferenced `null`.\n\n---\n\n"
		));
		assert!(md.contains("### Score: 5 · by Carol\n\nSee the spec.\n"));
		assert_eq!(done.notes, ["Fetched via Stack Exchange API (site=stackoverflow)"]);
	}

	#[test]
	fn a_stackexchange_subdomain_and_an_answer_failure_still_render() {
		let done = run("https://unix.stackexchange.com/questions/131766/whitespace", |request| {
			if request.url.contains("/answers?") {
				Fetched::status(500)
			} else {
				assert_eq!(request.url, "https://api.stackexchange.com/2.3/questions/131766?order=desc&sort=votes&site=unix&filter=withbody");
				Fetched::json(&question())
			}
		})
		.unwrap();
		assert!(!done.markdown.contains("## Answers"));
		assert_eq!(done.notes, ["Fetched via Stack Exchange API (site=unix)"]);
	}

	#[test]
	fn other_urls_and_a_failed_question_fall_through() {
		for url in [
			"https://example.test/questions/218384",
			"https://stackoverflow.com/tags",
			"https://stackoverflow.com/questions/not-a-number/x",
		] {
			assert_eq!(run(url, |_| panic!("no fetch expected")), None, "{url}");
		}
		assert_eq!(run("https://stackoverflow.com/questions/218384", |_| Fetched::status(502)), None);
	}
}
