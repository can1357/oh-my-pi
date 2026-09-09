//! Anonymous Twitter/X renderer backed by public Nitter instances.

use std::fmt::Write as _;

use omp_core::sf;
#[cfg(test)]
use omp_tool::Severity;
use omp_tool::{Diag, DiagKind, Unit};
use quick_xml::{
	Reader, XmlVersion,
	events::{BytesStart, Event},
};
use smallvec::SmallVec;
use url::Url;

use crate::read::web::types::{HttpClient, HttpRequest, RenderResult, WebError, finalize_output};

const NITTER_INSTANCES: [&str; 4] = [
	"nitter.privacyredirect.com",
	"nitter.tiekoetter.com",
	"nitter.poast.org",
	"nitter.woodland.cafe",
];

/// Returns whether `url` is a Twitter or X page handled by the anonymous
/// renderer.
pub(super) fn matches(url: &Url) -> bool {
	matches!(url.host_str(), Some("twitter.com" | "www.twitter.com" | "x.com" | "www.x.com"))
}

/// Tries the public Nitter mirrors in order, returning the stable blocked
/// response when every anonymous mirror is unavailable.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	if !matches(url) {
		return Ok(None);
	}

	for instance in NITTER_INSTANCES {
		let nitter_url = format!("https://{instance}{}", url.path());
		let Ok(response) = client.get(HttpRequest::new(nitter_url)).await else {
			continue;
		};
		if !response.is_success() {
			continue;
		}

		let page = response.text();
		// JavaScript's String.length counts UTF-16 code units.
		if page.encode_utf16().count() <= 500 {
			continue;
		}
		let Some(tweet) = parse_nitter(page.as_ref()) else {
			continue;
		};
		let markdown = render_tweet(&tweet);
		let (content, omitted) = finalize_output(&markdown);
		let mut diags = vec![Diag::info(DiagKind::Provenance, sf!("Via Nitter: {instance}"))];
		if omitted != 0 {
			diags.push(
				Diag::warn(DiagKind::OutputBounded, "scraper output truncated")
					.omitted(omitted as u64, Unit::Chars),
			);
		}
		return Ok(Some(RenderResult {
			content,
			content_type: Some(sf!("text/markdown")),
			method: sf!("twitter-nitter"),
			diags,
		}));
	}

	Ok(Some(blocked_result()))
}

fn blocked_result() -> RenderResult {
	let diags =
		vec![Diag::warn(DiagKind::Fallback, "X.com blocks bots; Nitter instances unavailable")];
	RenderResult {
		content: sf!(
			"Twitter/X blocks automated access. Nitter instances were unavailable.\n\nTry:\n- \
			 Opening the link in a browser\n- Using a different Nitter instance manually\n- Checking \
			 if the tweet is available via an archive service",
		),
		content_type: Some(sf!("text/plain")),
		method: sf!("twitter-blocked"),
		diags,
	}
}

#[derive(Default)]
struct TweetPage {
	contents:          Vec<TweetContent>,
	timeline_contents: Vec<usize>,
	fullnames:         Vec<String>,
	usernames:         Vec<String>,
	date:              Option<String>,
	date_seen:         bool,
	stats:             Option<String>,
	stats_seen:        bool,
}

struct TweetContent {
	text:        String,
	parent_user: Option<String>,
}

#[derive(Default)]
struct Frame {
	name: Vec<u8>,
	classes: SmallVec<String, 3>,
	text: String,
	first_descendant_username: Option<String>,
	direct_contents: SmallVec<usize, 1>,
	content_index: Option<usize>,
	fullname_index: Option<usize>,
	username_index: Option<usize>,
	capture_date: bool,
	capture_stats: bool,
}

