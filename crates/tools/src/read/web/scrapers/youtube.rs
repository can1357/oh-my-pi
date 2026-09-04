//! Anonymous `YouTube` metadata and transcript renderer.

#[cfg(test)]
use omp_tool::Severity;
use omp_tool::{Diag, DiagKind};
use serde_json::Value;
use url::Url;

use super::utils::{decode_html_entities, format_media_duration};
use crate::read::web::types::{HttpClient, HttpRequest, MAX_BYTES, RenderResult, WebError};

const VIDEO_ID_LEN: usize = 11;

struct Target {
	video_id: String,
}

#[derive(Default)]
struct Metadata {
	title:       String,
	channel:     String,
	description: String,
	duration:    u64,
	upload_date: String,
	view_count:  u64,
}

#[derive(Clone, Copy)]
enum TranscriptKind {
	Manual,
	Automatic,
}

struct Transcript {
	kind: TranscriptKind,
	text: String,
}

pub(super) fn matches(url: &Url) -> bool {
	parse(url).is_some()
}

pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse(url) else {
		return Ok(None);
	};
	let video_url = format!("https://www.youtube.com/watch?v={}", target.video_id);
	let mut metadata = Metadata { title: "YouTube Video".to_owned(), ..Metadata::default() };
	let mut caption_tracks = Vec::new();

	if let Ok(response) = client
		.get(request(video_url.clone(), MAX_BYTES, "text/html,application/xhtml+xml"))
		.await
		&& response.is_success()
	{
		let page = response.text();
		if let Some(player) = player_response_value(&page) {
			metadata_from_player(&player, &mut metadata);
			caption_tracks = caption_tracks_from_player(&player);
		}
		metadata_from_page(&page, &mut metadata);
	}

	let mut diags = Vec::new();

	let transcript = fetch_transcript(client, &caption_tracks).await;
	match transcript.as_ref().map(|value| value.kind) {
		Some(TranscriptKind::Manual) => {
			diags.push(Diag::info(DiagKind::Provenance, "Using manual subtitles"));
		},
		Some(TranscriptKind::Automatic) => {
			diags.push(Diag::info(DiagKind::Provenance, "Using auto-generated captions"));
		},
		None => diags.push(Diag::warn(DiagKind::Fallback, "No subtitles or captions were available")),
	}

	let content = render_markdown(&target.video_id, &metadata, transcript.as_ref());
	let mut result = RenderResult::markdown(&content, "youtube");
	result.diags.extend(diags);
	Ok(Some(result))
}

fn parse(url: &Url) -> Option<Target> {
	let host = url
		.host_str()?
		.strip_prefix("www.")
		.unwrap_or(url.host_str()?);
	let id = match host {
		"youtube.com" | "m.youtube.com" => {
			if url.path() == "/watch" {
				url.query_pairs()
					.find_map(|(key, value)| (key == "v").then(|| value.into_owned()))?
			} else {
				let mut parts = url.path_segments()?;
				match parts.next()? {
					"shorts" | "v" | "embed" => parts.next()?.to_owned(),
					_ => return None,
				}
			}
		},
		"youtu.be" => url.path_segments()?.next()?.to_owned(),
		_ => return None,
	};
	valid_video_id(&id).then_some(Target { video_id: id })
}

fn valid_video_id(value: &str) -> bool {
	value.len() == VIDEO_ID_LEN
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn request(url: String, max_bytes: usize, accept: &'static str) -> HttpRequest {
	HttpRequest::new(url)
		.with_header("Accept", accept)
		.with_max_bytes(max_bytes)
}

fn player_response_value(page: &str) -> Option<Value> {
	const MARKERS: [&str; 4] = [
		"ytInitialPlayerResponse =",
		"var ytInitialPlayerResponse =",
		"window[\"ytInitialPlayerResponse\"] =",
		"\"ytInitialPlayerResponse\":",
	];
	MARKERS
		.iter()
		.filter_map(|marker| extract_json_after(page, marker))
		.find_map(|json| serde_json::from_str(json).ok())
}

fn extract_json_after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
	let tail = &text[text.find(marker)? + marker.len()..];
	let trimmed = tail.trim_start();
	let start = tail.len().checked_sub(trimmed.len())?;
	if trimmed.as_bytes().first() != Some(&b'{') {
		return None;
	}
	let bytes = tail.as_bytes();
	let mut depth = 0_u32;
	let mut quoted = false;
	let mut escaped = false;
	for (index, &byte) in bytes.iter().enumerate().skip(start) {
		if quoted {
			if escaped {
				escaped = false;
			} else if byte == b'\\' {
				escaped = true;
			} else if byte == b'"' {
				quoted = false;
			}
			continue;
		}
		match byte {
			b'"' => quoted = true,
			b'{' => depth += 1,
			b'}' => {
				depth = depth.checked_sub(1)?;
				if depth == 0 {
					return Some(&tail[start..=index]);
				}
			},
			_ => {},
		}
	}
	None
}

