//! Pure HTTP content classification and rendering for `read` and `grep`.

use std::{
	fmt::Write as _,
	io::Cursor,
	path::{Path, PathBuf},
	str,
};

use bytes::Bytes;
use encoding_rs::{Encoding, UTF_8};
use html_to_markdown_rs::{
	ConversionOptions, PreprocessingOptions, PreprocessingPreset, TierStrategy, WarningKind,
	convert as convert_html,
};
use omp_core::{Str, sf};
use omp_tool::{Diag, DiagKind, Unit};
use quick_xml::{Reader, events::Event};
use rusqlite::{Connection, MAIN_DB};
use url::Url;

use super::{archive, image, markit, notebook, selector, sqlite};

pub mod scrapers;
pub mod types;

use types::{
	HttpClient, HttpRequest, HttpResponse, MAX_BYTES, RenderResult, WebError, finalize_output,
};

const MARKDOWN_ACCEPT: &str = "text/markdown, text/plain;q=0.9, text/html;q=0.8";
const ALTERNATE_MIN_CHARS: usize = 100;
const FEED_ALTERNATE_MIN_CHARS: usize = 200;
const LLMS_MAX_BYTES: usize = 2 * 1024 * 1024;
const ARCHIVE_LIST_LIMIT: usize = 500;

/// A normalized web target and its optional read selector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedTarget {
	/// Absolute HTTP(S) URL without a selector suffix.
	pub url:      Url,
	/// Selector to apply after the URL frame is built.
	pub selector: selector::ParsedSelector,
}

/// A fully rendered web read, retaining final-URL and optional image truth.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebRead {
	/// URL after transport redirects, or the authored URL for scraper results.
	pub final_url: Str,
	/// Model-facing rendered body and extraction metadata.
	pub render:    RenderResult,
	/// Processed image bytes for the read tool's blob boundary.
	pub image:     Option<image::ProcessedImage>,
}

/// Recognizes and normalizes an authored HTTP(S), `www.`, or bare host:port
/// URL.
///
/// A bare host and numeric port is recognized only when its authority ends in
/// `/`, keeping ordinary filesystem names containing `:` out of URL dispatch.
pub fn parse_target(input: &str) -> Result<Option<ParsedTarget>, WebError> {
	let repaired = repair_collapsed_scheme(input);
	let split = selector::split_path_and_selector(&repaired);
	let path = split.path;
	if !is_readable_url_path(path) {
		return Ok(None);
	}
	if split.selector.is_some() {
		let nested = selector::split_path_and_selector(path);
		if nested.selector.is_some() {
			return Err(WebError::InvalidUrl(sf!(
				"URL selector has multiple range groups; combine them with commas (e.g. \
				 `:5-10,20-30`).",
			)));
		}
	}
	let parsed_selector = selector::parse_selector(split.selector)
		.map_err(|error| WebError::InvalidUrl(Str::new(error.to_string())))?;
	if matches!(parsed_selector, selector::ParsedSelector::Conflicts) {
		return Err(WebError::InvalidUrl(sf!(
			"The :conflicts selector is only valid for local text files",
		)));
	}
	if matches!(parsed_selector, selector::ParsedSelector::Image) {
		return Err(WebError::InvalidUrl(sf!(
			"The :img selector only supports local .svg and .svgz files",
		)));
	}
	let normalized = if has_http_scheme(path) {
		path.to_owned()
	} else if path
		.get(..4)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("www."))
	{
		format!("https://{path}")
	} else {
		format!("http://{path}")
	};
	let url =
		Url::parse(&normalized).map_err(|error| WebError::InvalidUrl(error.to_string().into()))?;
	Ok(Some(ParsedTarget { url, selector: parsed_selector }))
}

/// Fetches and renders a URL body for consumers such as grep materialization.
///
/// The returned content excludes the `URL`/`Content-Type`/`Method` frame.
pub async fn read<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
	raw: bool,
) -> Result<RenderResult, WebError> {
	Ok(read_resource(client, url, raw).await?.render)
}

