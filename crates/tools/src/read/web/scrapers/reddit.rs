//! Anonymous Reddit JSON renderer.

use std::fmt::{self, Display, Write as _};

use omp_core::Str;
#[cfg(test)]
use omp_core::sf;
#[cfg(test)]
use omp_tool::Severity;
use omp_tool::{Diag, DiagKind};
use serde_json::Value;
use smallvec::SmallVec;
use url::Url;

use crate::read::web::types::{HttpClient, HttpRequest, RenderResult, WebError};

const MAX_BYTES: usize = 50 * 1024 * 1024;
const MAX_LISTING_POSTS: usize = 20;
const MAX_TOP_COMMENTS: usize = 10;

/// Returns whether `url` is a Reddit page supported by the anonymous JSON API.
pub(super) fn matches(url: &Url) -> bool {
	url.host_str()
		.is_some_and(|host| host.contains("reddit.com"))
}

/// Renders a Reddit post, comment permalink, or listing through Reddit's
/// anonymous `.json` endpoint.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	if !matches(url) {
		return Ok(None);
	}

	let Ok(response) = client
		.get(HttpRequest {
			url:       json_endpoint(url),
			headers:   SmallVec::new(),
			max_bytes: MAX_BYTES,
		})
		.await
	else {
		return Ok(None);
	};
	if !response.is_success() {
		return Ok(None);
	}

	let Ok(data) = serde_json::from_slice::<Value>(response.body.as_ref()) else {
		return Ok(None);
	};
	let Some(content) = render_json(&data) else {
		return Ok(None);
	};

	let mut result = RenderResult::markdown(&content, "reddit");
	result
		.diags
		.insert(0, Diag::info(DiagKind::Provenance, "Fetched via Reddit JSON API"));
	Ok(Some(result))
}

fn json_endpoint(url: &Url) -> Str {
	let serialized = url.as_str();
	let trimmed = serialized.strip_suffix('/').unwrap_or(serialized);
	let Some(query) = url.query() else {
		return format!("{trimmed}.json").into();
	};
	let search = format!("?{query}");
	let base = trimmed.replacen(&search, "", 1);
	format!("{base}.json{search}").into()
}

fn render_json(data: &Value) -> Option<String> {
	if let Some(pages) = data.as_array() {
		return render_post_page(pages);
	}
	render_listing(data)
}

fn render_post_page(pages: &[Value]) -> Option<String> {
	if pages.is_empty() {
		return None;
	}
	let post = pages
		.first()
		.and_then(|page| page.pointer("/data/children/0/data"))
		.and_then(Value::as_object)?;

	let mut out = format!("# {}\n\n", field(post, "title"));
	writeln!(
		out,
		"**r/{}** · u/{} · {} points · {} comments",
		field(post, "subreddit"),
		field(post, "author"),
		field(post, "score"),
		field(post, "num_comments")
	)
	.ok()?;
	writeln!(out, "*{}*\n", iso_date(numeric_field(post, "created_utc"))).ok()?;

	if truthy(post.get("is_self")) {
		if truthy(post.get("selftext")) {
			write!(out, "---\n\n{}\n\n", field(post, "selftext")).ok()?;
		}
	} else {
		write!(out, "**Link:** {}\n\n", field(post, "url")).ok()?;
	}

	if let Some(comments) = pages
		.get(1)
		.and_then(|page| page.pointer("/data/children"))
		.filter(|comments| truthy(Some(comments)))
	{
		let children = comments.as_array()?;
		out.push_str("---\n\n## Top Comments\n\n");
		for child in children
			.iter()
			.filter(|child| child.get("kind").and_then(Value::as_str) == Some("t1"))
			.take(MAX_TOP_COMMENTS)
		{
			let comment = child.get("data")?.as_object()?;
			writeln!(out, "### u/{} · {} points\n", field(comment, "author"), field(comment, "score"))
				.ok()?;
			write!(out, "{}\n\n---\n\n", field(comment, "body")).ok()?;
		}
	}

	Some(out)
}

fn render_listing(data: &Value) -> Option<String> {
	let children = data.pointer("/data/children")?.as_array()?;
	let posts: Vec<_> = children
		.iter()
		.take(MAX_LISTING_POSTS)
		.map(|child| child.get("data")?.as_object())
		.collect::<Option<_>>()?;
	let subreddit = posts
		.first()
		.and_then(|post| post.get("subreddit"))
		.and_then(Value::as_str)
		.filter(|name| !name.is_empty())
		.unwrap_or("Reddit");

	let mut out = format!("# r/{subreddit}\n\n");
	for post in posts {
		writeln!(
			out,
			"- **{}** ({} pts, {} comments)\n  by u/{}\n",
			field(post, "title"),
			field(post, "score"),
			field(post, "num_comments"),
			field(post, "author")
		)
		.ok()?;
	}
	Some(out)
}

