//! X and Twitter pages via Grok's hosted `x_search` tools.

use std::{borrow::Cow, ptr};

use serde_json::{Value, json};
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, str_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "twitter", open };

const PROMPT: &str = include_str!("x-read.md");
const DEFAULT_MODEL: &str = "grok-4.5";
const DEFAULT_BASE: &str = "https://api.x.ai/v1";
const METHOD: &str = "x-search";
const APP_ROUTES: &[&str] = &[
	"about",
	"account",
	"bookmarks",
	"communities",
	"compose",
	"download",
	"explore",
	"hashtag",
	"home",
	"i",
	"intent",
	"jobs",
	"login",
	"logout",
	"messages",
	"notifications",
	"privacy",
	"search",
	"settings",
	"share",
	"signup",
	"tos",
];

enum Target<'a> {
	Post(&'a str),
	Profile { handle: &'a str, filter: &'static str },
	Search { query: Cow<'a, str>, latest: bool },
	Users(Cow<'a, str>),
}

fn target(url: &Url) -> Option<Target<'_>> {
	if !matches!(url.scheme(), "http" | "https")
		|| !matches!(
			url.host_str()?,
			"x.com"
				| "twitter.com"
				| "www.x.com"
				| "www.twitter.com"
				| "mobile.x.com"
				| "mobile.twitter.com"
		) {
		return None;
	}
	let mut path = url.path_segments()?.filter(|part| !part.is_empty());
	let first = path.next()?;
	let second = path.next();
	if first == "search" {
		let mut query = None;
		let mut filter = None;
		for (key, value) in url.query_pairs() {
			match key.as_ref() {
				"q" if query.is_none() => query = Some(value),
				"f" if filter.is_none() => filter = Some(value),
				_ => (),
			}
			if query.is_some() && filter.is_some() {
				break;
			}
		}
		let query = query.filter(|q| !q.trim().is_empty())?;
		return Some(match filter.as_deref() {
			Some("user") => Target::Users(query),
			Some("media") => {
				Target::Search { query: format!("{} filter:media", query.trim()).into(), latest: true }
			},
			filter => Target::Search { query, latest: filter == Some("live") },
		});
	}
	if first == "hashtag"
		&& let Some(tag) = second
	{
		let latest = url
			.query_pairs()
			.find(|(key, _)| key == "f")
			.is_some_and(|(_, f)| f == "live");
		return Some(Target::Search { query: format!("#{tag}").into(), latest });
	}

	// `<handle>/status/<id>[/photo/1]`, `i/status/<id>`, or `i/web/status/<id>`.
	let status = if first == "i" && second == Some("web") {
		path.next()
	} else {
		second
	};
	if status == Some("status") {
		let id = path.next()?;
		return (id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()))
			.then_some(Target::Post(id));
	}
	if first.len() > 15
		|| !first
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || b == b'_')
		|| APP_ROUTES
			.iter()
			.any(|route| route.eq_ignore_ascii_case(first))
		|| path.next().is_some()
	{
		return None;
	}
	let filter = match second {
		None => " -filter:replies",
		Some("with_replies") => "",
		Some("media") => " filter:media",
		_ => return None,
	};
	Some(Target::Profile { handle: first, filter })
}

/// Expand the copied template's standalone conditionals and JSON string
/// helpers.
fn system_prompt(target: &Target<'_>) -> Option<String> {
	let profile_query;
	let (block, fields) = match target {
		Target::Post(id) => ("post", [Some(("id", *id)), None]),
		Target::Profile { handle, filter } => {
			profile_query = format!("from:{handle}{filter}");
			("profile", [Some(("handle", *handle)), Some(("query", profile_query.as_str()))])
		},
		Target::Search { query, latest } => ("search", [
			Some(("query", query.trim())),
			Some(("mode", if *latest { "Latest" } else { "Top" })),
		]),
		Target::Users(query) => ("users", [Some(("query", query.trim())), None]),
	};
	let mut out = String::with_capacity(PROMPT.len());
	let mut enabled = true;
	for line in PROMPT.split_inclusive('\n') {
		let marker = line.trim_end();
		if let Some(condition) = marker
			.strip_prefix("{{#if ")
			.and_then(|s| s.strip_suffix("}}"))
		{
			enabled = condition == block;
		} else if marker == "{{/if}}" {
			enabled = true;
		} else if enabled {
			let mut rest = line;
			while let Some((literal, helper)) = rest.split_once("{{jsonStringify ") {
				out.push_str(literal);
				let (key, tail) = helper.split_once("}}")?;
				let (_, value) = fields.iter().flatten().find(|(field, _)| *field == key)?;
				out.push_str(&serde_json::to_string(value).ok()?);
				rest = tail;
			}
			out.push_str(rest);
		}
	}
	out.truncate(out.trim_end().len());
	Some(out)
}