/// Fetches and renders a URL while retaining media bytes needed by `read`.
pub async fn read_resource<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
	raw: bool,
) -> Result<WebRead, WebError> {
	if !raw && let Some(render) = scrapers::render(client, url).await? {
		return Ok(WebRead {
			final_url: Str::new(url.as_str()),
			render:    finish(render),
			image:     None,
		});
	}

	let response = fetch_page(client, url, &[]).await?;
	let final_url = response.final_url.clone();
	let content_type = normalized_content_type(&response);
	if !response.is_success() {
		let diags = vec![Diag::warn(
			DiagKind::FetchFailed,
			sf!("Failed to fetch URL (HTTP {})", response.status),
		)];
		return Ok(WebRead {
			final_url,
			render: RenderResult {
				content: Default::default(),
				content_type: Some(content_type),
				method: sf!("failed"),
				diags,
			},
			image: None,
		});
	}

	let extension = extension_hint(&response.final_url, response.header("content-disposition"));
	if is_image(&content_type, &extension)
		&& let Some(processed) = tokio::task::spawn_blocking({
			let bytes = response.body.clone();
			move || image::process_image(bytes)
		})
		.await
		.map_err(|_| WebError::render("image processing task failed"))?
		.map_err(|error| WebError::render(error.to_string()))?
	{
		let content = processed.description.clone();
		return Ok(WebRead {
			final_url,
			render: finish(RenderResult {
				content,
				content_type: Some(processed.media_type.clone()),
				method: sf!("image"),
				diags: vec![Diag::info(DiagKind::Provenance, "Fetched image binary")],
			}),
			image: Some(processed),
		});
	}

	if let Some(document_extension) = document_extension(&content_type, &extension) {
		let path = synthetic_path(document_extension);
		match markit::convert_cached(
			client,
			markit::DocumentMetadata { path: &path, media_type: Some(&content_type) },
			&response.body,
			markit::ConversionOptions::default(),
		)
		.await
		{
			Ok(Some(converted)) => {
				let converted = converted.conversion;
				let mut diags = vec![Diag::info(DiagKind::Provenance, "Converted with markit")];
				if let Some(note) = converted.note {
					diags.push(Diag::info(DiagKind::Provenance, note));
				}
				return Ok(WebRead {
					final_url,
					render: finish(RenderResult {
						content: converted.text,
						content_type: Some(content_type),
						method: sf!("markit"),
						diags,
					}),
					image: None,
				});
			},
			Ok(None) => {},
			Err(error) => {
				return Ok(binary_fallback(
					final_url,
					content_type,
					response.body.len(),
					Diag::warn(DiagKind::Fallback, sf!("markit conversion failed: {error}")),
				));
			},
		}
	}

	if is_notebook(&content_type, &extension) {
		return match notebook::render(&response.body, &response.final_url) {
			Ok(rendered) => Ok(WebRead {
				final_url,
				render: finish(RenderResult {
					content:      rendered.text.into(),
					content_type: Some(content_type),
					method:       sf!("notebook"),
					diags:        Vec::new(),
				}),
				image: None,
			}),
			Err(error) => Ok(binary_fallback(
				final_url,
				content_type,
				response.body.len(),
				Diag::warn(DiagKind::Fallback, sf!("Notebook rendering failed: {}", error.message())),
			)),
		};
	}

	if is_sqlite(&content_type, &extension) || sqlite::looks_like_sqlite(&response.body) {
		return match render_sqlite(&response.body) {
			Ok(content) => Ok(WebRead {
				final_url,
				render: finish(RenderResult {
					content:      content.into(),
					content_type: Some(content_type),
					method:       sf!("sqlite"),
					diags:        Vec::new(),
				}),
				image: None,
			}),
			Err(error) => Ok(binary_fallback(
				final_url,
				content_type,
				response.body.len(),
				Diag::warn(DiagKind::Fallback, sf!("SQLite rendering failed: {error}")),
			)),
		};
	}

	if is_archive(&content_type, &extension)
		|| archive::sniff_archive_format(&response.body).is_some()
	{
		return match render_archive(response.body.clone(), &extension) {
			Ok((content, omitted)) => Ok(WebRead {
				final_url,
				render: finish(RenderResult {
					content:      content.into(),
					content_type: Some(content_type),
					method:       sf!("archive"),
					diags:        (omitted != 0)
						.then(|| {
							Diag::info(DiagKind::LimitReached, "archive entries omitted")
								.omitted(omitted as u64, Unit::Items)
						})
						.into_iter()
						.collect(),
				}),
				image: None,
			}),
			Err(error) => Ok(binary_fallback(
				final_url,
				content_type,
				response.body.len(),
				Diag::warn(DiagKind::Fallback, sf!("Archive rendering failed: {error}")),
			)),
		};
	}

	if raw {
		return Ok(WebRead {
			final_url,
			render: finish(RenderResult {
				content:      decode_response(&response),
				content_type: Some(content_type),
				method:       sf!("raw"),
				diags:        Vec::new(),
			}),
			image: None,
		});
	}

	let text = decode_response(&response);
	let mime = content_type.as_str();
	if mime.contains("json") {
		let content = serde_json::from_str::<serde_json::Value>(&text)
			.and_then(|value| serde_json::to_string_pretty(&value))
			.unwrap_or_else(|_| text.to_string());
		return Ok(text_result(final_url, content_type, "json", content));
	}
	let is_html = mime.contains("html") || mime.contains("xhtml");
	let is_feed = mime.contains("rss")
		|| mime.contains("atom")
		|| mime.contains("feed")
		|| (mime.contains("xml") && (text.contains("<rss") || text.contains("<feed")));
	if is_feed {
		return Ok(text_result(final_url, content_type, "feed", render_feed(&text)));
	}
	if (mime == "text/plain" || mime.contains("markdown")) && !looks_like_html(&text) {
		return Ok(text_result(final_url, content_type, "text", text.to_string()));
	}
	if is_html || looks_like_html(&text) {
		return render_html(client, url, final_url, content_type, &text).await;
	}
	Ok(text_result(final_url, content_type, "raw", text.to_string()))
}

