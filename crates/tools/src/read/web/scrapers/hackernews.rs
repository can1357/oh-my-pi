//! Hacker News item and listing renderer backed by the Firebase API.

use std::{
	fmt::Write,
	time::{SystemTime, UNIX_EPOCH},
};

use futures::future::join_all;
#[cfg(test)]
use omp_tool::Severity;
use omp_tool::{Diag, DiagKind};
use serde::Deserialize;
use url::Url;

use crate::read::web::types::{HttpClient, HttpRequest, RenderResult, WebError};

const API_BASE: &str = "https://hacker-news.firebaseio.com/v0";
const LISTING_LIMIT: usize = 20;
const TOP_COMMENT_LIMIT: usize = 20;
const CHILD_COMMENT_LIMIT: usize = 10;

#[derive(Deserialize)]
struct HnItem {
	id:          Option<u64>,
	#[serde(default)]
	deleted:     bool,
	by:          Option<String>,
	time:        Option<i64>,
	text:        Option<String>,
	#[serde(default)]
	dead:        bool,
	kids:        Option<Vec<u64>>,
	url:         Option<String>,
	score:       Option<i64>,
	title:       Option<String>,
	descendants: Option<u64>,
}

pub(super) fn matches(url: &Url) -> bool {
	url.host_str()
		.is_some_and(|host| host.contains("news.ycombinator.com"))
}

pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	if !matches(url) {
		return Ok(None);
	}

	let item_id = url
		.query_pairs()
		.find_map(|(name, value)| (name == "id" && !value.is_empty()).then(|| value.into_owned()));

	if let Some(item_id) = item_id {
		let id = parse_decimal_prefix(&item_id);
		let Some(item) = fetch_item_key(client, &id).await else {
			return Ok(Some(error_result(&format!("Failed to fetch item {item_id}"))));
		};
		let content = render_item(client, &item).await;
		let provenance = format!("Fetched HN item {item_id} with top-level comments (depth 2)");
		return Ok(Some(markdown_result(&content, provenance)));
	}

	let (endpoint, title, success_note, fetch_error, parse_error) = match url.path() {
		"/" | "/news" => (
			"topstories.json",
			"Hacker News - Top Stories",
			"Fetched top 20 stories from HN front page",
			"Failed to fetch top stories",
			"Failed to parse top stories",
		),
		"/newest" => (
			"newstories.json",
			"Hacker News - New Stories",
			"Fetched top 20 new stories",
			"Failed to fetch new stories",
			"Failed to parse new stories",
		),
		"/best" => (
			"beststories.json",
			"Hacker News - Best Stories",
			"Fetched top 20 best stories",
			"Failed to fetch best stories",
			"Failed to parse best stories",
		),
		_ => return Ok(None),
	};

	let Ok(response) = client
		.get(HttpRequest::new(format!("{API_BASE}/{endpoint}")))
		.await
	else {
		return Ok(Some(error_result(fetch_error)));
	};
	if !response.is_success() {
		return Ok(Some(error_result(fetch_error)));
	}
	let ids: Vec<u64> = match serde_json::from_slice(&response.body) {
		Ok(ids) => ids,
		Err(_) => return Ok(Some(error_result(parse_error))),
	};
	let content = render_listing(client, &ids, title).await;
	Ok(Some(markdown_result(&content, success_note.to_owned())))
}

async fn fetch_item<C: HttpClient + Sync>(client: &C, id: u64) -> Option<HnItem> {
	fetch_item_at(client, format!("{API_BASE}/item/{id}.json")).await
}

async fn fetch_item_key<C: HttpClient + Sync>(client: &C, id: &str) -> Option<HnItem> {
	fetch_item_at(client, format!("{API_BASE}/item/{id}.json")).await
}

async fn fetch_item_at<C: HttpClient + Sync>(client: &C, url: String) -> Option<HnItem> {
	let response = client.get(HttpRequest::new(url)).await.ok()?;
	if !response.is_success() {
		return None;
	}
	serde_json::from_slice(&response.body).ok()
}

async fn fetch_items<C: HttpClient + Sync>(client: &C, ids: &[u64], limit: usize) -> Vec<HnItem> {
	let fetched = join_all(ids.iter().take(limit).map(|id| fetch_item(client, *id))).await;
	fetched
		.into_iter()
		.flatten()
		.filter(|item| !item.deleted && !item.dead)
		.collect()
}