#[derive(Clone, Copy)]
struct Field<'a>(Option<&'a Value>);

impl Display for Field<'_> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self.0 {
			None => formatter.write_str("undefined"),
			Some(Value::Null) => formatter.write_str("null"),
			Some(Value::Bool(value)) => Display::fmt(value, formatter),
			Some(Value::Number(value)) => {
				if let Some(number) = value.as_i64() {
					Display::fmt(&number, formatter)
				} else if let Some(number) = value.as_u64() {
					Display::fmt(&number, formatter)
				} else if let Some(number) = value.as_f64() {
					Display::fmt(&number, formatter)
				} else {
					formatter.write_str("NaN")
				}
			},
			Some(Value::String(value)) => formatter.write_str(value),
			Some(Value::Array(values)) => {
				for (index, value) in values.iter().enumerate() {
					if index != 0 {
						formatter.write_str(",")?;
					}
					if !value.is_null() {
						Field(Some(value)).fmt(formatter)?;
					}
				}
				Ok(())
			},
			Some(Value::Object(_)) => formatter.write_str("[object Object]"),
		}
	}
}

fn field<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Field<'a> {
	Field(object.get(key))
}

fn numeric_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
	object.get(key).and_then(|value| {
		value
			.as_i64()
			.or_else(|| value.as_f64().map(|number| number as i64))
	})
}

fn truthy(value: Option<&Value>) -> bool {
	match value {
		None | Some(Value::Null | Value::Bool(false)) => false,
		Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
		Some(Value::String(value)) => !value.is_empty(),
		Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
	}
}