/// Converts HTML with aggressive native-reader options.
pub fn html_to_markdown(html: &str) -> Result<Str, WebError> {
	let options = ConversionOptions {
		skip_images: false,
		preprocessing: PreprocessingOptions {
			enabled:           true,
			preset:            PreprocessingPreset::Aggressive,
			remove_navigation: true,
			remove_forms:      true,
		},
		tier_strategy: TierStrategy::Tier2,
		..Default::default()
	};
	let converted = convert_html(html, Some(options))
		.map_err(|error| WebError::render(format!("Conversion error: {error}")))?;
	if let Some(warning) = converted
		.warnings
		.iter()
		.find(|warning| warning.kind == WarningKind::DepthLimitExceeded)
	{
		return Err(WebError::render(format!("Conversion error: {}", warning.message)));
	}
	Ok(converted.content.unwrap_or_default().into())
}

async fn render_html<C: HttpClient + Sync>(
	client: &C,
	authored_url: &Url,
	final_url: Str,
	content_type: Str,
	html: &str,
) -> Result<WebRead, WebError> {
	let final_parsed = Url::parse(&final_url).unwrap_or_else(|_| authored_url.clone());
	let alternates = parse_alternate_links(html, &final_parsed);
	if let Some(alternate) = alternates
		.iter()
		.find(|alternate| alternate.kind == AlternateKind::Markdown)
		&& let Ok(response) = fetch_page(client, &alternate.url, &[]).await
		&& response.is_success()
	{
		let content = decode_response(&response);
		if usable_alternate(&content, ALTERNATE_MIN_CHARS) {
			let render = RenderResult {
				content,
				content_type: Some(sf!("text/markdown")),
				method: sf!("alternate-markdown"),
				diags: vec![Diag::info(
					DiagKind::Provenance,
					sf!("Used markdown alternate: {}", alternate.url),
				)],
			};
			return Ok(WebRead { final_url, render: finish(render), image: None });
		}
	}

	if let Ok(response) = fetch_page(client, &markdown_suffix_url(&final_parsed), &[]).await
		&& response.is_success()
	{
		let content = decode_response(&response);
		if usable_alternate(&content, ALTERNATE_MIN_CHARS) {
			return Ok(WebRead {
				final_url,
				render: finish(RenderResult {
					content,
					content_type: Some(sf!("text/markdown")),
					method: sf!("md-suffix"),
					diags: vec![Diag::info(DiagKind::Provenance, "Found .md suffix version")],
				}),
				image: None,
			});
		}
	}

	if let Ok(response) = fetch_page(client, authored_url, &[("Accept", MARKDOWN_ACCEPT)]).await
		&& response.is_success()
	{
		let negotiated_type = normalized_content_type(&response);
		let content = decode_response(&response);
		if (negotiated_type.contains("markdown") || negotiated_type == "text/plain")
			&& !looks_like_html(&content)
		{
			return Ok(WebRead {
				final_url,
				render: finish(RenderResult {
					content,
					content_type: Some(negotiated_type.clone()),
					method: sf!("content-negotiation"),
					diags: vec![Diag::info(
						DiagKind::Provenance,
						sf!("Content negotiation returned {negotiated_type}"),
					)],
				}),
				image: None,
			});
		}
	}

	for alternate in alternates
		.iter()
		.filter(|alternate| alternate.kind == AlternateKind::Feed)
		.take(2)
	{
		if let Ok(response) = fetch_page(client, &alternate.url, &[]).await
			&& response.is_success()
		{
			let content = decode_response(&response);
			if content.trim().chars().count() > FEED_ALTERNATE_MIN_CHARS {
				return Ok(WebRead {
					final_url,
					render: finish(RenderResult {
						content:      render_feed(&content).into(),
						content_type: Some(sf!("application/feed")),
						method:       sf!("alternate-feed"),
						diags:        vec![Diag::info(
							DiagKind::Provenance,
							sf!("Used feed alternate: {}", alternate.url),
						)],
					}),
					image: None,
				});
			}
		}
	}

	match html_to_markdown(html) {
		Ok(markdown) if !low_quality(&markdown) => Ok(WebRead {
			final_url,
			render: finish(RenderResult {
				content:      markdown,
				content_type: Some(content_type),
				method:       sf!("native"),
				diags:        Vec::new(),
			}),
			image: None,
		}),
		converted => {
			let mut diags = Vec::new();
			match converted {
				Ok(_) => diags.push(Diag::warn(
					DiagKind::Fallback,
					"Page appears to require JavaScript or is mostly navigation",
				)),
				Err(_) => {
					diags.push(Diag::warn(
						DiagKind::Fallback,
						"HTML rendering failed because no reader backend produced usable output",
					));
				},
			}
			if let Some((endpoint, content)) = try_llms(client, &final_parsed).await {
				diags.push(Diag::warn(DiagKind::Fallback, sf!("Used llms.txt fallback: {endpoint}")));
				return Ok(WebRead {
					final_url,
					render: finish(RenderResult {
						content,
						content_type: Some(sf!("text/plain")),
						method: sf!("llms.txt"),
						diags,
					}),
					image: None,
				});
			}
			Ok(WebRead {
				final_url,
				render: finish(RenderResult {
					content: Str::new(html),
					content_type: Some(content_type),
					method: sf!("raw-html"),
					diags,
				}),
				image: None,
			})
		},
	}
}