fn metadata_from_player(player: &Value, metadata: &mut Metadata) {
	let details = &player["videoDetails"];
	let microformat = &player["microformat"]["playerMicroformatRenderer"];
	if let Some(value) = string_at(details, "title").or_else(|| string_at(microformat, "title")) {
		metadata.title.clear();
		metadata.title.push_str(value);
	}
	if let Some(value) =
		string_at(details, "author").or_else(|| string_at(microformat, "ownerChannelName"))
	{
		metadata.channel.clear();
		metadata.channel.push_str(value);
	}
	if let Some(value) =
		string_at(details, "shortDescription").or_else(|| string_at(microformat, "description"))
	{
		metadata.description.clear();
		metadata.description.push_str(value);
	}
	metadata.duration = unsigned_at(details, "lengthSeconds")
		.or_else(|| unsigned_at(microformat, "lengthSeconds"))
		.unwrap_or(0);
	metadata.view_count = unsigned_at(details, "viewCount")
		.or_else(|| unsigned_at(microformat, "viewCount"))
		.unwrap_or(0);
	if let Some(value) =
		string_at(microformat, "publishDate").or_else(|| string_at(microformat, "uploadDate"))
	{
		metadata.upload_date = format_upload_date(value);
	}
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value[key].as_str().filter(|value| !value.is_empty())
}

fn unsigned_at(value: &Value, key: &str) -> Option<u64> {
	value[key]
		.as_u64()
		.or_else(|| value[key].as_str().and_then(|value| value.parse().ok()))
}

fn format_upload_date(value: &str) -> String {
	if value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_digit()) {
		format!("{}-{}-{}", &value[..4], &value[4..6], &value[6..])
	} else {
		value.to_owned()
	}
}

fn metadata_from_page(page: &str, metadata: &mut Metadata) {
	if metadata.title == "YouTube Video"
		&& let Some(value) = meta_content(page, "name", "title")
			.or_else(|| meta_content(page, "property", "og:title"))
			.or_else(|| meta_content(page, "itemprop", "name"))
	{
		metadata.title = value;
	}
	if metadata.channel.is_empty()
		&& let Some(value) = author_content(page)
			.or_else(|| meta_content(page, "itemprop", "author"))
			.or_else(|| meta_content(page, "name", "author"))
	{
		metadata.channel = value;
	}
	if metadata.description.is_empty()
		&& let Some(value) = meta_content(page, "property", "og:description")
			.or_else(|| meta_content(page, "name", "description"))
			.or_else(|| meta_content(page, "itemprop", "description"))
	{
		metadata.description = value;
	}
	if metadata.duration == 0
		&& let Some(value) = meta_content(page, "itemprop", "duration")
		&& let Some(seconds) = parse_iso_duration(&value)
	{
		metadata.duration = seconds;
	}
	if metadata.upload_date.is_empty()
		&& let Some(value) = meta_content(page, "itemprop", "datePublished")
			.or_else(|| meta_content(page, "itemprop", "uploadDate"))
	{
		metadata.upload_date = format_upload_date(&value);
	}
	if metadata.view_count == 0
		&& let Some(value) = meta_content(page, "itemprop", "interactionCount")
		&& let Ok(count) = value.parse()
	{
		metadata.view_count = count;
	}
}