fn parse_nitter(html: &str) -> Option<TweetPage> {
	let mut reader = Reader::from_str(html);
	reader.config_mut().trim_text(false);
	reader.config_mut().check_end_names = false;
	let mut stack: Vec<Frame> = Vec::with_capacity(24);
	let mut page = TweetPage::default();

	loop {
		match reader.read_event() {
			Ok(Event::Start(start)) if !is_void_element(start.local_name().as_ref()) => {
				push_frame(&reader, &mut stack, &start, &mut page);
			},
			Ok(Event::Start(_) | Event::Empty(_)) => {},
			Ok(Event::Text(text)) => {
				if let Ok(decoded) = text.decode() {
					let decoded = decode_html_text(&decoded);
					for frame in &mut stack {
						frame.text.push_str(&decoded);
					}
				}
			},
			Ok(Event::GeneralRef(reference)) => {
				if let Ok(entity) = reference.decode() {
					let decoded = decode_entity(&entity)
						.map_or_else(|| format!("&{entity};"), |character| character.to_string());
					for frame in &mut stack {
						frame.text.push_str(&decoded);
					}
				}
			},
			Ok(Event::CData(text)) => {
				if let Ok(decoded) = text.decode() {
					for frame in &mut stack {
						frame.text.push_str(&decoded);
					}
				}
			},
			Ok(Event::End(end)) => {
				let name = end.local_name();
				if let Some(index) = stack
					.iter()
					.rposition(|frame| frame.name.eq_ignore_ascii_case(name.as_ref()))
				{
					while stack.len() > index {
						finish_frame(&mut stack, &mut page);
					}
				}
			},
			Ok(Event::Eof) => break,
			Err(_) => break,
			_ => {},
		}
	}
	while !stack.is_empty() {
		finish_frame(&mut stack, &mut page);
	}

	page
		.contents
		.first()
		.is_some_and(|content| !content.text.is_empty())
		.then_some(page)
}

fn push_frame(
	reader: &Reader<&[u8]>,
	stack: &mut Vec<Frame>,
	start: &BytesStart<'_>,
	page: &mut TweetPage,
) {
	let classes: SmallVec<String, 3> = start
		.attributes()
		.with_checks(false)
		.filter_map(Result::ok)
		.find(|attribute| attribute.key.as_ref().eq_ignore_ascii_case(b"class"))
		.and_then(|attribute| {
			attribute
				.decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
				.ok()
		})
		.map(|value| value.split_ascii_whitespace().map(str::to_owned).collect())
		.unwrap_or_default();
	let has_class = |class: &str| classes.iter().any(|value| value == class);
	let name = start.local_name().as_ref().to_ascii_lowercase();
	let inside_tweet_date = stack
		.iter()
		.any(|frame| has_frame_class(frame, "tweet-date"));
	let inside_timeline_item = stack
		.iter()
		.any(|frame| has_frame_class(frame, "timeline-item"));
	let capture_date = inside_tweet_date && name.eq_ignore_ascii_case(b"a") && !page.date_seen;
	if capture_date {
		page.date_seen = true;
	}
	let capture_stats = has_class("tweet-stats") && !page.stats_seen;
	if capture_stats {
		page.stats_seen = true;
	}

	let content_index = has_class("tweet-content").then(|| {
		let index = page.contents.len();
		page
			.contents
			.push(TweetContent { text: String::new(), parent_user: None });
		if inside_timeline_item {
			page.timeline_contents.push(index);
		}
		if let Some(parent) = stack.last_mut() {
			parent.direct_contents.push(index);
		}
		index
	});
	let fullname_index = has_class("fullname").then(|| {
		let index = page.fullnames.len();
		page.fullnames.push(String::new());
		index
	});
	let username_index = has_class("username").then(|| {
		let index = page.usernames.len();
		page.usernames.push(String::new());
		index
	});

	stack.push(Frame {
		name,
		classes,
		text: String::new(),
		first_descendant_username: None,
		direct_contents: SmallVec::new(),
		content_index,
		fullname_index,
		username_index,
		capture_date,
		capture_stats,
	});
}

fn is_void_element(name: &[u8]) -> bool {
	[
		b"area".as_slice(),
		b"base",
		b"br",
		b"col",
		b"embed",
		b"hr",
		b"img",
		b"input",
		b"link",
		b"meta",
		b"param",
		b"source",
		b"track",
		b"wbr",
	]
	.iter()
	.any(|element| name.eq_ignore_ascii_case(element))
}