async fn fetch_page<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
	headers: &[(&str, &str)],
) -> Result<HttpResponse, WebError> {
	let mut request = HttpRequest::new(url.as_str()).with_max_bytes(MAX_BYTES);
	for (name, value) in headers {
		request = request.with_header(*name, *value);
	}
	let response = client.get(request).await?;
	if response.body.len() > MAX_BYTES {
		return Err(WebError::ResponseTooLarge { max_bytes: MAX_BYTES });
	}
	Ok(response)
}

fn finish(mut result: RenderResult) -> RenderResult {
	let (content, omitted) = finalize_output(&result.content);
	result.content = content;
	if omitted != 0 {
		result.diags.push(
			Diag::warn(DiagKind::OutputBounded, "scraper output truncated")
				.omitted(omitted as u64, Unit::Chars),
		);
	}
	result
}

fn text_result(
	final_url: Str,
	content_type: Str,
	method: &'static str,
	content: String,
) -> WebRead {
	WebRead {
		final_url,
		render: finish(RenderResult {
			content:      content.into(),
			content_type: Some(content_type),
			method:       sf!(method),
			diags:        Vec::new(),
		}),
		image: None,
	}
}

fn binary_fallback(final_url: Str, content_type: Str, bytes: usize, diag: Diag) -> WebRead {
	WebRead {
		render: RenderResult {
			content:      sf!(
				"[Binary content: {}, {}] {}",
				content_type,
				format_bytes(bytes),
				final_url
			),
			content_type: Some(content_type),
			method:       sf!("binary"),
			diags:        vec![diag],
		},
		final_url,
		image: None,
	}
}

fn render_archive(bytes: Bytes, extension: &str) -> Result<(String, usize), archive::ArchiveError> {
	let hinted = match extension {
		".zip" | ".jar" | ".war" | ".ear" | ".apk" => Some(archive::ArchiveFormat::Zip),
		".tar" => Some(archive::ArchiveFormat::Tar),
		".tar.gz" | ".tgz" | ".gz" => Some(archive::ArchiveFormat::TarGz),
		".asar" => Some(archive::ArchiveFormat::Asar),
		_ => None,
	};
	let format = hinted
		.or_else(|| archive::sniff_archive_format(&bytes))
		.ok_or_else(|| archive::ArchiveError::UnsupportedFormat {
			path: "downloaded payload".to_owned(),
		})?;
	let reader = archive::open_archive_bytes(bytes, format)?;
	let mut entries = reader.list_directory("")?;
	let truncated = entries.len().saturating_sub(ARCHIVE_LIST_LIMIT);
	entries.truncate(ARCHIVE_LIST_LIMIT);
	let rendered = if entries.is_empty() {
		"(empty archive directory)".to_owned()
	} else {
		archive::format_archive_entry_lines(&entries).join("\n")
	};
	Ok((rendered, truncated))
}

fn render_sqlite(bytes: &[u8]) -> Result<String, sqlite::Error> {
	let mut connection = Connection::open_in_memory().map_err(sqlite_error)?;
	connection
		.deserialize_read_exact(MAIN_DB, Cursor::new(bytes), bytes.len(), true)
		.map_err(sqlite_error)?;
	let tables = sqlite::list_tables(&connection, sqlite::ROW_COUNT_PROBE_CAP)?;
	Ok(sqlite::render_table_list(&tables))
}