fn author_content(page: &str) -> Option<String> {
	for marker in ["itemprop=\"author\"", "itemprop='author'"] {
		let Some(start) = page.find(marker) else {
			continue;
		};
		let tail = &page[start + marker.len()..];
		let author_scope = &tail[..tail.find("</span>").unwrap_or(tail.len())];
		if let Some(value) = meta_content(author_scope, "itemprop", "name") {
			return Some(value);
		}
	}
	None
}

fn meta_content(page: &str, attribute: &str, expected: &str) -> Option<String> {
	for tag in page
		.split('<')
		.filter_map(|tail| tail.split_once('>').map(|(tag, _)| tag))
	{
		let tag = tag.trim_start();
		if !(tag.starts_with("meta ") || tag.starts_with("link ")) {
			continue;
		}
		let attributes = html_attributes(tag);
		if attributes
			.iter()
			.any(|(name, value)| name.eq_ignore_ascii_case(attribute) && value == expected)
			&& let Some((_, content)) = attributes
				.iter()
				.find(|(name, _)| name.eq_ignore_ascii_case("content"))
		{
			return Some(decode_html_entities(content).to_string());
		}
	}
	None
}

fn html_attributes(tag: &str) -> Vec<(String, String)> {
	let mut attributes = Vec::new();
	let mut rest = tag.trim_start_matches(|character: char| !character.is_ascii_whitespace());
	while !rest.is_empty() {
		rest = rest.trim_start();
		let Some(equals) = rest.find('=') else {
			break;
		};
		let name = rest[..equals].trim();
		rest = &rest[equals + 1..];
		let Some(quote) = rest.as_bytes().first().copied() else {
			break;
		};
		if quote != b'"' && quote != b'\'' {
			let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
			attributes.push((name.to_owned(), rest[..end].to_owned()));
			rest = &rest[end..];
			continue;
		}
		rest = &rest[1..];
		let Some(end) = rest.find(quote as char) else {
			break;
		};
		attributes.push((name.to_owned(), rest[..end].to_owned()));
		rest = &rest[end + 1..];
	}
	attributes
}

fn parse_iso_duration(value: &str) -> Option<u64> {
	let value = value.strip_prefix("PT")?;
	let mut total = 0_u64;
	let mut digits = String::new();
	for character in value.chars() {
		if character.is_ascii_digit() {
			digits.push(character);
			continue;
		}
		let amount = digits.parse::<u64>().ok()?;
		digits.clear();
		total = total.checked_add(match character {
			'H' => amount.checked_mul(3600)?,
			'M' => amount.checked_mul(60)?,
			'S' => amount,
			_ => return None,
		})?;
	}
	digits.is_empty().then_some(total)
}