async fn render_item<C: HttpClient + Sync>(client: &C, item: &HnItem) -> String {
	let mut output = String::new();
	output.push_str("# ");
	output.push_str(item.title.as_deref().unwrap_or("undefined"));
	output.push_str("\n\n");
	if let Some(url) = item.url.as_deref().filter(|url| !url.is_empty()) {
		output.push_str("**URL:** ");
		output.push_str(url);
		output.push_str("\n\n");
	}
	output.push_str("**Posted by:** ");
	output.push_str(item.by.as_deref().unwrap_or("undefined"));
	output.push_str(" | **Score:** ");
	output.push_str(&item.score.unwrap_or(0).to_string());
	output.push_str(" | **Time:** ");
	output.push_str(&format_timestamp(item.time.unwrap_or(0)));
	if let Some(descendants) = item.descendants.filter(|count| *count != 0) {
		output.push_str(" | **Comments:** ");
		output.push_str(&descendants.to_string());
	}
	output.push_str("\n\n");
	append_item_text(&mut output, item, "");

	let Some(kids) = item.kids.as_deref().filter(|kids| !kids.is_empty()) else {
		return output;
	};
	let comments = fetch_items(client, kids, TOP_COMMENT_LIMIT).await;
	if comments.is_empty() {
		return output;
	}

	output.push_str("---\n\n## Comments\n\n");
	for comment in comments {
		append_comment(&mut output, &comment, "");

		let Some(kids) = comment.kids.as_deref().filter(|kids| !kids.is_empty()) else {
			continue;
		};

		// A parent comment's text is emitted again immediately before its replies
		// to preserve depth-one recursive output.
		append_item_text(&mut output, &comment, "");
		let children = fetch_items(client, kids, CHILD_COMMENT_LIMIT).await;
		for child in children {
			append_comment(&mut output, &child, "  ");
		}
	}
	output
}

async fn render_listing<C: HttpClient + Sync>(client: &C, ids: &[u64], title: &str) -> String {
	let stories = fetch_items(client, ids, LISTING_LIMIT).await;
	let mut output = format!("# {title}\n\n");
	for (index, story) in stories.iter().enumerate() {
		let _ =
			writeln!(output, "{}. **{}**", index + 1, story.title.as_deref().unwrap_or("undefined"));
		if let Some(url) = story.url.as_deref().filter(|url| !url.is_empty()) {
			output.push_str("   ");
			output.push_str(url);
			output.push('\n');
		}
		output.push_str("   ");
		output.push_str(&story.score.unwrap_or(0).to_string());
		output.push_str(" points by ");
		output.push_str(story.by.as_deref().unwrap_or("undefined"));
		output.push_str(" | ");
		output.push_str(&format_timestamp(story.time.unwrap_or(0)));
		if let Some(descendants) = story.descendants.filter(|count| *count != 0) {
			output.push_str(" | ");
			output.push_str(&descendants.to_string());
			output.push_str(" comments");
		}
		output.push_str("\n   https://news.ycombinator.com/item?id=");
		output.push_str(&item_id_text(story));
		output.push_str("\n\n");
	}
	output
}

fn append_comment(output: &mut String, item: &HnItem, indent: &str) {
	output.push_str(indent);
	output.push_str("**");
	output.push_str(item.by.as_deref().unwrap_or("undefined"));
	output.push_str("** (");
	output.push_str(&format_timestamp(item.time.unwrap_or(0)));
	output.push(')');
	if let Some(score) = item.score {
		output.push_str(" [");
		output.push_str(&score.to_string());
		output.push(']');
	}
	output.push('\n');
	append_item_text(output, item, indent);
}

fn append_item_text(output: &mut String, item: &HnItem, indent: &str) {
	let Some(html) = item.text.as_deref().filter(|text| !text.is_empty()) else {
		return;
	};
	let text = decode_hn_text(html);
	for (index, line) in text.split('\n').enumerate() {
		if index != 0 {
			output.push('\n');
		}
		output.push_str(indent);
		output.push_str(line);
	}
	output.push_str("\n\n");
}

fn decode_hn_text(html: &str) -> String {
	let replaced = html
		.replace("<p>", "\n\n")
		.replace("</p>", "")
		.replace("<pre><code>", "\n```\n")
		.replace("</code></pre>", "\n```\n")
		.replace("<code>", "`")
		.replace("</code>", "`")
		.replace("<i>", "*")
		.replace("</i>", "*");
	let anchors = replace_anchors(&replaced);
	let without_tags = strip_tags(&anchors);
	without_tags
		.replace("&lt;", "<")
		.replace("&gt;", ">")
		.replace("&amp;", "&")
		.replace("&quot;", "\"")
		.replace("&#039;", "'")
		.replace("&#39;", "'")
		.replace("&#x27;", "'")
		.replace("&#x2F;", "/")
		.replace("&nbsp;", " ")
		.trim()
		.to_owned()
}