fn sqlite_error(error: rusqlite::Error) -> sqlite::Error {
	// The public SQLite error intentionally hides its representation. Reuse its
	// existing conversion rather than creating a second diagnostic convention.
	error.into()
}

fn normalized_content_type(response: &HttpResponse) -> Str {
	let value = response
		.content_type
		.as_deref()
		.or_else(|| response.header("content-type"))
		.unwrap_or("application/octet-stream");
	Str::new(normalize_mime(value).to_ascii_lowercase())
}

fn normalize_mime(value: &str) -> &str {
	value.split(';').next().unwrap_or(value).trim()
}

fn decode_response(response: &HttpResponse) -> Str {
	let label = response
		.header("content-type")
		.and_then(charset_from_content_type)
		.or_else(|| charset_from_meta(&response.body));
	let encoding = label
		.and_then(|label| Encoding::for_label(label.as_bytes()))
		.unwrap_or(UTF_8);
	let (decoded, ..) = encoding.decode(&response.body);
	decoded.into_owned().into()
}

fn charset_from_content_type(value: &str) -> Option<&str> {
	value.split(';').skip(1).find_map(|parameter| {
		let (name, value) = parameter.trim().split_once('=')?;
		name
			.trim()
			.eq_ignore_ascii_case("charset")
			.then(|| value.trim().trim_matches(['\'', '"']))
	})
}

fn charset_from_meta(bytes: &[u8]) -> Option<&str> {
	let head = str::from_utf8(&bytes[..bytes.len().min(32 * 1024)]).ok()?;
	let lower = head.to_ascii_lowercase();
	let index = lower.find("charset")? + "charset".len();
	let tail = head.get(index..)?.trim_start();
	let tail = tail.strip_prefix('=')?.trim_start();
	let tail = tail.trim_start_matches(['\'', '"']);
	let end = tail
		.find(|character: char| {
			character.is_ascii_whitespace() || matches!(character, '\'' | '"' | '>' | ';')
		})
		.unwrap_or(tail.len());
	(end != 0).then_some(&tail[..end])
}

fn repair_collapsed_scheme(input: &str) -> String {
	for scheme in ["https", "http"] {
		let prefix = format!("{scheme}:/");
		if input
			.get(..prefix.len())
			.is_some_and(|value| value.eq_ignore_ascii_case(&prefix))
			&& input
				.get(prefix.len()..)
				.is_some_and(|value| !value.starts_with('/'))
		{
			return format!(
				"{}://{}",
				input.get(..scheme.len()).unwrap_or(scheme),
				input.get(prefix.len()..).unwrap_or_default()
			);
		}
	}
	input.to_owned()
}

fn has_http_scheme(value: &str) -> bool {
	value
		.get(..7)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
		|| value
			.get(..8)
			.is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
}

fn is_readable_url_path(value: &str) -> bool {
	if has_http_scheme(value)
		|| value
			.get(..4)
			.is_some_and(|prefix| prefix.eq_ignore_ascii_case("www."))
	{
		return true;
	}
	let Some(slash) = value.find('/') else {
		return false;
	};
	let authority = &value[..slash];
	let Some((host, port)) = authority.rsplit_once(':') else {
		return false;
	};
	!host.is_empty()
		&& !host.contains(['/', '\\'])
		&& !port.is_empty()
		&& port.bytes().all(|byte| byte.is_ascii_digit())
}

fn extension_hint(url: &str, content_disposition: Option<&str>) -> String {
	if let Some(value) = content_disposition
		&& let Some(filename) = disposition_filename(value)
	{
		let extension = filename_extension(filename);
		if !extension.is_empty() {
			return extension;
		}
	}
	Url::parse(url)
		.ok()
		.map(|url| filename_extension(url.path()))
		.unwrap_or_default()
}

fn disposition_filename(value: &str) -> Option<&str> {
	let lower = value.to_ascii_lowercase();
	let index = lower.find("filename")?;
	let tail = &value[index + "filename".len()..];
	let tail = tail.strip_prefix('*').unwrap_or(tail);
	let (_, value) = tail.split_once('=')?;
	Some(
		value
			.trim()
			.trim_matches(['\'', '"'])
			.split(';')
			.next()
			.unwrap_or_default(),
	)
}

fn filename_extension(filename: &str) -> String {
	let lower = filename.to_ascii_lowercase();
	if lower.ends_with(".tar.gz") {
		return ".tar.gz".to_owned();
	}
	Path::new(&lower)
		.extension()
		.and_then(|extension| extension.to_str())
		.map(|extension| format!(".{extension}"))
		.unwrap_or_default()
}