fn finish_frame(stack: &mut Vec<Frame>, page: &mut TweetPage) {
	let Some(mut frame) = stack.pop() else { return };
	let text = frame.text.trim();

	if let Some(index) = frame.username_index {
		set_text(&mut page.usernames[index], text);
		frame
			.first_descendant_username
			.get_or_insert_with(|| text.to_owned());
	}
	if let Some(index) = frame.fullname_index {
		set_text(&mut page.fullnames[index], text);
	}
	if frame.capture_date && !text.is_empty() {
		set_text(page.date.get_or_insert_default(), text);
	}
	if frame.capture_stats && !text.is_empty() {
		set_text(page.stats.get_or_insert_default(), text);
	}

	for index in &frame.direct_contents {
		page.contents[*index]
			.parent_user
			.clone_from(&frame.first_descendant_username);
	}
	if let Some(index) = frame.content_index {
		set_text(&mut page.contents[index].text, text);
	}

	if let Some(parent) = stack.last_mut()
		&& parent.first_descendant_username.is_none()
	{
		parent.first_descendant_username = frame.first_descendant_username;
	}
}

fn set_text(destination: &mut String, source: &str) {
	destination.clear();
	destination.push_str(source);
}

fn has_frame_class(frame: &Frame, class: &str) -> bool {
	frame.classes.iter().any(|value| value == class)
}

fn render_tweet(page: &TweetPage) -> String {
	let content = &page.contents[0].text;
	let fullname = page
		.fullnames
		.first()
		.map(String::as_str)
		.filter(|value| !value.is_empty())
		.unwrap_or("Unknown");
	let username = page
		.usernames
		.first()
		.map(String::as_str)
		.filter(|value| !value.is_empty())
		.unwrap_or("@?");
	let mut markdown = format!("# Tweet by {fullname} ({username})\n\n");
	if let Some(date) = page.date.as_deref() {
		writeln!(markdown, "*{date}*\n").expect("writing to a String cannot fail");
	}
	markdown.push_str(content);
	markdown.push_str("\n\n");
	if let Some(stats) = page.stats.as_deref() {
		markdown.push_str("---\n");
		markdown.push_str(&collapse_whitespace(stats));
		markdown.push('\n');
	}
	if page.timeline_contents.len() > 1 {
		markdown.push_str("\n---\n\n## Thread/Replies\n\n");
		for index in page.timeline_contents.iter().skip(1).take(9) {
			let reply = &page.contents[*index];
			let reply_user = reply
				.parent_user
				.as_deref()
				.filter(|user| !user.is_empty())
				.unwrap_or("@?");
			writeln!(markdown, "**{reply_user}**: {}\n", reply.text)
				.expect("writing to a String cannot fail");
		}
	}
	markdown
}

fn decode_html_text(value: &str) -> String {
	let mut output = String::with_capacity(value.len());
	let mut rest = value;
	while let Some(start) = rest.find('&') {
		output.push_str(&rest[..start]);
		rest = &rest[start..];
		let Some(end) = rest.find(';') else {
			output.push_str(rest);
			return output;
		};
		let entity = &rest[1..end];
		let decoded = decode_entity(entity);
		if let Some(character) = decoded {
			output.push(character);
		} else {
			output.push_str(&rest[..=end]);
		}
		rest = &rest[end + 1..];
	}
	output.push_str(rest);
	output
}

