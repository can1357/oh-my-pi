//! Stack Exchange question renderer backed by the public Stack Exchange API.

use std::fmt::Write as _;

use omp_core::{Str, sf};
#[cfg(test)]
use omp_tool::Severity;
use omp_tool::{Diag, DiagKind};
use serde::Deserialize;
use url::Url;

use super::{
	super::types::{HttpClient, HttpRequest, RenderResult, WebError},
	utils::{build_result, decode_json, format_unix_date, html_to_basic_markdown},
};

const API_ROOT: &str = "https://api.stackexchange.com/2.3";
const ANSWER_LIMIT: usize = 5;

#[derive(Deserialize)]
struct ApiItems<T> {
	items: Vec<T>,
}

#[derive(Deserialize)]
struct Owner {
	display_name: String,
}

#[derive(Deserialize)]
struct Question {
	title:         String,
	body:          String,
	score:         i64,
	owner:         Owner,
	creation_date: i64,
	tags:          Vec<String>,
	answer_count:  u64,
	is_answered:   bool,
}

#[derive(Deserialize)]
struct Answer {
	body:        String,
	score:       i64,
	is_accepted: bool,
	owner:       Owner,
}

struct Target<'a> {
	question_id: &'a str,
	site:        &'a str,
}

/// Returns whether `url` names a question on a supported Stack Exchange site.
pub(super) fn matches(url: &Url) -> bool {
	parse_target(url).is_some()
}

/// Renders a Stack Exchange question and its five highest-voted answers.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	match render_inner(client, url).await {
		Ok(result) => Ok(result),
		// The handler is deliberately opportunistic: any API or conversion failure
		// declines the scrape.
		Err(_) => Ok(None),
	}
}

async fn render_inner<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse_target(url) else {
		return Ok(None);
	};

	let question_url = format!(
		"{API_ROOT}/questions/{}?order=desc&sort=votes&site={}&filter=withbody",
		target.question_id, target.site
	);
	let Some(question_data): Option<ApiItems<Question>> = get_json(client, question_url).await
	else {
		return Ok(None);
	};
	let Some(question) = question_data.items.into_iter().next() else {
		return Ok(None);
	};

	let mut markdown = format!("# {}\n\n", question.title);
	write!(markdown, "**Score:** {} · **Answers:** {}", question.score, question.answer_count)
		.expect("writing to String cannot fail");
	if question.is_answered {
		markdown.push_str(" (Answered)");
	}
	writeln!(markdown, "\n**Tags:** {}", question.tags.join(", "))
		.expect("writing to String cannot fail");
	writeln!(
		markdown,
		"**Asked by:** {} · {}\n",
		question.owner.display_name,
		format_unix_date(question.creation_date.saturating_mul(1_000))
	)
	.expect("writing to String cannot fail");
	markdown.push_str("---\n\n## Question\n\n");
	markdown.push_str(&clean_html(&question.body)?);
	markdown.push_str("\n\n");

	let answers_url = format!(
		"{API_ROOT}/questions/{}/answers?order=desc&sort=votes&site={}&filter=withbody",
		target.question_id, target.site
	);
	if let Some(answer_data) = get_json::<_, ApiItems<Answer>>(client, answers_url).await
		&& !answer_data.items.is_empty()
	{
		markdown.push_str("---\n\n## Answers\n\n");
		// The API's vote order is authoritative. Acceptance is metadata,
		// not a reason to move an answer ahead of a more highly-voted one.
		for answer in answer_data.items.into_iter().take(ANSWER_LIMIT) {
			let accepted = if answer.is_accepted {
				" (Accepted)"
			} else {
				""
			};
			writeln!(
				markdown,
				"### Score: {}{} · by {}\n",
				answer.score, accepted, answer.owner.display_name
			)
			.expect("writing to String cannot fail");
			markdown.push_str(&clean_html(&answer.body)?);
			markdown.push_str("\n\n---\n\n");
		}
	}

	let mut result = build_result(&markdown, "stackexchange");
	result.diags.push(Diag::info(
		DiagKind::Provenance,
		sf!("Fetched via Stack Exchange API (site={})", target.site),
	));
	Ok(Some(result))
}

async fn get_json<C, T>(client: &C, endpoint: String) -> Option<T>
where
	C: HttpClient + Sync,
	T: for<'de> Deserialize<'de>,
{
	let response = client.get(HttpRequest::new(endpoint)).await.ok()?;
	if !response.is_success() {
		return None;
	}
	decode_json(&response).ok()
}

fn parse_target(url: &Url) -> Option<Target<'_>> {
	let host = url
		.host_str()?
		.strip_prefix("www.")
		.unwrap_or(url.host_str()?);
	let site = site_parameter(host)?;
	let question_id = url
		.path()
		.match_indices("/questions/")
		.find_map(|(start, marker)| {
			let remainder = &url.path()[start + marker.len()..];
			let digits = remainder
				.bytes()
				.take_while(|byte| byte.is_ascii_digit())
				.count();
			(digits > 0).then_some(&remainder[..digits])
		})?;
	Some(Target { question_id, site })
}