fn caption_tracks_from_player(player: &Value) -> Vec<CaptionTrack> {
	player["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
		.as_array()
		.into_iter()
		.flatten()
		.filter_map(|track| {
			let language = track["languageCode"].as_str()?;
			if language != "en" && !language.starts_with("en-") {
				return None;
			}
			Some(CaptionTrack {
				url:       track["baseUrl"].as_str()?.to_owned(),
				language:  language.to_owned(),
				automatic: track["kind"].as_str() == Some("asr"),
			})
		})
		.collect()
}

struct CaptionTrack {
	url:       String,
	language:  String,
	automatic: bool,
}

async fn fetch_transcript<C: HttpClient + Sync>(
	client: &C,
	tracks: &[CaptionTrack],
) -> Option<Transcript> {
	let mut ordered: Vec<&CaptionTrack> = tracks.iter().collect();
	ordered.sort_by_key(|track| (track.automatic, language_rank(&track.language)));
	for track in ordered {
		let separator = if track.url.contains('?') { '&' } else { '?' };
		let endpoint = format!("{}{separator}fmt=json3", track.url);
		let Ok(response) = client
			.get(request(endpoint, MAX_BYTES, "application/json,text/vtt,text/plain"))
			.await
		else {
			continue;
		};
		if !(200..300).contains(&response.status) {
			continue;
		}
		let body = response.text();
		let text = transcript_text(&body);
		if !text.is_empty() {
			return Some(Transcript {
				kind: if track.automatic {
					TranscriptKind::Automatic
				} else {
					TranscriptKind::Manual
				},
				text,
			});
		}
	}
	None
}

fn language_rank(language: &str) -> u8 {
	match language {
		"en" => 0,
		"en-US" => 1,
		"en-GB" => 2,
		_ => 3,
	}
}

fn transcript_text(body: &str) -> String {
	let json = json_transcript(body);
	if !json.is_empty() {
		return json;
	}
	clean_vtt_to_text(body)
}

fn json_transcript(json: &str) -> String {
	let Ok(root) = serde_json::from_str::<Value>(json) else {
		return String::new();
	};
	let mut lines = Vec::new();
	let mut last = String::new();
	for event in root["events"].as_array().into_iter().flatten() {
		let Some(segments) = event["segs"].as_array() else {
			continue;
		};
		let text = segments
			.iter()
			.filter_map(|segment| segment["utf8"].as_str())
			.collect::<String>();
		let cleaned = normalize_whitespace(&text);
		if cleaned.is_empty() || cleaned == last {
			continue;
		}
		lines.push(cleaned.clone());
		last = cleaned;
	}
	lines.join(" ")
}

fn clean_vtt_to_text(vtt: &str) -> String {
	let mut lines = Vec::new();
	let mut last = String::new();
	for line in vtt.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty()
			|| trimmed.starts_with("WEBVTT")
			|| trimmed.starts_with("Kind:")
			|| trimmed.starts_with("Language:")
			|| trimmed.contains("-->")
			|| trimmed.bytes().all(|byte| byte.is_ascii_digit())
			|| looks_like_uuid(trimmed)
			|| looks_like_timestamp(trimmed)
		{
			continue;
		}
		let cleaned = normalize_whitespace(&strip_vtt_tags(trimmed));
		if !cleaned.is_empty() && cleaned != last {
			lines.push(cleaned.clone());
			last = cleaned;
		}
	}
	lines.join(" ")
}

const fn looks_like_timestamp(value: &str) -> bool {
	let bytes = value.as_bytes();
	bytes.len() >= 5
		&& bytes[0].is_ascii_digit()
		&& bytes[1].is_ascii_digit()
		&& bytes[2] == b':'
		&& bytes[3].is_ascii_digit()
		&& bytes[4].is_ascii_digit()
}

fn looks_like_uuid(value: &str) -> bool {
	value.len() == 36
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f' | b'-'))
}

fn strip_vtt_tags(value: &str) -> String {
	let mut output = String::with_capacity(value.len());
	let mut in_tag = false;
	for character in value.chars() {
		match character {
			'<' => in_tag = true,
			'>' if in_tag => in_tag = false,
			_ if !in_tag => output.push(character),
			_ => {},
		}
	}
	output
}
fn normalize_whitespace(value: &str) -> String {
	let mut output = String::with_capacity(value.len());
	for word in value.split_whitespace() {
		if !output.is_empty() {
			output.push(' ');
		}
		output.push_str(word);
	}
	output
}