fn decode_entity(entity: &str) -> Option<char> {
	if let Some(number) = entity.strip_prefix('#') {
		let (digits, radix) = if let Some(hex) = number
			.strip_prefix('x')
			.or_else(|| number.strip_prefix('X'))
		{
			(hex, 16)
		} else {
			(number, 10)
		};
		let valid = !digits.is_empty()
			&& digits.chars().all(|character| {
				if radix == 16 {
					character.is_ascii_hexdigit()
				} else {
					character.is_ascii_digit()
				}
			});
		if !valid {
			return None;
		}
		return Some(
			u32::from_str_radix(digits, radix)
				.ok()
				.filter(|code| *code > 0 && *code <= 0x10ffff)
				.and_then(char::from_u32)
				.unwrap_or('\u{fffd}'),
		);
	}

	let exact = match entity {
		"AElig" => Some('Æ'),
		"Aacute" => Some('Á'),
		"Acirc" => Some('Â'),
		"Agrave" => Some('À'),
		"Aring" => Some('Å'),
		"Atilde" => Some('Ã'),
		"Auml" => Some('Ä'),
		"Ccedil" => Some('Ç'),
		"ETH" => Some('Ð'),
		"Eacute" => Some('É'),
		"Ecirc" => Some('Ê'),
		"Egrave" => Some('È'),
		"Euml" => Some('Ë'),
		"Iacute" => Some('Í'),
		"Icirc" => Some('Î'),
		"Igrave" => Some('Ì'),
		"Iuml" => Some('Ï'),
		"Ntilde" => Some('Ñ'),
		"Oacute" => Some('Ó'),
		"Ocirc" => Some('Ô'),
		"Ograve" => Some('Ò'),
		"Oslash" => Some('Ø'),
		"Otilde" => Some('Õ'),
		"Ouml" => Some('Ö'),
		"THORN" => Some('Þ'),
		"Uacute" => Some('Ú'),
		"Ucirc" => Some('Û'),
		"Ugrave" => Some('Ù'),
		"Uuml" => Some('Ü'),
		"Yacute" => Some('Ý'),
		_ => None,
	};
	if exact.is_some() {
		return exact;
	}

	match entity.to_ascii_lowercase().as_str() {
		"aacute" => Some('á'),
		"acirc" => Some('â'),
		"aelig" => Some('æ'),
		"agrave" => Some('à'),
		"aring" => Some('å'),
		"atilde" => Some('ã'),
		"auml" => Some('ä'),
		"amp" => Some('&'),
		"apos" => Some('\''),
		"bull" => Some('•'),
		"brvbar" => Some('¦'),
		"ccedil" => Some('ç'),
		"cedil" => Some('¸'),
		"cent" => Some('¢'),
		"copy" => Some('©'),
		"deg" => Some('°'),
		"curren" => Some('¤'),
		"divide" => Some('÷'),
		"emsp" => Some('\u{2003}'),
		"ensp" => Some('\u{2002}'),
		"euro" => Some('€'),
		"eacute" => Some('é'),
		"ecirc" => Some('ê'),
		"egrave" => Some('è'),
		"eth" => Some('ð'),
		"euml" => Some('ë'),
		"frac12" => Some('½'),
		"frac14" => Some('¼'),
		"frac34" => Some('¾'),
		"gt" => Some('>'),
		"iacute" => Some('í'),
		"icirc" => Some('î'),
		"iexcl" => Some('¡'),
		"igrave" => Some('ì'),
		"iquest" => Some('¿'),
		"iuml" => Some('ï'),
		"hellip" => Some('…'),
		"laquo" => Some('«'),
		"ldquo" => Some('“'),
		"lsquo" => Some('‘'),
		"lt" => Some('<'),
		"mdash" => Some('—'),
		"macr" => Some('¯'),
		"micro" => Some('µ'),
		"middot" => Some('·'),
		"nbsp" => Some('\u{a0}'),
		"ndash" => Some('–'),
		"ntilde" => Some('ñ'),
		"oacute" => Some('ó'),
		"ocirc" => Some('ô'),
		"ograve" => Some('ò'),
		"ordf" => Some('ª'),
		"ordm" => Some('º'),
		"oslash" => Some('ø'),
		"otilde" => Some('õ'),
		"ouml" => Some('ö'),
		"para" => Some('¶'),
		"pound" => Some('£'),
		"plusmn" => Some('±'),
		"quot" => Some('"'),
		"raquo" => Some('»'),
		"rdquo" => Some('”'),
		"reg" => Some('®'),
		"rsquo" => Some('’'),
		"sect" => Some('§'),
		"shy" => Some('\u{ad}'),
		"szlig" => Some('ß'),
		"thorn" => Some('þ'),
		"sup1" => Some('¹'),
		"sup2" => Some('²'),
		"sup3" => Some('³'),
		"thinsp" => Some('\u{2009}'),
		"times" => Some('×'),
		"trade" => Some('™'),
		"uacute" => Some('ú'),
		"ucirc" => Some('û'),
		"ugrave" => Some('ù'),
		"uml" => Some('¨'),
		"uuml" => Some('ü'),
		"yacute" => Some('ý'),
		"yuml" => Some('ÿ'),
		"yen" => Some('¥'),
		_ => None,
	}
}