fn site_parameter(host: &str) -> Option<&str> {
	match host {
		"stackoverflow.com" => Some("stackoverflow"),
		"superuser.com" => Some("superuser"),
		"serverfault.com" => Some("serverfault"),
		"askubuntu.com" => Some("askubuntu"),
		"mathoverflow.net" => Some("mathoverflow"),
		"stackapps.com" => Some("stackapps"),
		_ => host.strip_suffix(".stackexchange.com").filter(|subdomain| {
			!subdomain.is_empty()
				&& subdomain
					.bytes()
					.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
		}),
	}
}

fn clean_html(html: &str) -> Result<Str, WebError> {
	let cleaned = strip_element_blocks(html, "script");
	let cleaned = strip_element_blocks(&cleaned, "style");
	html_to_basic_markdown(&cleaned)
}

fn strip_element_blocks(input: &str, element: &str) -> String {
	let open = format!("<{element}");
	let close = format!("</{element}>");
	let mut output = String::with_capacity(input.len());
	let mut remaining = input;

	while let Some(start) = find_ascii_case_insensitive(remaining, &open) {
		output.push_str(&remaining[..start]);
		let after_start = &remaining[start..];
		let Some(end) = find_ascii_case_insensitive(after_start, &close) else {
			output.push_str(after_start);
			return output;
		};
		remaining = &after_start[end + close.len()..];
	}
	output.push_str(remaining);
	output
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
	let needle = needle.as_bytes();
	haystack
		.as_bytes()
		.windows(needle.len())
		.position(|window| window.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		future::{Future, ready},
	};

	use bytes::Bytes;
	use parking_lot::Mutex;
	use smallvec::SmallVec;

	use super::*;
	use crate::read::web::types::{HttpResponse, MAX_BYTES, MAX_OUTPUT_CHARS};

	const QUESTION: &str = r#"{
		"items": [{
			"title": "How to test?",
			"body": "<p>Question <strong>body</strong>.</p><script>discard me</script>",
			"score": 42,
			"owner": {"display_name": "Ada"},
			"creation_date": 0,
			"tags": ["rust", "testing"],
			"answer_count": 6,
			"is_answered": true
		}]
	}"#;

	const ANSWERS: &str = r#"{
		"items": [
			{"body":"<p>Answer one.</p>","score":100,"is_accepted":false,"owner":{"display_name":"One"}},
			{"body":"<p>Answer two.</p>","score":90,"is_accepted":true,"owner":{"display_name":"Two"}},
			{"body":"<p>Answer three.</p>","score":80,"is_accepted":false,"owner":{"display_name":"Three"}},
			{"body":"<p>Answer four.</p>","score":70,"is_accepted":false,"owner":{"display_name":"Four"}},
			{"body":"<p>Answer five.</p>","score":60,"is_accepted":false,"owner":{"display_name":"Five"}},
			{"body":"<p>Answer six.</p>","score":50,"is_accepted":false,"owner":{"display_name":"Six"}}
		]
	}"#;

	struct FakeClient {
		requests:  Mutex<Vec<HttpRequest>>,
		responses: Mutex<VecDeque<Result<HttpResponse, WebError>>>,
	}

	impl FakeClient {
		fn new(responses: impl IntoIterator<Item = Result<HttpResponse, WebError>>) -> Self {
			Self {
				requests:  Mutex::new(Vec::new()),
				responses: Mutex::new(responses.into_iter().collect()),
			}
		}
	}

	impl HttpClient for FakeClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			self.requests.lock().push(request);
			ready(
				self
					.responses
					.lock()
					.pop_front()
					.expect("unexpected Stack Exchange API request"),
			)
		}
	}

	fn response(status: u16, body: impl Into<Bytes>) -> HttpResponse {
		HttpResponse {
			final_url: "https://api.stackexchange.com/2.3/test".into(),
			status,
			content_type: Some("application/json".into()),
			headers: SmallVec::new(),
			body: body.into(),
		}
	}

	#[test]
	fn maps_only_pi_stack_exchange_question_urls() {
		for (url, id, site) in [
			("https://stackoverflow.com/questions/123/title", "123", "stackoverflow"),
			("https://www.superuser.com/questions/234/title", "234", "superuser"),
			("https://serverfault.com/questions/345", "345", "serverfault"),
			("https://askubuntu.com/questions/456", "456", "askubuntu"),
			("https://mathoverflow.net/questions/567", "567", "mathoverflow"),
			("https://stackapps.com/questions/678", "678", "stackapps"),
			("https://unix.stackexchange.com/questions/789", "789", "unix"),
			// The pathname regex is intentionally unanchored and stops after the digit
			// run rather than requiring the whole segment to be numeric.
			("https://unix.stackexchange.com/x/questions/890suffix", "890", "unix"),
		] {
			let parsed = Url::parse(url).unwrap();
			let target = parse_target(&parsed).unwrap();
			assert_eq!(target.question_id, id);
			assert_eq!(target.site, site);
			assert!(matches(&parsed));
		}

		for url in [
			"https://example.com/questions/123",
			"https://meta.stackoverflow.com/questions/123",
			"https://stackoverflow.com/q/123",
			"https://stackoverflow.com/questions/no-id",
			"https://stackoverflow.com/%71uestions/123",
			"https://stackoverflow.com/questions/%31%32%33",
		] {
			assert!(!matches(&Url::parse(url).unwrap()), "{url}");
		}
	}

	#[tokio::test]
	async fn renders_question_and_first_five_answers_in_api_vote_order() {
		let client = FakeClient::new([Ok(response(200, QUESTION)), Ok(response(200, ANSWERS))]);
		let url = Url::parse("https://unix.stackexchange.com/questions/123/example").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(result.method.as_str(), "stackexchange");
		assert_eq!(result.content_type.as_deref(), Some("text/markdown"));
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		assert_eq!(
			result.content.as_str(),
			"# How to test?\n\n**Score:** 42 · **Answers:** 6 (Answered)\n**Tags:** rust, \
			 testing\n**Asked by:** Ada · 1970-01-01\n\n---\n\n## Question\n\nQuestion \
			 **body**.\n\n---\n\n## Answers\n\n### Score: 100 · by One\n\nAnswer one.\n\n---\n\n### \
			 Score: 90 (Accepted) · by Two\n\nAnswer two.\n\n---\n\n### Score: 80 · by \
			 Three\n\nAnswer three.\n\n---\n\n### Score: 70 · by Four\n\nAnswer four.\n\n---\n\n### \
			 Score: 60 · by Five\n\nAnswer five.\n\n---"
		);
		assert!(!result.content.contains("Answer six."));

		let requests = client.requests.lock();
		assert_eq!(requests.len(), 2);
		assert_eq!(
			requests[0].url.as_str(),
			"https://api.stackexchange.com/2.3/questions/123?order=desc&sort=votes&site=unix&filter=withbody"
		);
		assert_eq!(
			requests[1].url.as_str(),
			"https://api.stackexchange.com/2.3/questions/123/answers?order=desc&sort=votes&site=unix&filter=withbody"
		);
		assert!(
			requests
				.iter()
				.all(|request| request.max_bytes == MAX_BYTES)
		);
	}

	#[tokio::test]
	async fn applies_the_shared_pi_output_cap() {
		let body = format!("<p>{}</p>", "x".repeat(MAX_OUTPUT_CHARS + 100));
		let question = serde_json::json!({
			"items": [{
				"title": "Large",
				"body": body,
				"score": 1,
				"owner": {"display_name": "Ada"},
				"creation_date": 0,
				"tags": [],
				"answer_count": 0,
				"is_answered": false
			}]
		})
		.to_string();
		let client = FakeClient::new([
			Ok(response(200, Bytes::from(question))),
			Ok(response(200, r#"{"items":[]}"#)),
		]);
		let url = Url::parse("https://stackoverflow.com/questions/1/large").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(result.content.chars().count(), MAX_OUTPUT_CHARS);
		assert_eq!(result.diags.len(), 2);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::OutputBounded));
		assert_eq!(result.diags[0].severity, Severity::Warn);
		let omitted = result.diags[0]
			.omitted
			.as_ref()
			.expect("truncation count is typed");
		assert!(omitted.count > 0);
		assert_eq!(omitted.unit, Unit::Chars);
		assert_eq!(result.diags[1].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[1].severity, Severity::Info);
	}

	#[tokio::test]
	async fn declines_question_failures_and_keeps_question_when_answers_fail() {
		let url = Url::parse("https://stackoverflow.com/questions/123/example").unwrap();

		for failed_question in [
			Ok(response(503, "unavailable")),
			Ok(response(200, "{not json")),
			Ok(response(200, r#"{"items":[]}"#)),
			Err(WebError::request("offline")),
		] {
			let client = FakeClient::new([failed_question]);
			assert!(render(&client, &url).await.unwrap().is_none());
		}

		let client =
			FakeClient::new([Ok(response(200, QUESTION)), Err(WebError::request("answers offline"))]);
		let result = render(&client, &url).await.unwrap().unwrap();
		assert_eq!(
			result.content.as_str(),
			"# How to test?\n\n**Score:** 42 · **Answers:** 6 (Answered)\n**Tags:** rust, \
			 testing\n**Asked by:** Ada · 1970-01-01\n\n---\n\n## Question\n\nQuestion **body**."
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);

		let no_match = Url::parse("https://stackoverflow.com/users/123").unwrap();
		let client = FakeClient::new([]);
		assert!(render(&client, &no_match).await.unwrap().is_none());
		assert!(client.requests.lock().is_empty());
	}
}