fn replace_anchors(input: &str) -> String {
	const PREFIX: &str = "<a href=\"";
	let mut output = String::with_capacity(input.len());
	let mut rest = input;
	while let Some(start) = rest.find(PREFIX) {
		output.push_str(&rest[..start]);
		let anchor = &rest[start..];
		let href_start = PREFIX.len();
		let Some(href_len) = anchor[href_start..].find('"') else {
			output.push_str(anchor);
			return output;
		};
		if href_len == 0 {
			output.push('<');
			rest = &anchor[1..];
			continue;
		}
		let href_end = href_start + href_len;
		let Some(open_tail) = anchor[href_end + 1..].find('>') else {
			output.push_str(anchor);
			return output;
		};
		let label_start = href_end + 1 + open_tail + 1;
		let Some(close_offset) = anchor[label_start..].find("</a>") else {
			output.push_str(anchor);
			return output;
		};
		let label_end = label_start + close_offset;
		let label = &anchor[label_start..label_end];
		if label.contains('<') {
			output.push('<');
			rest = &anchor[1..];
			continue;
		}
		output.push('[');
		output.push_str(label);
		output.push_str("](");
		output.push_str(&anchor[href_start..href_end]);
		output.push(')');
		rest = &anchor[label_end + "</a>".len()..];
	}
	output.push_str(rest);
	output
}

fn strip_tags(input: &str) -> String {
	let mut output = String::with_capacity(input.len());
	let mut rest = input;
	while let Some(start) = rest.find('<') {
		output.push_str(&rest[..start]);
		let Some(end) = rest[start + 1..].find('>') else {
			output.push_str(&rest[start..]);
			return output;
		};
		if end == 0 {
			output.push('<');
			rest = &rest[start + 1..];
			continue;
		}
		rest = &rest[start + end + 2..];
	}
	output.push_str(rest);
	output
}

fn format_timestamp(unix_time: i64) -> String {
	let now_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0_i128, |duration| duration.as_millis() as i128);
	let diff_ms = now_ms - i128::from(unix_time) * 1_000;
	let hours = diff_ms.div_euclid(3_600_000);
	let days = hours.div_euclid(24);
	if days > 7 {
		return format_iso_date(unix_time);
	}
	if days > 0 {
		return format!("{days}d ago");
	}
	if hours > 0 {
		return format!("{hours}h ago");
	}
	let minutes = diff_ms.div_euclid(60_000);
	format!("{minutes}m ago")
}

fn format_iso_date(unix_time: i64) -> String {
	let days = unix_time.div_euclid(86_400);
	let shifted = days + 719_468;
	let era = if shifted >= 0 {
		shifted
	} else {
		shifted - 146_096
	} / 146_097;
	let day_of_era = shifted - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let mut year = year_of_era + era * 400;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let month_prime = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
	let month = month_prime + if month_prime < 10 { 3 } else { -9 };
	year += i64::from(month <= 2);
	format!("{year:04}-{month:02}-{day:02}")
}

fn parse_decimal_prefix(value: &str) -> String {
	let value = value.trim_start();
	let (negative, digits) = match value.as_bytes().first() {
		Some(b'-') => (true, &value[1..]),
		Some(b'+') => (false, &value[1..]),
		_ => (false, value),
	};
	let digits = &digits[..digits.bytes().take_while(u8::is_ascii_digit).count()];
	if digits.is_empty() {
		return "NaN".to_owned();
	}
	let Ok(number) = digits.parse::<u64>() else {
		return "NaN".to_owned();
	};
	if negative && number != 0 {
		format!("-{number}")
	} else {
		number.to_string()
	}
}

fn item_id_text(item: &HnItem) -> String {
	item
		.id
		.map_or_else(|| "undefined".to_owned(), |id| id.to_string())
}

fn markdown_result(content: &str, provenance: String) -> RenderResult {
	let mut result = RenderResult::markdown(content, "hackernews");
	result
		.diags
		.insert(0, Diag::info(DiagKind::Provenance, provenance));
	result
}