fn render_markdown(video_id: &str, metadata: &Metadata, transcript: Option<&Transcript>) -> String {
	let mut output = String::with_capacity(
		metadata.title.len()
			+ metadata.channel.len()
			+ metadata.upload_date.len()
			+ metadata.description.len().min(1000)
			+ transcript.map_or(0, |transcript| transcript.text.len())
			+ 200,
	);
	output.push_str("# ");
	output.push_str(&metadata.title);
	output.push_str("\n\n");
	if !metadata.channel.is_empty() {
		output.push_str("**Channel:** ");
		output.push_str(&metadata.channel);
		output.push('\n');
	}
	if !metadata.upload_date.is_empty() {
		output.push_str("**Uploaded:** ");
		output.push_str(&metadata.upload_date);
		output.push('\n');
	}
	if metadata.duration > 0 {
		output.push_str("**Duration:** ");
		output.push_str(&format_media_duration(metadata.duration));
		output.push('\n');
	}
	if metadata.view_count > 0 {
		output.push_str("**Views:** ");
		output.push_str(&format_compact_number(metadata.view_count));
		output.push('\n');
	}
	output.push_str("**Video ID:** ");
	output.push_str(video_id);
	output.push_str("\n\n");

	if !metadata.description.is_empty() {
		output.push_str("---\n\n## Description\n\n");
		output.push_str(&truncate_chars(&metadata.description, 1000));
		output.push_str("\n\n");
	}
	if let Some(transcript) = transcript {
		let source = match transcript.kind {
			TranscriptKind::Manual => "manual",
			TranscriptKind::Automatic => "auto-generated",
		};
		output.push_str("---\n\n## Transcript (");
		output.push_str(source);
		output.push_str(")\n\n");
		output.push_str(&transcript.text);
		output.push('\n');
	} else {
		output.push_str("---\n\n*No transcript available for this video.*\n");
	}
	output
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
	let Some((end, _)) = value.char_indices().nth(max_chars) else {
		return value.to_owned();
	};
	format!("{}…", &value[..end])
}
fn format_compact_number(value: u64) -> String {
	match value {
		0..=999 => value.to_string(),
		1_000..=9_999 => format_tenths(value, 100, "K"),
		10_000..=999_999 => format!("{}K", value.saturating_add(500) / 1_000),
		1_000_000..=9_999_999 => format_tenths(value, 100_000, "M"),
		10_000_000..=999_999_999 => {
			format!("{}M", value.saturating_add(500_000) / 1_000_000)
		},
		1_000_000_000..=9_999_999_999 => format_tenths(value, 100_000_000, "B"),
		_ => format!("{}B", value.saturating_add(500_000_000) / 1_000_000_000),
	}
}

