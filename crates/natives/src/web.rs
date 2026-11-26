//! JavaScript bindings for the web renderer and sans-I/O reader.

use std::{
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use omp_web::{Hidden, reader, remote, render};
use parking_lot::Mutex;

use crate::{js::into_string, task};

fn render_options(
	format: Option<&str>,
	mode: Option<&str>,
	hidden: Option<&str>,
	images: Option<bool>,
	width: Option<u32>,
) -> Result<render::Options> {
	let mut options = render::Options::default();
	if let Some(format) = format {
		options.format = match format {
			"markdown" => render::Format::Markdown,
			"text" => render::Format::Text,
			_ => return Err(Error::from_reason("Invalid format: expected markdown or text")),
		};
	}
	if let Some(mode) = mode {
		options.mode = render::Mode::parse(mode)
			.filter(|_| matches!(mode, "auto" | "full"))
			.ok_or_else(|| Error::from_reason("Invalid mode: expected auto or full"))?;
	}
	if let Some(hidden) = hidden {
		options.hidden = Hidden::parse(hidden)
			.ok_or_else(|| Error::from_reason("Invalid hidden: expected drop, reachable, or all"))?;
	}
	if let Some(images) = images {
		options.images = images;
	}
	if let Some(width) = width {
		options.width = (width as usize).clamp(1, 1024);
	}
	Ok(options)
}

/// Options for rendering HTML already held by the caller.
#[napi(object)]
#[derive(Default)]
pub struct RenderHtmlOptions {
	/// Output syntax; defaults to Markdown.
	#[napi(ts_type = "\"markdown\" | \"text\"")]
	pub format:   Option<String>,
	/// Use reader selection (the default) or keep all visible content.
	#[napi(ts_type = "\"auto\" | \"full\"")]
	pub mode:     Option<String>,
	/// Which hidden content to include; defaults to dropping it.
	#[napi(ts_type = "\"drop\" | \"reachable\" | \"all\"")]
	pub hidden:   Option<String>,
	/// Include images in Markdown output; defaults to true.
	pub images:   Option<bool>,
	/// Text rendering width in columns; defaults to 250.
	pub width:    Option<u32>,
	/// Absolute URL used to resolve relative links.
	pub base_url: Option<String>,
}

/// Render HTML as Markdown or plain text on a worker thread.
#[napi]
pub fn render_html(
	html: JsString,
	options: Option<RenderHtmlOptions>,
) -> Result<task::Promise<String>> {
	let html = into_string(html)?;
	let options = options.unwrap_or_default();
	let render = render_options(
		options.format.as_deref(),
		options.mode.as_deref(),
		options.hidden.as_deref(),
		options.images,
		options.width,
	)?;
	let base_url = options
		.base_url
		.as_deref()
		.map(str::parse)
		.transpose()
		.map_err(|err| Error::from_reason(format!("Invalid baseUrl: {err}")))?;
	Ok(task::blocking("render_html", (), move |_| {
		Ok(render::render(&html, base_url.as_ref(), &render).content)
	}))
}

/// Reader output and fallback options.
#[napi(object)]
#[derive(Default)]
pub struct ReaderOptions {
	/// Return the decoded source instead of rendering a document.
	pub raw:              Option<bool>,
	/// Output syntax; defaults to Markdown.
	#[napi(ts_type = "\"markdown\" | \"text\"")]
	pub format:           Option<String>,
	/// Use reader selection (the default) or keep all visible content.
	#[napi(ts_type = "\"auto\" | \"full\"")]
	pub mode:             Option<String>,
	/// Which hidden content to include; defaults to dropping it.
	#[napi(ts_type = "\"drop\" | \"reachable\" | \"all\"")]
	pub hidden:           Option<String>,
	/// Include images in Markdown output; defaults to true.
	pub images:           Option<bool>,
	/// Text rendering width in columns; defaults to 250.
	pub width:            Option<u32>,
	/// Permit a browser-rendered fallback if HTTP and embedded data fail.
	pub browser:          Option<bool>,
	/// User-agent candidates for HTTP requests.
	pub user_agents:      Option<Vec<String>>,
	/// Enable site-specific readers; defaults to true.
	pub sites:            Option<bool>,
	/// Credentials for site-specific API requests.
	pub site_credentials: Option<Vec<ReaderSiteCredential>>,
	/// Settings for site-specific readers (for example, `x.model`).
	pub site_settings:    Option<Vec<ReaderSiteSetting>>,
	/// Wall clock in ms since the Unix epoch (`Date.now()`); defaults to the
	/// system clock.
	pub now_ms:           Option<f64>,
	/// User-agent for site API requests that do not specify one; defaults to
	/// "omp".
	pub api_user_agent:   Option<String>,
	/// Remote readers in priority order.
	pub remote:           Option<Vec<ReaderRemoteBackend>>,
	/// Try remote reading before rendering HTML locally.
	pub prefer_remote:    Option<bool>,
}

/// A credential for a site-specific reader.
#[napi(object)]
pub struct ReaderSiteCredential {
	/// Site identifier (for example, "github").
	pub site:  String,
	/// API token for the site.
	pub token: String,
}

/// A setting for site-specific readers.
#[napi(object)]
pub struct ReaderSiteSetting {
	/// Setting key (for example, "x.model").
	pub key:   String,
	/// Setting value.
	pub value: String,
}

/// Configuration for one remote reader.
#[napi(object)]
pub struct ReaderRemoteBackend {
	/// Remote reader service.
	#[napi(ts_type = "\"jina\" | \"firecrawl\" | \"parallel\"")]
	pub kind:     String,
	/// API key for the service.
	pub api_key:  Option<String>,
	/// Override the service's default base URL.
	pub base_url: Option<String>,
}

/// An HTTP header. Repeated header names are preserved in the header array.
#[napi(object)]
pub struct ReaderHeader {
	/// Header name.
	pub name:  String,
	/// Header value.
	pub value: String,
}

/// The next action for the host, or the reader's final output.
#[napi(object)]
#[derive(Default)]
pub struct ReaderStep {
	/// Whether to issue an HTTP request, browse, or return a final output.
	#[napi(ts_type = "\"fetch\" | \"browse\" | \"done\"")]
	pub kind:      String,
	/// URL to fetch or browse.
	pub url:       Option<String>,
	/// HTTP method for a fetch step.
	pub method:    Option<String>,
	/// HTTP headers for a fetch step.
	pub headers:   Option<Vec<ReaderHeader>>,
	/// Optional HTTP request body.
	pub body:      Option<Buffer>,
	/// Maximum number of response bytes to read.
	pub max_bytes: Option<u32>,
	/// Why this fetch is needed.
	pub purpose:   Option<String>,
	/// Which responses to retry once before resolving the fetch.
	#[napi(ts_type = "\"none\" | \"rate-limit\" | \"transient\"")]
	pub retry:     Option<String>,
	/// Result of a completed read.
	pub output:    Option<ReaderOutput>,
}

impl From<reader::Step> for ReaderStep {
	fn from(step: reader::Step) -> Self {
		match step {
			reader::Step::Fetch(request) => Self {
				kind:      "fetch".into(),
				url:       Some(request.url),
				method:    Some(request.method),
				headers:   Some(
					request
						.headers
						.into_iter()
						.map(|(name, value)| ReaderHeader { name, value })
						.collect(),
				),
				body:      request.body.map(Buffer::from),
				max_bytes: Some(u32::try_from(request.max_bytes).unwrap_or(u32::MAX)),
				purpose:   Some(request.purpose.as_str().into()),
				retry:     Some(request.retry.as_str().into()),
				output:    None,
			},
			reader::Step::Browse { url } => {
				Self { kind: "browse".into(), url: Some(url), ..Self::default() }
			},
			reader::Step::Done(output) => {
				Self { kind: "done".into(), output: Some(output.into()), ..Self::default() }
			},
		}
	}
}

/// Result of the requested fetch or browser load.
#[napi(object)]
pub struct ReaderResponse {
	/// HTTP status, or zero on a transport error.
	pub status:    u16,
	/// Final URL after redirects.
	pub url:       String,
	/// Response headers.
	pub headers:   Vec<ReaderHeader>,
	/// Response bytes or UTF-8 encoded DOM from a browser load.
	pub body:      Option<Buffer>,
	/// Whether the body was cut off at the requested byte limit.
	pub truncated: Option<bool>,
	/// Transport failure, if any.
	pub error:     Option<String>,
}

/// Final result of reading a URL.
#[napi(object)]
#[derive(Default)]
pub struct ReaderOutput {
	/// Whether the reader produced a page, detected a blob, or failed.
	#[napi(ts_type = "\"page\" | \"blob\" | \"failed\"")]
	pub kind:         String,
	/// Final URL.
	pub url:          String,
	/// Rendered or decoded page content.
	pub content:      Option<String>,
	/// Page output format.
	pub format:       Option<String>,
	/// Source content type for a page result.
	pub content_type: Option<String>,
	/// Page title when available.
	pub title:        Option<String>,
	/// Strategy used to produce the page.
	pub strategy:     Option<String>,
	/// Reader verdict for a page or failed result.
	pub verdict:      Option<String>,
	/// Bot protection that answered instead of the page.
	pub wall:         Option<String>,
	/// Diagnostics from the read.
	pub notes:        Vec<String>,
	/// Whether a page was based on a truncated response.
	pub truncated:    Option<bool>,
	/// Blob MIME type.
	pub mime:         Option<String>,
	/// Suggested blob file extension.
	pub extension:    Option<String>,
	/// HTTP status of the failed response or the one a page came from.
	pub status:       Option<u16>,
}

impl From<reader::Output> for ReaderOutput {
	fn from(output: reader::Output) -> Self {
		match output {
			reader::Output::Page(page) => Self {
				kind:         "page".into(),
				url:          page.url,
				content:      Some(page.content),
				format:       Some(page.format.into()),
				content_type: Some(page.content_type),
				title:        page.title,
				strategy:     Some(page.strategy),
				verdict:      Some(page.verdict),
				wall:         page.wall,
				notes:        page.notes,
				truncated:    Some(page.truncated),
				mime:         None,
				extension:    None,
				status:       (page.status != 0).then_some(page.status),
			},
			reader::Output::Blob { mime, url, extension } => Self {
				kind: "blob".into(),
				url,
				mime: Some(mime),
				extension: Some(extension),
				..Self::default()
			},
			reader::Output::Failed { status, url, verdict, wall, notes } => Self {
				kind: "failed".into(),
				url,
				verdict: Some(verdict),
				wall,
				notes,
				status: Some(status),
				..Self::default()
			},
		}
	}
}

/// Reads a URL one step at a time; the host performs all network and browser
/// I/O.
#[napi]
pub struct Reader {
	inner: Arc<Mutex<reader::Reader>>,
}

#[napi]
impl Reader {
	/// Create a reader. Resolve each requested step before opening another URL.
	#[napi(constructor)]
	pub fn new(options: Option<ReaderOptions>) -> Result<Self> {
		let options = options.unwrap_or_default();
		let render = render_options(
			options.format.as_deref(),
			options.mode.as_deref(),
			options.hidden.as_deref(),
			options.images,
			options.width,
		)?;
		let remote = options
			.remote
			.unwrap_or_default()
			.into_iter()
			.map(|backend| {
				let kind = remote::Kind::parse(&backend.kind).ok_or_else(|| {
					Error::from_reason("Invalid remote kind: expected jina, firecrawl, or parallel")
				})?;
				Ok(remote::Backend { kind, api_key: backend.api_key, base_url: backend.base_url })
			})
			.collect::<Result<Vec<_>>>()?;
		Ok(Self {
			inner: Arc::new(Mutex::new(reader::Reader::new(reader::Options {
				raw: options.raw.unwrap_or_default(),
				render,
				browser: options.browser.unwrap_or_default(),
				user_agents: options.user_agents.unwrap_or_default(),
				sites: options.sites.unwrap_or(true),
				site_credentials: options
					.site_credentials
					.unwrap_or_default()
					.into_iter()
					.map(|credential| (credential.site, credential.token))
					.collect(),
				site_settings: options
					.site_settings
					.unwrap_or_default()
					.into_iter()
					.map(|setting| (setting.key, setting.value))
					.collect(),
				now_ms: options.now_ms.map_or_else(
					|| {
						SystemTime::now()
							.duration_since(UNIX_EPOCH)
							.map_or(0, |elapsed| elapsed.as_millis() as u64)
					},
					|ms| ms as u64,
				),
				api_user_agent: options
					.api_user_agent
					.unwrap_or_else(|| reader::Options::default().api_user_agent),
				remote,
				prefer_remote: options.prefer_remote.unwrap_or_default(),
			}))),
		})
	}

	/// Start reading a URL and return the first step.
	#[napi]
	pub fn open(&self, url: String) -> ReaderStep {
		self.inner.lock().open(&url).into()
	}

	/// Process a fetch or browser response on a worker thread.
	#[napi]
	pub fn resolve(&self, response: ReaderResponse) -> task::Promise<ReaderStep> {
		let inner = Arc::clone(&self.inner);
		let response = reader::Response {
			status:    response.status,
			url:       response.url,
			headers:   response
				.headers
				.into_iter()
				.map(|header| (header.name, header.value))
				.collect(),
			body:      response.body.map_or_default(Vec::from),
			truncated: response.truncated.unwrap_or_default(),
			error:     response.error,
		};
		task::blocking("reader.resolve", (), move |_| {
			let step = inner.lock().resolve(response);
			Ok(step.into())
		})
	}
}