fn synthetic_path(extension: &str) -> PathBuf {
	Path::new("payload").with_extension(extension.trim_start_matches('.'))
}

fn document_extension<'a>(mime: &str, extension: &'a str) -> Option<&'a str> {
	let mime = mime.split(';').next().unwrap_or(mime).trim();
	let mime_extension = match mime {
		"application/pdf" => ".pdf",
		"application/msword" => ".doc",
		"application/vnd.ms-word.document.macroenabled.12" => ".docm",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document" => ".docx",
		"application/vnd.ms-excel" => ".xls",
		"application/vnd.ms-excel.sheet.macroenabled.12" => ".xlsm",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => ".xlsx",
		"application/vnd.oasis.opendocument.text" => ".odt",
		"application/vnd.oasis.opendocument.spreadsheet" => ".ods",
		"application/vnd.oasis.opendocument.presentation" => ".odp",
		"application/vnd.ms-powerpoint" => ".ppt",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation" => ".pptx",
		"application/rtf" | "application/x-rtf" | "text/rtf" => ".rtf",
		"application/epub+zip" => ".epub",
		_ => "",
	};
	if !mime_extension.is_empty() {
		return Some(mime_extension);
	}
	markit::supports_extension(extension).then_some(extension)
}

fn is_notebook(mime: &str, extension: &str) -> bool {
	extension == ".ipynb"
		|| matches!(
			mime,
			"application/x-ipynb+json" | "application/vnd.jupyter" | "application/x-jupyter"
		)
}

fn is_sqlite(mime: &str, extension: &str) -> bool {
	matches!(extension, ".sqlite" | ".sqlite3" | ".db" | ".db3")
		|| matches!(mime, "application/vnd.sqlite3" | "application/x-sqlite3")
}

fn is_archive(mime: &str, extension: &str) -> bool {
	matches!(
		extension,
		".zip" | ".jar" | ".war" | ".ear" | ".apk" | ".tar" | ".tar.gz" | ".tgz" | ".gz"
	) || matches!(
		mime,
		"application/zip"
			| "application/x-zip-compressed"
			| "application/x-tar"
			| "application/tar"
			| "application/gzip"
			| "application/x-gzip"
	)
}