fn collapse_whitespace(value: &str) -> String {
	value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
	use std::future::{Future, ready};

	use bytes::Bytes;
	use omp_core::Str;
	use parking_lot::Mutex;

	use super::*;
	use crate::read::web::types::HttpResponse;

	fn rendered(html: &str) -> String {
		let page = parse_nitter(html).expect("fixture should contain a tweet");
		finalize_output(&render_tweet(&page)).0.to_string()
	}

	#[test]
	fn matches_only_pi_twitter_and_x_hosts() {
		for target in [
			"https://twitter.com/a/status/1",
			"https://www.twitter.com/a/status/1",
			"https://x.com/a/status/1",
			"https://www.x.com/a/status/1",
		] {
			assert!(matches(&Url::parse(target).unwrap()), "{target}");
		}
		for target in [
			"https://mobile.twitter.com/a/status/1",
			"https://nitter.net/a/status/1",
			"https://example.com/a/status/1",
		] {
			assert!(!matches(&Url::parse(target).unwrap()), "{target}");
		}
	}

	#[test]
	fn renders_single_tweet_entities_media_and_metadata_in_pi_order() {
		let html = r#"
			<div class="timeline-item">
			  <div class="tweet-body">
			    <a class="fullname">Ada &amp; Bob</a>
			    <a class="username">@ada</a>
			    <span class="tweet-date"><a>Jan 2, 2025 · 3:04 PM UTC</a></span>
			    <div class="tweet-content">Fish &amp; chips &#x1F41F; &hellip; &AMP; &#xD800;<div class="attachments"><img src="/pic.jpg" alt="media description"></div></div>
			    <div class="tweet-stats"><span>1,234</span> Retweets
			      <span>56</span> Likes</div>
			  </div>
			</div>
		"#;

		assert_eq!(
			rendered(html),
			"# Tweet by Ada & Bob (@ada)\n\n*Jan 2, 2025 · 3:04 PM UTC*\n\nFish & chips 🐟 … & \
			 �\n\n---\n1,234 Retweets 56 Likes"
		);
	}

	#[test]
	fn renders_quotes_and_replies_in_timeline_order_with_parent_authors() {
		let html = r#"
			<div class="timeline-item"><div class="tweet-body">
			  <a class="fullname">Main Author</a><a class="username">@main</a>
			  <div class="tweet-content">Main post</div>
			  <div class="quote tweet-body">
			    <a class="fullname">Quoted Author</a><a class="username">@quoted</a>
			    <div class="tweet-content">Quoted post</div>
			  </div>
			</div></div>
			<div class="timeline-item"><div class="tweet-body">
			  <a class="fullname">Reply Author</a><a class="username">@reply</a>
			  <div class="tweet-content">Reply text</div>
			</div></div>
		"#;

		assert_eq!(
			rendered(html),
			"# Tweet by Main Author (@main)\n\nMain post\n\n---\n\n## Thread/Replies\n\n**@quoted**: \
			 Quoted post\n\n**@reply**: Reply text"
		);
	}

	#[test]
	fn limits_thread_projection_to_nine_following_items() {
		let mut html = String::from(
			r#"<div class="timeline-item"><div class="tweet-body"><a class="fullname">Root</a><a class="username">@root</a><div class="tweet-content">Root</div></div></div>"#,
		);
		for index in 1..=11 {
			write!(
				html,
				r#"<div class="timeline-item"><div class="tweet-body"><a class="username">@u{index}</a><div class="tweet-content">Reply {index}</div></div></div>"#
			)
			.expect("writing to a String cannot fail");
		}

		let output = rendered(&html);
		for index in 1..=9 {
			assert!(output.contains(&format!("**@u{index}**: Reply {index}")));
		}
		assert!(!output.contains("Reply 10"));
		assert!(!output.contains("Reply 11"));
	}

	#[test]
	fn tolerates_truncated_markup_and_uses_pi_author_fallbacks() {
		let html =
			r#"<div><span class="fullname"></span><div class="tweet-content">still &amp; useful"#;
		assert_eq!(rendered(html), "# Tweet by Unknown (@?)\n\nstill & useful");
		assert!(parse_nitter("<html><div class=\"tweet-stats\">4 likes</div></html>").is_none());
		assert!(
			parse_nitter(
				"<div class=\"tweet-content\"></div><div class=\"tweet-content\">later</div>"
			)
			.is_none()
		);
	}

	struct AvailableClient {
		body:     Bytes,
		requests: Mutex<Vec<Str>>,
	}

	impl HttpClient for AvailableClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			self.requests.lock().push(request.url);
			ready(Ok(HttpResponse {
				final_url:    sf!("https://nitter.privacyredirect.com/omp/status/42"),
				status:       200,
				content_type: Some(sf!("text/html")),
				headers:      SmallVec::new(),
				body:         self.body.clone(),
			}))
		}
	}

	#[tokio::test]
	async fn successful_mirror_preserves_method_note_and_stops_in_instance_order() {
		let html = format!(
			"<div class=\"timeline-item\"><div class=\"tweet-body\"><a class=\"fullname\">OMP</a><a \
			 class=\"username\">@omp</a><div class=\"tweet-content\">Hello</div></div></div><!--{}-->",
			"x".repeat(501)
		);
		let client =
			AvailableClient { body: Bytes::from(html), requests: Mutex::new(Vec::new()) };
		let url = Url::parse("https://twitter.com/omp/status/42").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(result.content.as_str(), "# Tweet by OMP (@omp)\n\nHello");
		assert_eq!(result.method.as_str(), "twitter-nitter");
		assert_eq!(result.content_type.as_deref(), Some("text/markdown"));
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		let requests = client.requests.lock();
		assert_eq!(requests.len(), 1);
		assert_eq!(requests[0].as_str(), "https://nitter.privacyredirect.com/omp/status/42");
	}

	struct UnavailableClient {
		requests: Mutex<Vec<Str>>,
	}

	impl HttpClient for UnavailableClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			self.requests.lock().push(request.url);
			ready(Ok(HttpResponse {
				final_url:    sf!("https://nitter.invalid/"),
				status:       503,
				content_type: Some(sf!("text/html")),
				headers:      SmallVec::new(),
				body:         Bytes::new(),
			}))
		}
	}

	#[tokio::test]
	async fn unavailable_mirrors_return_pi_blocked_fallback_after_ordered_attempts() {
		let client = UnavailableClient { requests: Mutex::new(Vec::new()) };
		let url = Url::parse("https://x.com/omp/status/42?ignored=yes").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(result.method.as_str(), "twitter-blocked");
		assert_eq!(result.content_type.as_deref(), Some("text/plain"));
		assert_eq!(
			result.content.as_str(),
			"Twitter/X blocks automated access. Nitter instances were unavailable.\n\nTry:\n- \
			 Opening the link in a browser\n- Using a different Nitter instance manually\n- Checking \
			 if the tweet is available via an archive service"
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Fallback));
		assert_eq!(result.diags[0].severity, Severity::Warn);
		let requests = client.requests.lock();
		let requests: Vec<&str> = requests.iter().map(Str::as_str).collect();
		assert_eq!(requests, [
			"https://nitter.privacyredirect.com/omp/status/42",
			"https://nitter.tiekoetter.com/omp/status/42",
			"https://nitter.poast.org/omp/status/42",
			"https://nitter.woodland.cafe/omp/status/42",
		]);
	}
}