fn model(context: &Context) -> &str {
	context.setting("x.model").unwrap_or(DEFAULT_MODEL)
}

fn open(url: &Url, context: &Context) -> Option<Action> {
	let target = target(url)?;
	let key = context.credential("x")?;
	let base = context.setting("x.baseUrl").unwrap_or(DEFAULT_BASE);
	let tool = match &target {
		Target::Profile { handle, .. } => {
			json!({ "type": "x_search", "allowed_x_handles": [handle] })
		},
		_ => json!({ "type": "x_search" }),
	};
	let body = json!({
		"model": model(context),
		"input": [
			{ "role": "system", "content": system_prompt(&target)? },
			{ "role": "user", "content": url.as_str() },
		],
		"tools": [tool],
		"max_turns": 2,
		"reasoning": { "effort": "low" },
	});
	let mut request = Fetch::post_json(format!("{}/responses", base.trim_end_matches('/')), &body)
		.bearer(Some(key));
	for (name, value) in context.settings_with_prefix("x.header.") {
		if name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("content-type") {
			continue;
		}
		if name.eq_ignore_ascii_case("accept") {
			request
				.headers
				.retain(|(k, _)| !k.eq_ignore_ascii_case("accept"));
		}
		request = request.header(name, value);
	}
	fetch(request, |reply, context| {
		if reply.truncated || !reply.ok() {
			return None;
		}
		let data = reply.json_value()?;
		let content = answer(&data)?;
		let usage = data.pointer("/usage/server_side_tool_usage_details");
		let count = |key| {
			usage
				.and_then(|usage| u64_of(usage, key))
				.unwrap_or_default()
		};
		let provider = context.setting("x.provider").unwrap_or("xai");
		Done::new(content, METHOD)
			.note(format!(
				"Read by {provider}/{} via x_search ({} posts, {} profiles fetched); the model relays \
				 the text",
				model(context),
				count("x_posts_fetched"),
				count("x_users_fetched"),
			))
			.finish()
	})
}

fn texts(message: &Value) -> impl Iterator<Item = &str> {
	arr_of(message, "content").iter().filter_map(|part| {
		part
			.get("output_text")
			.filter(|value| !value.is_null())
			.or_else(|| part.get("text"))?
			.as_str()
			.map(str::trim)
			.filter(|text| !text.is_empty())
	})
}

fn phase(message: &Value) -> Option<&str> {
	message
		.get("phase")?
		.as_str()
		.filter(|phase| matches!(*phase, "commentary" | "final_answer"))
}

fn cited(message: &Value) -> bool {
	fn has_citation(value: &Value) -> bool {
		arr_of(value, "annotations").iter().any(|annotation| {
			annotation.get("type").and_then(Value::as_str) == Some("url_citation")
				&& str_of(annotation, "url").is_some()
		})
	}
	has_citation(message) || arr_of(message, "content").iter().any(has_citation)
}