fn iso_date(timestamp_seconds: Option<i64>) -> String {
	let Some(timestamp_seconds) = timestamp_seconds else {
		return String::new();
	};
	// Gregorian civil date from Unix days (Howard Hinnant's civil_from_days).
	let days = timestamp_seconds.div_euclid(86_400);
	let z = days + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
	let mut year = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let day = doy - (153 * mp + 2) / 5 + 1;
	let month = mp + if mp < 10 { 3 } else { -9 };
	year += i64::from(month <= 2);
	format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
	use std::future::{Future, ready};

	use bytes::Bytes;
	use parking_lot::Mutex;

	use super::*;
	use crate::read::web::types::HttpResponse;

	const SELF_POST: &str = r#"[
		{"data":{"children":[{"kind":"t3","data":{
			"title":"A self post","selftext":"First line.\n\nSecond line.",
			"author":"alice","score":42,"num_comments":12,"created_utc":1704067200,
			"subreddit":"rust","url":"https://www.reddit.com/r/rust/comments/abc/a_self_post/",
			"is_self":true
		}}]}},
		{"data":{"children":[
			{"kind":"more","data":{"count":99}},
			{"kind":"t1","data":{"body":"Useful answer.","author":"bob","score":7}},
			{"kind":"t1","data":{"body":"Another answer.","author":"carol","score":3}}
		]}}
	]"#;

	const LINK_POST: &str = r#"[
		{"data":{"children":[{"kind":"t3","data":{
			"title":"A link post","selftext":"","author":"alice","score":9,"num_comments":0,
			"created_utc":1704067200,"subreddit":"rust","url":"https://example.com/story",
			"is_self":false
		}}]}}
	]"#;

	struct FakeClient {
		requests: Mutex<Vec<HttpRequest>>,
		response: Mutex<Option<Result<HttpResponse, WebError>>>,
	}

	impl FakeClient {
		fn json(body: impl Into<Bytes>) -> Self {
			Self {
				requests: Mutex::new(Vec::new()),
				response: Mutex::new(Some(Ok(HttpResponse {
					final_url:    sf!("https://www.reddit.com/result.json"),
					status:       200,
					content_type: Some(sf!("application/json")),
					headers:      SmallVec::new(),
					body:         body.into(),
				}))),
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
					.response
					.lock()
					.take()
					.expect("unexpected second request"),
			)
		}
	}

	#[tokio::test]
	async fn post_fixture_matches_pi_metadata_selftext_comments_and_diag_order() {
		let client = FakeClient::json(Bytes::from_static(SELF_POST.as_bytes()));
		let url =
			Url::parse("https://old.reddit.com/r/rust/comments/abc/a_self_post/?sort=top").unwrap();

		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			client.requests.lock()[0].url.as_str(),
			"https://old.reddit.com/r/rust/comments/abc/a_self_post/.json?sort=top"
		);
		assert_eq!(
			result.content.as_str(),
			"# A self post\n\n**r/rust** · u/alice · 42 points · 12 \
			 comments\n*2024-01-01*\n\n---\n\nFirst line.\n\nSecond line.\n\n---\n\n## Top \
			 Comments\n\n### u/bob · 7 points\n\nUseful answer.\n\n---\n\n### u/carol · 3 \
			 points\n\nAnother answer.\n\n---"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
	}

	#[tokio::test]
	async fn external_link_fixture_matches_pi() {
		let client = FakeClient::json(Bytes::from_static(LINK_POST.as_bytes()));
		let url = Url::parse("https://www.reddit.com/comments/abc").unwrap();

		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# A link post\n\n**r/rust** · u/alice · 9 points · 0 comments\n*2024-01-01*\n\n\
			 **Link:** https://example.com/story"
		);
	}

	#[tokio::test]
	async fn share_link_uses_pi_json_url_without_resolution() {
		let client = FakeClient::json(Bytes::from_static(LINK_POST.as_bytes()));
		let url =
			Url::parse("https://share.reddit.com/r/rust/s/share-token?utm_source=share").unwrap();

		assert!(render(&client, &url).await.unwrap().is_some());
		let requests = client.requests.lock();
		assert_eq!(requests.len(), 1);
		assert_eq!(
			requests[0].url.as_str(),
			"https://share.reddit.com/r/rust/s/share-token.json?utm_source=share"
		);
	}

	#[test]
	fn listing_fixture_and_twenty_item_bound_match_pi() {
		let fixture = serde_json::json!({
			"data":{"children":[
				{"kind":"t3","data":{
					"title":"First","score":11,"num_comments":2,"author":"ada","subreddit":"rust"
				}},
				{"kind":"t3","data":{
					"title":"Second","score":7,"num_comments":4,"author":"grace","subreddit":"rust"
				}}
			]}
		});
		assert_eq!(
			render_json(&fixture).unwrap(),
			"# r/rust\n\n- **First** (11 pts, 2 comments)\n  by u/ada\n\n- **Second** (7 pts, 4 \
			 comments)\n  by u/grace\n\n"
		);

		let children: Vec<_> = (0..22)
			.map(|number| {
				serde_json::json!({"data":{
					"title":format!("Post {number}"),"score":number,"num_comments":number,
					"author":format!("user{number}"),"subreddit":"rust"
				}})
			})
			.collect();
		let rendered = render_json(&serde_json::json!({"data":{"children":children}})).unwrap();
		assert!(rendered.contains("Post 19"));
		assert!(!rendered.contains("Post 20"));
	}

	#[test]
	fn comments_filter_non_content_then_take_ten_like_pi() {
		let comments: Vec<_> = (0..12)
			.flat_map(|number| {
				[
					serde_json::json!({"kind":"more","data":{"count":1}}),
					serde_json::json!({"kind":"t1","data":{
						"body":format!("comment {number}"),
						"author":format!("user{number}"),
						"score":number
					}}),
				]
			})
			.collect();
		let data = serde_json::json!([
			{"data":{"children":[{"data":{
				"title":"Title","selftext":"","author":"poster","score":1,
				"num_comments":12,"created_utc":1704067200,"subreddit":"rust",
				"url":"https://example.com","is_self":false
			}}]}},
			{"data":{"children":comments}}
		]);

		let rendered = render_json(&data).unwrap();

		assert!(rendered.contains("comment 9"));
		assert!(!rendered.contains("comment 10"));
		assert!(!rendered.contains("count"));
		assert_eq!(rendered.matches("### u/").count(), MAX_TOP_COMMENTS);
	}

	#[tokio::test]
	async fn invalid_payload_fixtures_return_none() {
		for body in [b"not json".as_slice(), b"null", b"{}", b"[]"] {
			let client = FakeClient::json(Bytes::copy_from_slice(body));
			let url = Url::parse("https://www.reddit.com/r/rust").unwrap();
			assert!(render(&client, &url).await.unwrap().is_none());
		}
	}

	#[test]
	fn matches_pi_hostname_and_json_suffix_rules() {
		assert!(matches(&Url::parse("https://notreddit.com/path").unwrap()));
		assert!(!matches(&Url::parse("https://redd.it/abc").unwrap()));
		assert_eq!(
			json_endpoint(&Url::parse("https://reddit.com/r/rust/").unwrap()).as_str(),
			"https://reddit.com/r/rust.json"
		);
		assert_eq!(
			json_endpoint(&Url::parse("https://reddit.com/r/rust.json").unwrap()).as_str(),
			"https://reddit.com/r/rust.json.json"
		);
	}
}