fn is_image(mime: &str, extension: &str) -> bool {
	matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
		|| matches!(extension, ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp")
}

fn looks_like_html(content: &str) -> bool {
	let mut sample = content.trim_start().chars().take(4_096).collect::<String>();
	sample.make_ascii_lowercase();
	sample.starts_with("<!doctype html")
		|| sample.starts_with("<html")
		|| sample.contains("<body")
		|| sample.contains("<head")
}

fn usable_alternate(content: &str, minimum: usize) -> bool {
	content.trim().chars().count() > minimum && !looks_like_html(content)
}

fn low_quality(content: &str) -> bool {
	let trimmed = content.trim();
	if trimmed.chars().count() <= ALTERNATE_MIN_CHARS {
		return true;
	}
	if trimmed.len() < 1024 {
		let lower = trimmed.to_ascii_lowercase();
		if [
			"enable javascript",
			"javascript required",
			"turn on javascript",
			"please enable javascript",
			"browser not supported",
		]
		.iter()
		.any(|indicator| lower.contains(indicator))
		{
			return true;
		}
	}
	let mut line_count = 0;
	let mut short_line_count = 0;
	for line in trimmed
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
	{
		line_count += 1;
		short_line_count += usize::from(line.chars().count() < 40);
	}
	line_count > 10 && short_line_count * 10 > line_count * 7
}

fn markdown_suffix_url(url: &Url) -> Url {
	let mut candidate = url.clone();
	candidate.set_query(None);
	candidate.set_fragment(None);
	let path = candidate.path();
	let new_path = if path.ends_with('/') {
		format!("{path}index.html.md")
	} else {
		format!("{path}.md")
	};
	candidate.set_path(&new_path);
	candidate
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AlternateKind {
	Markdown,
	Feed,
}

#[derive(Clone, Debug)]
struct Alternate {
	url:  Url,
	kind: AlternateKind,
}

fn parse_alternate_links(html: &str, page_url: &Url) -> Vec<Alternate> {
	let head = html.chars().take(32 * 1024).collect::<String>();
	let lower = head.to_ascii_lowercase();
	let head_end = lower.find("</head>").unwrap_or(lower.len());
	let mut cursor = 0;
	let mut alternates = Vec::new();
	while let Some(relative) = lower[cursor..head_end].find("<link") {
		let start = cursor + relative;
		let Some(relative_end) = head[start..head_end].find('>') else {
			break;
		};
		let end = start + relative_end;
		let tag = &head[start..=end];
		cursor = end + 1;
		let rel = html_attribute(tag, "rel").unwrap_or_default();
		if !rel
			.split_ascii_whitespace()
			.any(|token| token.eq_ignore_ascii_case("alternate"))
		{
			continue;
		}
		let Some(href) = html_attribute(tag, "href") else {
			continue;
		};
		let media_type = html_attribute(tag, "type")
			.unwrap_or_default()
			.to_ascii_lowercase();
		let kind = if media_type.contains("markdown")
			|| href
				.get(href.len().saturating_sub(".md".len())..)
				.is_some_and(|extension| extension.eq_ignore_ascii_case(".md"))
			|| href.contains("markdown")
		{
			AlternateKind::Markdown
		} else if media_type.contains("rss")
			|| media_type.contains("atom")
			|| media_type.contains("feed")
		{
			if href.contains("RecentChanges")
				|| href.contains("Special:")
				|| href.contains("/feed/")
				|| href.contains("action=feed")
				|| (!href.contains(page_url.path()) && !href.contains("comments"))
			{
				continue;
			}
			AlternateKind::Feed
		} else {
			continue;
		};
		if let Ok(url) = page_url.join(&href) {
			alternates.push(Alternate { url, kind });
		}
	}
	alternates
}

fn html_attribute(tag: &str, wanted: &str) -> Option<String> {
	let lower = tag.to_ascii_lowercase();
	let wanted = wanted.to_ascii_lowercase();
	let mut search_from = 0;
	while let Some(relative) = lower[search_from..].find(&wanted) {
		let start = search_from + relative;
		let end = start + wanted.len();
		let before_ok = start == 0
			|| lower.as_bytes()[start - 1].is_ascii_whitespace()
			|| lower.as_bytes()[start - 1] == b'<';
		if !before_ok {
			search_from = end;
			continue;
		}
		let mut cursor = end;
		while lower
			.as_bytes()
			.get(cursor)
			.is_some_and(u8::is_ascii_whitespace)
		{
			cursor += 1;
		}
		if lower.as_bytes().get(cursor) != Some(&b'=') {
			search_from = end;
			continue;
		}
		cursor += 1;
		while lower
			.as_bytes()
			.get(cursor)
			.is_some_and(u8::is_ascii_whitespace)
		{
			cursor += 1;
		}
		let quote = tag.as_bytes().get(cursor).copied();
		if matches!(quote, Some(b'\'' | b'"')) {
			cursor += 1;
			let end = tag[cursor..].find(char::from(quote.unwrap()))? + cursor;
			return Some(tag[cursor..end].to_owned());
		}
		let end = tag[cursor..]
			.find(|character: char| character.is_ascii_whitespace() || character == '>')
			.map_or(tag.len(), |relative| cursor + relative);
		return Some(tag[cursor..end].trim_end_matches('/').to_owned());
	}
	None
}

async fn try_llms<C: HttpClient + Sync>(client: &C, url: &Url) -> Option<(Url, Str)> {
	for endpoint in llms_candidates(url) {
		let Ok(response) = fetch_page(client, &endpoint, &[]).await else {
			continue;
		};
		if !response.is_success() || response.body.len() > LLMS_MAX_BYTES {
			continue;
		}
		let content = decode_response(&response);
		if usable_alternate(&content, ALTERNATE_MIN_CHARS) {
			return Some((endpoint, content));
		}
	}
	None
}

fn llms_candidates(url: &Url) -> Vec<Url> {
	let mut paths = Vec::new();
	let segments = url
		.path_segments()
		.map(|segments| {
			segments
				.filter(|segment| !segment.is_empty())
				.collect::<Vec<_>>()
		})
		.unwrap_or_default();
	if segments.is_empty() {
		paths.extend([
			"/.well-known/llms.txt".to_owned(),
			"/llms.txt".to_owned(),
			"/llms.md".to_owned(),
		]);
	} else {
		let depth = if url.path().ends_with('/') {
			segments.len()
		} else {
			segments.len().saturating_sub(1).max(1)
		};
		for depth in (1..=depth).rev() {
			let scope = segments[..depth].join("/");
			paths.push(format!("/{scope}/llms.txt"));
			paths.push(format!("/{scope}/llms.md"));
		}
	}
	paths
		.into_iter()
		.map(|path| {
			let mut candidate = url.clone();
			candidate.set_path(&path);
			candidate.set_query(None);
			candidate.set_fragment(None);
			candidate
		})
		.collect()
}

fn render_feed(content: &str) -> String {
	let mut reader = Reader::from_str(content);
	reader.config_mut().trim_text(true);
	let mut feed_title = None;
	let mut items = Vec::<FeedItem>::new();
	let mut item = None::<FeedItem>;
	let mut field = None::<FeedField>;
	loop {
		match reader.read_event() {
			Ok(Event::Start(start)) => match start.local_name().as_ref() {
				b"item" | b"entry" => item = Some(FeedItem::default()),
				b"title" => field = Some(FeedField::Title),
				b"link" => {
					if let Some(item) = item.as_mut()
						&& let Some(href) = start
							.attributes()
							.flatten()
							.find(|attribute| attribute.key.local_name().as_ref() == b"href")
					{
						item.link = String::from_utf8_lossy(&href.value).into_owned();
					}
					field = Some(FeedField::Link);
				},
				b"pubDate" | b"updated" => field = Some(FeedField::Date),
				b"description" | b"summary" | b"content" => field = Some(FeedField::Description),
				_ => {},
			},
			Ok(Event::Text(text)) => {
				if let Ok(value) = text.decode() {
					apply_feed_value(clean_feed_text(&value), field, item.as_mut(), &mut feed_title);
				}
			},
			Ok(Event::CData(text)) => {
				if let Ok(value) = text.decode() {
					apply_feed_value(clean_feed_text(&value), field, item.as_mut(), &mut feed_title);
				}
			},
			Ok(Event::End(end)) => match end.local_name().as_ref() {
				b"item" | b"entry" => {
					if let Some(item) = item.take()
						&& items.len() < 10
					{
						items.push(item);
					}
				},
				b"title" | b"link" | b"pubDate" | b"updated" | b"description" | b"summary"
				| b"content" => field = None,
				_ => {},
			},
			Ok(Event::Eof) | Err(_) => break,
			_ => {},
		}
	}
	if items.is_empty() {
		return content.to_owned();
	}
	let mut output = format!(
		"# {}\n\n",
		feed_title
			.filter(|title| !title.is_empty())
			.unwrap_or_else(|| "Feed".to_owned())
	);
	for item in items {
		writeln!(
			output,
			"## {}",
			if item.title.is_empty() {
				"Untitled"
			} else {
				&item.title
			}
		)
		.expect("writing to a String cannot fail");
		if !item.date.is_empty() {
			writeln!(output, "*{}*\n", item.date).expect("writing to a String cannot fail");
		}
		if !item.description.is_empty() {
			let description = item.description.chars().take(500).collect::<String>();
			output.push_str(&description);
			if item.description.chars().count() > 500 {
				output.push_str("...");
			}
			output.push_str("\n\n");
		}
		if !item.link.is_empty() {
			writeln!(output, "[Read more]({})\n", item.link).expect("writing to a String cannot fail");
		}
		output.push_str("---\n\n");
	}
	output
}

#[derive(Clone, Copy)]
enum FeedField {
	Title,
	Link,
	Date,
	Description,
}

#[derive(Default)]
struct FeedItem {
	title:       String,
	link:        String,
	date:        String,
	description: String,
}
fn apply_feed_value(
	value: String,
	field: Option<FeedField>,
	item: Option<&mut FeedItem>,
	feed_title: &mut Option<String>,
) {
	if let Some(item) = item {
		match field {
			Some(FeedField::Title) => item.title.push_str(&value),
			Some(FeedField::Link) if item.link.is_empty() => item.link.push_str(&value),
			Some(FeedField::Date) => item.date.push_str(&value),
			Some(FeedField::Description) => item.description.push_str(&value),
			None | Some(FeedField::Link) => {},
		}
	} else if matches!(field, Some(FeedField::Title)) && feed_title.is_none() {
		*feed_title = Some(value);
	}
}

fn clean_feed_text(value: &str) -> String {
	let mut output = String::new();
	let mut in_tag = false;
	for character in value.replace("<![CDATA[", "").replace("]]>", "").chars() {
		match character {
			'<' => in_tag = true,
			'>' => in_tag = false,
			_ if !in_tag => output.push(character),
			_ => {},
		}
	}
	output
		.replace("&lt;", "<")
		.replace("&gt;", ">")
		.replace("&amp;", "&")
		.replace("&quot;", "\"")
		.trim()
		.to_owned()
}

fn format_bytes(bytes: usize) -> String {
	const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
	let mut value = bytes as f64;
	let mut unit = 0;
	while value >= 1024.0 && unit + 1 < UNITS.len() {
		value /= 1024.0;
		unit += 1;
	}
	if unit == 0 {
		format!("{bytes} B")
	} else if value >= 10.0 {
		format!("{value:.0} {}", UNITS[unit])
	} else {
		format!("{value:.1} {}", UNITS[unit])
	}
}