fn error_result(message: &str) -> RenderResult {
	let content = format!("# Error fetching Hacker News content\n\n{message}");
	let mut result = RenderResult::markdown(&content, "hackernews");
	result
		.diags
		.insert(0, Diag::warn(DiagKind::FetchFailed, message));
	result
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		future::{Future, ready},
	};

	use bytes::Bytes;
	use parking_lot::Mutex;
	use smallvec::SmallVec;

	use super::*;
	use crate::read::web::types::HttpResponse;

	struct FakeClient {
		responses: HashMap<String, (u16, String)>,
		requests:  Mutex<Vec<String>>,
	}

	impl FakeClient {
		fn new(responses: impl IntoIterator<Item = (String, String)>) -> Self {
			Self {
				responses: responses
					.into_iter()
					.map(|(url, body)| (url, (200, body)))
					.collect(),
				requests:  Mutex::new(Vec::new()),
			}
		}

		fn requested(&self, suffix: &str) -> bool {
			self.requests.lock().iter().any(|url| url.ends_with(suffix))
		}
	}

	impl HttpClient for FakeClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			let url = request.url.to_string();
			self.requests.lock().push(url.clone());
			let (status, body) = self
				.responses
				.get(&url)
				.cloned()
				.unwrap_or_else(|| (404, String::new()));
			ready(Ok(HttpResponse {
				final_url: url.into(),
				status,
				content_type: Some("application/json".into()),
				headers: SmallVec::new(),
				body: Bytes::from(body),
			}))
		}
	}

	fn item_url(id: u64) -> String {
		format!("{API_BASE}/item/{id}.json")
	}

	#[test]
	fn matches_items_and_supported_listings_only() {
		for target in [
			"https://news.ycombinator.com/item?id=42",
			"https://news.ycombinator.com/",
			"https://news.ycombinator.com/news",
			"https://news.ycombinator.com/newest",
			"https://news.ycombinator.com/best",
		] {
			assert!(matches(&Url::parse(target).unwrap()));
		}
		assert!(!matches(&Url::parse("https://example.com/item?id=42").unwrap()));
	}

	#[tokio::test]
	async fn unsupported_hacker_news_route_falls_back_without_fetching() {
		let client = FakeClient::new([]);
		let result = render(&client, &Url::parse("https://news.ycombinator.com/ask").unwrap())
			.await
			.unwrap();
		assert!(result.is_none());
		assert!(client.requests.lock().is_empty());
	}

	#[tokio::test]
	async fn renders_story_and_bounded_two_level_comment_tree_in_api_order() {
		let mut responses = HashMap::new();
		responses.insert(
			item_url(42),
			r#"{"id":42,"by":"op","time":0,"text":"Intro<p>Second &amp; <a href=\"https://e.test\" rel=\"nofollow\">link</a>","kids":[100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120],"url":"https://story.test","score":7,"title":"Story","descendants":13}"#.to_owned(),
		);
		responses.insert(
			item_url(100),
			r#"{"id":100,"by":"alice","time":0,"text":"Parent <i>thought</i>","score":2,"kids":[200,201,202,203,204,205,206,207,208,209,210]}"#.to_owned(),
		);
		responses.insert(
			item_url(200),
			r#"{"id":200,"by":"bob","time":0,"text":"Child <code>code</code>","kids":[300]}"#
				.to_owned(),
		);
		responses.insert(
			item_url(201),
			r#"{"id":201,"deleted":true,"by":"removed","time":0,"text":"hidden"}"#.to_owned(),
		);
		responses.insert(
			item_url(202),
			r#"{"id":202,"dead":true,"by":"dead","time":0,"text":"hidden"}"#.to_owned(),
		);
		responses
			.insert(item_url(203), r#"{"id":203,"by":"carol","time":0,"text":"Later"}"#.to_owned());
		let client = FakeClient::new(responses);
		let result = render(&client, &Url::parse("https://news.ycombinator.com/item?id=42").unwrap())
			.await
			.unwrap()
			.unwrap();

		assert_eq!(
			result.content.as_str(),
			"# Story\n\n**URL:** https://story.test\n\n**Posted by:** op | **Score:** 7 | \
			 **Time:** 1970-01-01 | **Comments:** 13\n\nIntro\n\nSecond & \
			 [link](https://e.test)\n\n---\n\n## Comments\n\n**alice** (1970-01-01) \
			 [2]\nParent *thought*\n\nParent *thought*\n\n  **bob** (1970-01-01)\n  Child \
			 `code`\n\n  **carol** (1970-01-01)\n  Later"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		assert!(client.requested("/item/119.json"));
		assert!(!client.requested("/item/120.json"));
		assert!(client.requested("/item/209.json"));
		assert!(!client.requested("/item/210.json"));
		assert!(!client.requested("/item/300.json"));
	}

	#[tokio::test]
	async fn listing_filters_deleted_dead_and_malformed_items_without_reordering() {
		let ids = (1_u64..=22)
			.map(|id| id.to_string())
			.collect::<Vec<_>>()
			.join(",");
		let mut responses =
			HashMap::from([(format!("{API_BASE}/topstories.json"), format!("[{ids}]"))]);
		responses.insert(item_url(1), r#"{"id":1,"deleted":true}"#.to_owned());
		responses.insert(item_url(2), r#"{"id":2,"dead":true}"#.to_owned());
		responses.insert(
			item_url(3),
			r#"{"id":3,"title":"Third","url":"https://third.test","score":9,"by":"cat","time":0,"descendants":2}"#.to_owned(),
		);
		responses.insert(
			item_url(4),
			r#"{"id":4,"title":"Fourth","score":0,"by":"dog","time":0}"#.to_owned(),
		);
		responses.insert(item_url(5), "{not json".to_owned());
		let client = FakeClient::new(responses);
		let result = render(&client, &Url::parse("https://news.ycombinator.com/news").unwrap())
			.await
			.unwrap()
			.unwrap();

		assert_eq!(
			result.content.as_str(),
			"# Hacker News - Top Stories\n\n1. **Third**\n   https://third.test\n   9 points \
			 by cat | 1970-01-01 | 2 comments\n   \
			 https://news.ycombinator.com/item?id=3\n\n2. **Fourth**\n   0 points by dog | \
			 1970-01-01\n   https://news.ycombinator.com/item?id=4"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		assert!(client.requested("/item/20.json"));
		assert!(!client.requested("/item/21.json"));
		assert!(!client.requested("/item/22.json"));
	}

	#[tokio::test]
	async fn direct_comment_uses_story_framing_and_comment_text() {
		let client = FakeClient::new([(
			item_url(6),
			r#"{"id":6,"type":"comment","by":"reader","time":0,"text":"Reply &lt;ok&gt;"}"#.to_owned(),
		)]);
		let result = render(&client, &Url::parse("https://news.ycombinator.com/item?id=6").unwrap())
			.await
			.unwrap()
			.unwrap();
		assert_eq!(
			result.content.as_str(),
			"# undefined\n\n**Posted by:** reader | **Score:** 0 | **Time:** 1970-01-01\n\nReply <ok>"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
	}

	#[tokio::test]
	async fn direct_deleted_and_dead_items_still_render_like_pi() {
		for flag in [r#""deleted":true"#, r#""dead":true"#] {
			let client = FakeClient::new([(
				item_url(7),
				format!(r#"{{"id":7,{flag},"title":"Gone","by":"nobody","time":0}}"#),
			)]);
			let result =
				render(&client, &Url::parse("https://news.ycombinator.com/item?id=7").unwrap())
					.await
					.unwrap()
					.unwrap();
			assert_eq!(
				result.content.as_str(),
				"# Gone\n\n**Posted by:** nobody | **Score:** 0 | **Time:** 1970-01-01"
			);
		}
	}

	#[tokio::test]
	async fn malformed_payloads_use_pi_fallbacks() {
		let malformed_item = FakeClient::new([(item_url(9), "{not json".to_owned())]);
		let result =
			render(&malformed_item, &Url::parse("https://news.ycombinator.com/item?id=9").unwrap())
				.await
				.unwrap()
				.unwrap();
		assert_eq!(
			result.content.as_str(),
			"# Error fetching Hacker News content\n\nFailed to fetch item 9"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::FetchFailed));
		assert_eq!(result.diags[0].severity, Severity::Warn);

		let malformed_listing = FakeClient::new([(
			format!("{API_BASE}/newstories.json"),
			r#"{"not":"an array"}"#.to_owned(),
		)]);
		let result =
			render(&malformed_listing, &Url::parse("https://news.ycombinator.com/newest").unwrap())
				.await
				.unwrap()
				.unwrap();
		assert_eq!(
			result.content.as_str(),
			"# Error fetching Hacker News content\n\nFailed to parse new stories"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::FetchFailed));
		assert_eq!(result.diags[0].severity, Severity::Warn);

		let missing_fields = FakeClient::new([(item_url(10), "{}".to_owned())]);
		let result =
			render(&missing_fields, &Url::parse("https://news.ycombinator.com/item?id=10").unwrap())
				.await
				.unwrap()
				.unwrap();
		assert_eq!(
			result.content.as_str(),
			"# undefined\n\n**Posted by:** undefined | **Score:** 0 | **Time:** 1970-01-01"
		);
	}
}