/// Keep the final answer, not the hosted tool's relay narration.
fn answer(response: &Value) -> Option<String> {
	let messages = arr_of(response, "output").iter().filter(|item| {
		match item.get("type").filter(|kind| !kind.is_null()) {
			Some(kind) => kind.as_str() == Some("message"),
			None => item.get("content").is_some_and(Value::is_array),
		}
	});
	let Some(last) = messages.clone().next_back() else {
		return str_of(response, "output_text").map(str::to_owned);
	};
	let phased = messages
		.clone()
		.any(|item| phase(item) == Some("final_answer"));
	if !phased && phase(last) != Some("commentary") && texts(last).next().is_none() {
		return None;
	}

	let mut out = String::new();
	for item in messages {
		let phase = phase(item);
		let keep = if phased {
			phase == Some("final_answer")
		} else {
			phase.is_none()
				&& (ptr::eq(item, last)
					|| cited(item)
					|| texts(item)
						.map(|text| text.encode_utf16().count())
						.sum::<usize>()
						>= 300)
		};
		if keep {
			for text in texts(item) {
				if !out.is_empty() {
					out.push('\n');
				}
				out.push_str(text);
			}
		}
	}
	(!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
	use super::{
		super::{
			Fetched,
			testing::{run, run_with},
		},
		*,
	};

	#[test]
	fn a_profile_sends_a_handle_scoped_responses_request_and_keeps_only_the_final_answer() {
		let url = "https://mobile.twitter.com/Jack/media";
		let done = run_with(
			url,
			|setup| {
				setup.credentials.push(("x".into(), "test-key".into()));
				setup.settings.extend([
					("x.model".into(), "grok-search".into()),
					("x.baseUrl".into(), "https://x-api.test/v1/".into()),
					("x.header.X-Project".into(), "reader".into()),
				]);
			},
			|request| {
				assert_eq!(
					(request.method, request.url.as_str()),
					("POST", "https://x-api.test/v1/responses")
				);
				for (name, expected) in [
					("authorization", "Bearer test-key"),
					("content-type", "application/json"),
					("x-project", "reader"),
				] {
					assert!(
						request
							.headers
							.iter()
							.any(|(k, v)| k.eq_ignore_ascii_case(name) && v == expected)
					);
				}
				let mut body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
				let prompt = body["input"][0]["content"].take();
				let prompt = prompt.as_str().unwrap();
				assert!(prompt.contains("`x_user_search` with `{\"query\": \"Jack\", \"count\": 1}`"));
				assert!(prompt.contains(
					"`x_keyword_search` with `{\"query\": \"from:Jack filter:media\", \"mode\": \
					 \"Latest\", \"limit\": 10}`"
				));
				assert!(!prompt.contains("x_thread_fetch") && !prompt.contains("{{"));
				assert_eq!(
					body,
					json!({
						"model": "grok-search",
						"input": [{ "role": "system", "content": null }, { "role": "user", "content": url }],
						"tools": [{ "type": "x_search", "allowed_x_handles": ["Jack"] }],
						"max_turns": 2,
						"reasoning": { "effort": "low" },
					})
				);
				Fetched::json(&json!({
					"output_text": "I am searching.\n## Profile\nJack",
					"output": [
						{ "type": "message", "phase": "commentary", "content": [{ "text": "I am searching." }] },
						{ "type": "message", "phase": "final_answer", "content": [{ "text": "## Profile\nJack" }] },
					],
					"usage": { "server_side_tool_usage_details": { "x_posts_fetched": 3, "x_users_fetched": 1 } },
				}))
			},
		)
		.unwrap();
		assert_eq!(done.method, "x-search");
		assert_eq!(done.markdown, "## Profile\nJack");
		assert_eq!(done.notes, ["Read by xai/grok-search via x_search (3 posts, 1 profiles \
		                         fetched); the model relays the text"]);
	}

	#[test]
	fn a_search_json_quotes_the_query_and_an_empty_final_answer_declines() {
		assert_eq!(
			run_with(
				"https://x.com/search?q=hello+%22world%22&f=live",
				|setup| {
					setup.credentials.push(("x".into(), "key".into()));
				},
				|request| {
					let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
					let prompt = body["input"][0]["content"].as_str().unwrap();
					assert!(
						prompt.contains(r#"{"query": "hello \"world\"", "mode": "Latest", "limit": 10}"#)
					);
					assert_eq!(body["tools"], json!([{ "type": "x_search" }]));
					Fetched::json(&json!({
						"output_text": "I am searching.",
						"output": [{ "type": "message", "phase": "final_answer", "content": [] }],
					}))
				}
			),
			None
		);
	}

	#[test]
	fn unsupported_routes_and_credentialless_reads_do_not_fetch() {
		assert_eq!(run("https://x.com/i/web/status/20", |_| panic!("no credential")), None);
		for url in
			["https://api.x.com/jack", "https://x.com/Settings", "https://x.com/jack/followers"]
		{
			assert_eq!(
				run_with(
					url,
					|setup| {
						setup.credentials.push(("x".into(), "key".into()));
					},
					|_| panic!("not an X tool target")
				),
				None
			);
		}
	}
}