fn format_tenths(value: u64, divisor: u64, suffix: &str) -> String {
	let tenths = value.saturating_add(divisor / 2) / divisor;
	if tenths.is_multiple_of(10) {
		format!("{}{suffix}", tenths / 10)
	} else {
		format!("{}.{:01}{suffix}", tenths / 10, tenths % 10)
	}
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
	use crate::read::web::types::HttpResponse;

	const VIDEO_ID: &str = "dQw4w9WgXcQ";
	const PLAYER_PAGE: &str = r#"<script>var ytInitialPlayerResponse = {
		"videoDetails":{
			"title":"Player Title",
			"author":"Example Channel",
			"shortDescription":"A useful description.",
			"lengthSeconds":"122",
			"viewCount":"1234567"
		},
		"microformat":{"playerMicroformatRenderer":{"publishDate":"20250102"}},
		"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[
			{"baseUrl":"https://captions.test/automatic","languageCode":"en","kind":"asr"},
			{"baseUrl":"https://captions.test/manual-gb","languageCode":"en-GB"},
			{"baseUrl":"https://captions.test/manual","languageCode":"en"}
		]}}
	};</script>"#;
	const MANUAL_VTT: &str = "WEBVTT\nKind: captions\nLanguage: en\n\n1\n00:00:00.000 --> \
	                          00:00:02.000\n<c>Hello</c> world\n\n2\n00:00:02.000 --> \
	                          00:00:04.000\nHello world\n\n3\n00:00:04.000 --> 00:00:06.000\nNext \
	                          <00:00:05.000>line";

	enum Reply {
		Body(&'static str, &'static str),
		Status(u16, &'static str),
		Error(&'static str),
	}

	struct FakeClient {
		replies:  Mutex<VecDeque<Reply>>,
		requests: Mutex<Vec<HttpRequest>>,
	}

	impl FakeClient {
		fn new(replies: impl IntoIterator<Item = Reply>) -> Self {
			Self {
				replies:  Mutex::new(replies.into_iter().collect()),
				requests: Mutex::new(Vec::new()),
			}
		}
	}

	impl HttpClient for FakeClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			let reply = self.replies.lock().pop_front().expect("unexpected request");
			let final_url = request.url.clone();
			self.requests.lock().push(request);
			ready(match reply {
				Reply::Body(content_type, body) => Ok(HttpResponse {
					final_url,
					status: 200,
					content_type: Some(content_type.into()),
					headers: SmallVec::new(),
					body: Bytes::from_static(body.as_bytes()),
				}),
				Reply::Status(status, body) => Ok(HttpResponse {
					final_url,
					status,
					content_type: Some("text/plain".into()),
					headers: SmallVec::new(),
					body: Bytes::from_static(body.as_bytes()),
				}),
				Reply::Error(message) => Err(WebError::request(message)),
			})
		}
	}

	#[test]
	fn canonical_mobile_short_youtu_be_and_embed_forms_share_video_id() {
		for value in [
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx",
			"https://m.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://youtube.com/shorts/dQw4w9WgXcQ?feature=share",
			"https://youtu.be/dQw4w9WgXcQ?t=42",
			"https://youtube.com/v/dQw4w9WgXcQ",
			"https://youtube.com/embed/dQw4w9WgXcQ",
		] {
			let url = Url::parse(value).unwrap();
			assert_eq!(parse(&url).unwrap().video_id, VIDEO_ID);
		}
		for value in [
			"https://youtube.com/watch?v=too-short",
			"https://youtu.be/dQw4w9WgXc!",
			"https://youtube.com/channel/dQw4w9WgXcQ",
			"https://example.com/watch?v=dQw4w9WgXcQ",
		] {
			assert!(parse(&Url::parse(value).unwrap()).is_none());
		}
	}

	#[tokio::test]
	async fn video_player_metadata_and_manual_transcript_match_pi_output() {
		let client = FakeClient::new([
			Reply::Body("text/html", PLAYER_PAGE),
			Reply::Body("text/vtt", MANUAL_VTT),
		]);
		let url = Url::parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# Player Title\n\n**Channel:** Example Channel\n**Uploaded:** 2025-01-02\n**Duration:** \
			 2:02\n**Views:** 1.2M\n**Video ID:** dQw4w9WgXcQ\n\n---\n\n## Description\n\nA useful \
			 description.\n\n---\n\n## Transcript (manual)\n\nHello world Next line"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		assert_eq!(result.method.as_str(), "youtube");
		assert_eq!(result.content_type.as_deref(), Some("text/markdown"));

		let requests = client.requests.lock();
		assert_eq!(requests.len(), 2);
		assert_eq!(requests[0].url.as_str(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		assert_eq!(requests[0].max_bytes, MAX_BYTES);
		assert_eq!(requests[1].url.as_str(), "https://captions.test/manual?fmt=json3");
		assert_eq!(requests[1].max_bytes, MAX_BYTES);
	}

	#[tokio::test]
	async fn shorts_compact_page_metadata_has_exact_no_transcript_output() {
		const PAGE: &str = r#"<html><head>
			<meta itemprop="name" content="A &amp; B">
			<span itemprop="author"><link itemprop="name" content="Shorts Channel"></span>
			<meta itemprop="description" content="Compact fallback.">
			<meta itemprop="duration" content="PT1M5S">
			<meta itemprop="uploadDate" content="2024-06-03">
			<meta itemprop="interactionCount" content="12500">
		</head></html>"#;
		let client = FakeClient::new([Reply::Body("text/html", PAGE)]);
		let url = Url::parse("https://youtube.com/shorts/dQw4w9WgXcQ").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# A & B\n\n**Channel:** Shorts Channel\n**Uploaded:** 2024-06-03\n**Duration:** \
			 1:05\n**Views:** 13K\n**Video ID:** dQw4w9WgXcQ\n\n---\n\n## Description\n\nCompact \
			 fallback.\n\n---\n\n*No transcript available for this video.*"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Fallback));
		assert_eq!(result.diags[0].severity, Severity::Warn);
	}

	#[tokio::test]
	async fn embed_uses_compact_watch_metadata_with_exact_output() {
		const PAGE: &str = r#"<meta name="title" content="Embedded Video">
			<meta name="author" content="Embed Channel">"#;
		let client = FakeClient::new([Reply::Body("text/html", PAGE)]);
		let url = Url::parse("https://youtube.com/embed/dQw4w9WgXcQ").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# Embedded Video\n\n**Channel:** Embed Channel\n**Video ID:** dQw4w9WgXcQ\n\n---\n\n*No \
			 transcript available for this video.*"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Fallback));
		assert_eq!(result.diags[0].severity, Severity::Warn);
		let requests = client.requests.lock();
		assert_eq!(requests.len(), 1);
		assert_eq!(requests[0].url.as_str(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	}

	#[tokio::test]
	async fn automatic_json_transcript_is_selected_after_failed_manual_tracks() {
		const PAGE: &str = r#"ytInitialPlayerResponse = {
			"videoDetails":{"title":"Captioned","author":"Channel"},
			"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[
				{"baseUrl":"https://captions.test/manual","languageCode":"en"},
				{"baseUrl":"https://captions.test/automatic","languageCode":"en","kind":"asr"}
			]}}
		};"#;
		const JSON3: &str = r#"{"events":[
			{"segs":[{"utf8":"first "},{"utf8":"line"}]},
			{"segs":[{"utf8":"first line"}]},
			{"segs":[{"utf8":"second\nline"}]}
		]}"#;
		let client = FakeClient::new([
			Reply::Body("text/html", PAGE),
			Reply::Status(404, ""),
			Reply::Body("application/json", JSON3),
		]);
		let url = Url::parse("https://youtu.be/dQw4w9WgXcQ").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# Captioned\n\n**Channel:** Channel\n**Video ID:** dQw4w9WgXcQ\n\n---\n\n## Transcript \
			 (auto-generated)\n\nfirst line second line"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
	}

	#[tokio::test]
	async fn malformed_page_returns_stable_partial_result() {
		let client = FakeClient::new([Reply::Body(
			"text/html",
			"<script>ytInitialPlayerResponse = {not json</script>",
		)]);
		let url = Url::parse("https://m.youtube.com/watch?v=dQw4w9WgXcQ").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# YouTube Video\n\n**Video ID:** dQw4w9WgXcQ\n\n---\n\n*No transcript available for \
			 this video.*"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Fallback));
		assert_eq!(result.diags[0].severity, Severity::Warn);
	}

	#[tokio::test]
	async fn watch_transport_failure_returns_stable_partial_result() {
		let client = FakeClient::new([Reply::Error("offline")]);
		let url = Url::parse("https://youtu.be/dQw4w9WgXcQ").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();
		assert_eq!(
			result.content.as_str(),
			"# YouTube Video\n\n**Video ID:** dQw4w9WgXcQ\n\n---\n\n*No transcript available for \
			 this video.*"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Fallback));
		assert_eq!(result.diags[0].severity, Severity::Warn);
	}
	#[tokio::test]
	async fn unsupported_url_is_not_claimed_or_fetched() {
		let client = FakeClient::new([]);
		let url = Url::parse("https://example.com/watch?v=dQw4w9WgXcQ").unwrap();
		assert!(render(&client, &url).await.unwrap().is_none());
		assert!(client.requests.lock().is_empty());
	}

	#[test]
	fn metadata_and_output_caps_are_unicode_safe() {
		let description = "🦀".repeat(1_001);
		let metadata = Metadata { title: "Cap".to_owned(), description, ..Metadata::default() };
		let markdown = render_markdown(VIDEO_ID, &metadata, None);
		let preview = markdown
			.split("## Description\n\n")
			.nth(1)
			.unwrap()
			.split("\n\n---")
			.next()
			.unwrap();
		assert_eq!(preview.chars().count(), 1_001);
		assert!(preview.ends_with('…'));
		assert_eq!(format_compact_number(999), "999");
		assert_eq!(format_compact_number(1_250), "1.3K");
		assert_eq!(format_compact_number(12_500), "13K");
	}

	#[test]
	fn extracts_balanced_player_json_and_rejects_malformed_json() {
		let page = r#"before ytInitialPlayerResponse = {"videoDetails":{"title":"a } title"},"ok":true}; after"#;
		let value = player_response_value(page).unwrap();
		assert_eq!(value["videoDetails"]["title"], "a } title");
		assert!(player_response_value("ytInitialPlayerResponse = { broken").is_none());
		assert!(
			player_response_value("ytInitialPlayerResponse = null; const unrelated = {};").is_none()
		);
	}
}
