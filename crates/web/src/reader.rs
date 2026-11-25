//! Sans-I/O web reader: a state machine that asks its caller to fetch or
//! browse one URL at a time and turns the responses into the best content for
//! the page.
//!
//! A site handler ([`crate::sites`]) that owns the URL reads it first; when it
//! declines, the page is read. Escalation order for the page itself: the
//! user-agent ladder (rotating on refusal statuses and bot walls), then the
//! headless browser (`Step::Browse`) when `Options::browser` is on, then the
//! remote readers ([`crate::remote`]) for a 2xx challenge (never for a
//! refusal). A readable HTML page then tries, in order: a page-specific
//! Markdown alternate, `Accept: text/markdown` negotiation, the preferred
//! remote reader when `Options::prefer_remote` is on, and the local rendering.
//! A rendering with nothing in it tries the page's feed alternates, llms.txt
//! candidates and its first linked document, then the browser for a JS shell,
//! then the remote readers.

use std::{collections::VecDeque, mem};

use url::Url;

use crate::{
	decode, dom, facts,
	facts::AlternateKind,
	feed, remote,
	render::{self, Format, Rendered},
	sites,
	sniff::{self, Kind},
	strategy::{self, header},
	wall::{self, BLOCKED_STATUSES, MIN_RENDERED_CHARS, Verdict},
};

/// User agents a page fetch tries in turn while the site refuses the previous
/// one.
pub const USER_AGENTS: [&str; 3] = [
	"curl/8.0",
	"Mozilla/5.0 (compatible; TextBot/1.0)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
	 Chrome/131.0.0.0 Safari/537.36",
];
/// Page fetch attempts when transport errors repeat, even under a single user
/// agent.
const MIN_ATTEMPTS: usize = 3;
/// Most `Refresh` redirects followed for one read.
pub const MAX_REFRESH_HOPS: usize = 5;
/// A longer refresh delay is a periodic reload, not a redirect.
const MAX_REFRESH_DELAY_SECS: u32 = 10;
/// Leading bytes handed to `sniff::classify`.
const SNIFF_BYTES: usize = 4096;
/// `Accept-Encoding` of a page refetched after its identity response arrived
/// as undecodable bytes.
const COMPRESSED_ENCODINGS: &str = "gzip, deflate, br";
/// Failure statuses a browser load may get past besides the refusal statuses
/// (401 is how some news sites refuse a fetch).
const BROWSE_STATUSES: [u16; 1] = [401];

/// Reader configuration.
#[derive(Debug, Clone)]
pub struct Options {
	/// Return the decoded body as fetched: transport handling (user-agent
	/// ladder, walls, refresh) still applies, no strategy or rendering does,
	/// and the browser is never used.
	pub raw:              bool,
	/// How HTML is rendered.
	pub render:           render::Options,
	/// Escalate walls, refusals and JS shells to the headless browser.
	pub browser:          bool,
	/// User-agent ladder; empty uses [`USER_AGENTS`]. A single entry (a
	/// caller's own agent) never rotates on refusal.
	pub user_agents:      Vec<String>,
	/// Let site handlers ([`crate::sites`]) read the URLs they own.
	pub sites:            bool,
	/// `(site, token)` credentials for site handlers (for example `("github",
	/// token)`).
	pub site_credentials: Vec<(String, String)>,
	/// `(key, value)` settings for site handlers (for example `("x.model",
	/// model)`).
	pub site_settings:    Vec<(String, String)>,
	/// Caller's wall clock in ms since the Unix epoch, for site handlers'
	/// cache expiry and dates.
	pub now_ms:           u64,
	/// `User-Agent` of site-handler API requests that set none.
	pub api_user_agent:   String,
	/// Remote readers in priority order, tried after the user-agent ladder and
	/// the browser fail on a 2xx wall or a page that renders to nothing.
	pub remote:           Vec<remote::Backend>,
	/// Try the first remote reader before the local rendering of HTML pages.
	pub prefer_remote:    bool,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			raw:              false,
			render:           render::Options::default(),
			browser:          false,
			user_agents:      Vec::new(),
			sites:            true,
			site_credentials: Vec::new(),
			site_settings:    Vec::new(),
			now_ms:           0,
			api_user_agent:   "omp".to_owned(),
			remote:           Vec::new(),
			prefer_remote:    false,
		}
	}
}

/// Why a request is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
	/// The requested page.
	Page,
	/// The page again under the next user agent or after a transport error.
	UaRetry,
	/// The page again with compression negotiated, after its identity response
	/// arrived as undecodable bytes.
	Refetch,
	/// A `Refresh` header or meta refresh target.
	Refresh,
	/// A page-specific Markdown alternate.
	Alternate,
	/// The page with `Accept: text/markdown`.
	Negotiate,
	/// An llms.txt candidate.
	Llms,
	/// A page-specific feed alternate.
	Feed,
	/// A document the page links to.
	LinkedDoc,
	/// A site handler's API request.
	Site,
	/// A remote reader's request.
	Remote,
}

impl Purpose {
	/// Stable name reported to callers.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Page => "page",
			Self::UaRetry => "ua-retry",
			Self::Refetch => "refetch",
			Self::Refresh => "refresh",
			Self::Alternate => "alternate",
			Self::Negotiate => "negotiate",
			Self::Llms => "llms",
			Self::Feed => "feed",
			Self::LinkedDoc => "linked-doc",
			Self::Site => "site",
			Self::Remote => "remote",
		}
	}
}

/// Which responses the caller answers with one retry of the same request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retry {
	/// Never retry.
	None,
	/// Retry a 429 once after its `Retry-After`, waiting at most 10 seconds.
	RateLimit,
	/// Retry a 408, 429 or 5xx once after at most 2 seconds; a response asking
	/// for a longer wait is returned as is.
	Transient,
}

impl Retry {
	/// Stable name reported to callers.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::RateLimit => "rate-limit",
			Self::Transient => "transient",
		}
	}
}

/// One HTTP request for the caller to perform (redirects and cookies are the
/// caller's).
#[derive(Debug, Clone)]
pub struct Request {
	/// Absolute URL.
	pub url:       String,
	/// HTTP method.
	pub method:    String,
	/// Request headers.
	pub headers:   Vec<(String, String)>,
	/// Request body.
	pub body:      Option<Vec<u8>>,
	/// Body read bound.
	pub max_bytes: usize,
	/// Why the request is made.
	pub purpose:   Purpose,
	/// Which responses the caller retries once before resolving.
	pub retry:     Retry,
}

/// What the caller does next.
#[derive(Debug)]
pub enum Step {
	/// Perform the request and pass its response to [`Reader::resolve`].
	Fetch(Request),
	/// Load the URL in the headless browser and resolve with its rendered DOM as
	/// the body.
	Browse {
		/// URL to load.
		url: String,
	},
	/// The read is over.
	Done(Output),
}

/// The caller's response to a `Fetch` or `Browse` step.
#[derive(Debug, Clone, Default)]
pub struct Response {
	/// HTTP status; 0 for a transport error.
	pub status:    u16,
	/// Final URL after redirects; empty means the requested one.
	pub url:       String,
	/// Response headers.
	pub headers:   Vec<(String, String)>,
	/// Body bytes read (possibly cut at the request's `max_bytes`).
	pub body:      Vec<u8>,
	/// True when the body was cut.
	pub truncated: bool,
	/// Transport error message.
	pub error:     Option<String>,
}

/// Result of a read.
#[derive(Debug, Clone)]
pub enum Output {
	/// Readable content.
	Page(Page),
	/// A payload for a converter; the caller still holds its bytes.
	Blob {
		/// MIME type (`application/octet-stream` when undeclared).
		mime:      String,
		/// Final URL.
		url:       String,
		/// Extension from `Content-Disposition` or the URL path, or empty.
		extension: String,
	},
	/// No content.
	Failed {
		/// Last HTTP status; 0 for a transport error.
		status:  u16,
		/// Final URL.
		url:     String,
		/// `wall` or `failed`.
		verdict: String,
		/// Bot protection that answered instead of the page.
		wall:    Option<String>,
		/// Why.
		notes:   Vec<String>,
	},
}

/// Readable content of a page.
#[derive(Debug, Clone)]
pub struct Page {
	/// Content.
	pub content:      String,
	/// `markdown`, `text` or `raw`.
	pub format:       &'static str,
	/// MIME type of the source the content came from.
	pub content_type: String,
	/// Page title.
	pub title:        Option<String>,
	/// URL the content came from.
	pub url:          String,
	/// How the content was obtained.
	pub strategy:     String,
	/// Page verdict (`ok`, `wall`, `js-shell`, `empty`).
	pub verdict:      String,
	/// HTTP status of the response the content came from; 0 when unknown.
	pub status:       u16,
	/// Bot protection whose challenge page is the content (raw reads only).
	pub wall:         Option<String>,
	/// What the reader did on the way.
	pub notes:        Vec<String>,
	/// True when the source body was cut.
	pub truncated:    bool,
}

/// A fetched page response kept for the verdict once the ladder is exhausted.
struct Snapshot {
	status:       u16,
	url:          String,
	wall:         Option<String>,
	text:         String,
	content_type: String,
	truncated:    bool,
}

/// A rendered HTML page awaiting its probes.
struct Html {
	url:          Url,
	status:       u16,
	content_type: String,
	truncated:    bool,
	rendered:     Rendered,
}

/// A secondary request that may stand in for the page.
enum Probe {
	Alternate(Url),
	Negotiate(Url),
	Feed(Url),
	Llms(Url),
	LinkedDoc(Url),
	/// The preferred (first) remote reader, before the local rendering.
	Remote(Url),
}

impl Probe {
	const fn url(&self) -> &Url {
		match self {
			Self::Alternate(url)
			| Self::Negotiate(url)
			| Self::Feed(url)
			| Self::Llms(url)
			| Self::LinkedDoc(url)
			| Self::Remote(url) => url,
		}
	}

	const fn purpose(&self) -> Purpose {
		match self {
			Self::Alternate(_) => Purpose::Alternate,
			Self::Negotiate(_) => Purpose::Negotiate,
			Self::Feed(_) => Purpose::Feed,
			Self::Llms(_) => Purpose::Llms,
			Self::LinkedDoc(_) => Purpose::LinkedDoc,
			Self::Remote(_) => Purpose::Remote,
		}
	}
}

/// What the in-flight request is for.
#[derive(Default)]
enum Pending {
	#[default]
	Idle,
	Page,
	/// The browser is loading the page; `remote` is why remote readers may
	/// follow when it fails.
	Browse {
		fallback: Box<Output>,
		remote:   Option<String>,
	},
	Probe {
		html:  Box<Html>,
		queue: VecDeque<Probe>,
		probe: Probe,
	},
	Site(sites::Next),
	Remote {
		backend:  usize,
		url:      Url,
		fallback: Box<Output>,
		reason:   String,
	},
}

/// Sans-I/O reader for one URL at a time; one request is in flight at once.
pub struct Reader {
	options:    Options,
	agents:     Vec<String>,
	/// Page URL being fetched: the requested one or a refresh target.
	target:     String,
	/// Index of the page attempt; after success, of the agent that succeeded.
	attempt:    usize,
	saved:      Option<Snapshot>,
	last_error: Option<String>,
	hops:       usize,
	browsed:    bool,
	probed:     bool,
	/// The page was refetched with compression negotiated.
	compressed: bool,
	/// Next remote backend to try.
	remote:     usize,
	notes:      Vec<String>,
	pending:    Pending,
	context:    sites::Context,
}

impl Reader {
	/// A reader configured by `options`.
	pub fn new(options: Options) -> Self {
		let agents = if options.user_agents.is_empty() {
			USER_AGENTS.iter().map(|&agent| agent.to_owned()).collect()
		} else {
			options.user_agents.clone()
		};
		let context = sites::Context {
			credentials: options.site_credentials.clone(),
			now_ms:      options.now_ms,
			settings:    options.site_settings.clone(),
			remote:      options.remote.clone(),
			cache:       sites::Cache::default(),
		};
		Self {
			options,
			agents,
			target: String::new(),
			attempt: 0,
			saved: None,
			last_error: None,
			hops: 0,
			browsed: false,
			probed: false,
			compressed: false,
			remote: 0,
			notes: Vec::new(),
			pending: Pending::Idle,
			context,
		}
	}

	/// Start reading `url`, abandoning any read in progress.
	pub fn open(&mut self, url: &str) -> Step {
		url.clone_into(&mut self.target);
		self.attempt = 0;
		self.saved = None;
		self.last_error = None;
		self.hops = 0;
		self.browsed = false;
		self.probed = false;
		self.compressed = false;
		self.remote = 0;
		self.notes.clear();
		self.pending = Pending::Idle;
		let parsed = match Url::parse(url) {
			Ok(parsed) => parsed,
			Err(error) => {
				return Step::Done(Output::Failed {
					status:  0,
					url:     url.to_owned(),
					verdict: "failed".to_owned(),
					wall:    None,
					notes:   vec![format!("Invalid URL: {error}")],
				});
			},
		};
		if self.options.sites && !self.options.raw {
			let context = &self.context;
			if let Some(action) = sites::SITES
				.iter()
				.find_map(|site| (site.open)(&parsed, context))
			{
				return self.site(action);
			}
		}
		self.fetch_page(Purpose::Page)
	}

	/// Run a site handler's next action; a decline falls through to the page.
	fn site(&mut self, action: sites::Action) -> Step {
		match action {
			sites::Action::Done(finished) => done(Page {
				content:      strategy::finalize(&finished.markdown),
				format:       if finished.content_type.contains("markdown") {
					"markdown"
				} else {
					"text"
				},
				content_type: finished.content_type.to_owned(),
				title:        finished.title,
				url:          finished.url.unwrap_or_else(|| self.target.clone()),
				strategy:     finished.method.to_owned(),
				verdict:      Verdict::Ok.as_str().to_owned(),
				status:       0,
				wall:         None,
				notes:        finished.notes,
				truncated:    finished.truncated,
			}),
			sites::Action::Fetch(fetch, next) => {
				let mut headers = fetch.headers;
				if header(&headers, "user-agent").is_none() {
					headers.push(("User-Agent".to_owned(), self.options.api_user_agent.clone()));
				}
				if header(&headers, "accept-encoding").is_none() {
					headers.push(("Accept-Encoding".to_owned(), "identity".to_owned()));
				}
				self.pending = Pending::Site(next);
				Step::Fetch(Request {
					url: fetch.url,
					method: fetch.method.to_owned(),
					headers,
					body: fetch.body,
					max_bytes: fetch.max_bytes,
					purpose: Purpose::Site,
					retry: Retry::RateLimit,
				})
			},
		}
	}

	fn on_site(&mut self, response: Response, next: sites::Next) -> Step {
		let fetched = sites::Fetched {
			status:    response.status,
			url:       response.url,
			headers:   response.headers,
			body:      response.body,
			truncated: response.truncated,
		};
		match next(fetched, &self.context) {
			Some(action) => self.site(action),
			None => self.fetch_page(Purpose::Page),
		}
	}

	/// Feed the response to the last `Fetch` or `Browse` step.
	pub fn resolve(&mut self, response: Response) -> Step {
		match mem::take(&mut self.pending) {
			Pending::Idle => Step::Done(Output::Failed {
				status:  response.status,
				url:     self.target.clone(),
				verdict: "failed".to_owned(),
				wall:    None,
				notes:   vec!["The reader has no request in flight".to_owned()],
			}),
			Pending::Page => self.on_page(response),
			Pending::Browse { fallback, remote } => self.on_browse(response, *fallback, remote),
			Pending::Probe { html, queue, probe } => self.on_probe(response, *html, queue, probe),
			Pending::Site(next) => self.on_site(response, next),
			Pending::Remote { backend, url, fallback, reason } => {
				self.on_remote(&response, backend, url, *fallback, reason)
			},
		}
	}

	fn agent(&self) -> &str {
		&self.agents[self.attempt.min(self.agents.len() - 1)]
	}

	/// Whether the page attempt in flight uses the ladder's last user agent.
	const fn last_agent(&self) -> bool {
		self.agents.len() <= 1 || self.attempt + 1 >= self.agents.len()
	}

	fn request(&self, url: String, accept: &str, purpose: Purpose) -> Step {
		// A rate-limited agent is rotated first; only the last one waits out a
		// 429.
		let retry = match purpose {
			Purpose::Page | Purpose::UaRetry | Purpose::Refetch | Purpose::Refresh
				if self.last_agent() =>
			{
				Retry::RateLimit
			},
			_ => Retry::None,
		};
		Step::Fetch(Request {
			url,
			method: "GET".to_owned(),
			headers: vec![
				("User-Agent".to_owned(), self.agent().to_owned()),
				("Accept".to_owned(), accept.to_owned()),
				("Accept-Language".to_owned(), "en-US,en;q=0.5".to_owned()),
				// Cloudflare Markdown for Agents corrupts bytes when compression is
				// negotiated.
				("Accept-Encoding".to_owned(), "identity".to_owned()),
			],
			body: None,
			max_bytes: strategy::MAX_BYTES,
			purpose,
			retry,
		})
	}

	fn fetch_page(&mut self, purpose: Purpose) -> Step {
		self.pending = Pending::Page;
		self.request(self.target.clone(), strategy::ACCEPT_HTML, purpose)
	}

	fn retry(&mut self) -> Step {
		self.attempt += 1;
		self.fetch_page(Purpose::UaRetry)
	}

	/// The page again with compression negotiated: some servers compress
	/// whatever `Accept-Encoding: identity` says, and only a negotiated encoding
	/// gets their bytes decoded by the transport.
	fn refetch_compressed(&mut self) -> Step {
		self.compressed = true;
		let mut step = self.fetch_page(Purpose::Refetch);
		if let Step::Fetch(request) = &mut step {
			for (name, value) in &mut request.headers {
				if name.eq_ignore_ascii_case("accept-encoding") {
					COMPRESSED_ENCODINGS.clone_into(value);
				}
			}
		}
		step
	}

	fn on_page(&mut self, response: Response) -> Step {
		let rotates = self.agents.len() > 1;
		let last_agent = self.last_agent();
		let attempts = if rotates {
			self.agents.len()
		} else {
			MIN_ATTEMPTS
		};
		let url = if response.url.is_empty() {
			self.target.clone()
		} else {
			response.url.clone()
		};
		let status = response.status;

		if status == 0 {
			self.last_error = Some(
				response
					.error
					.unwrap_or_else(|| "transport error".to_owned()),
			);
			if self.attempt + 1 < attempts {
				return self.retry();
			}
			if let Some(saved) = self.saved.take() {
				return self.walled(saved);
			}
			let error = self.last_error.take();
			return self.failed(0, url, None, error);
		}

		let ok = (200..300).contains(&status);
		let content_type = header(&response.headers, "content-type")
			.unwrap_or_default()
			.to_owned();
		if !last_agent && BLOCKED_STATUSES.contains(&status) {
			// A refusal whose header names its wall is kept in case later agents
			// fare no better.
			if self.saved.is_none()
				&& let Some(name) = wall::http(status, &response.headers, "")
			{
				self.saved = Some(Snapshot {
					status,
					url,
					wall: Some(name),
					text: String::new(),
					content_type,
					truncated: false,
				});
			}
			return self.retry();
		}

		if response.body.is_empty() && !ok {
			// Once a wall is known, an error under another agent only means trying
			// the next one.
			if self.saved.is_some() && !last_agent {
				return self.retry();
			}
			if let Some(saved) = self.saved.take() {
				return self.walled(saved);
			}
			return self.failed(status, url, None, None);
		}

		let Ok(page_url) = Url::parse(&url) else {
			return self.failed(status, url, None, Some("invalid final URL".to_owned()));
		};
		let content_type_opt = (!content_type.is_empty()).then_some(content_type.as_str());
		let prefix = &response.body[..response.body.len().min(SNIFF_BYTES)];
		let kind = sniff::classify(content_type_opt, &page_url, prefix);
		let declared_text = content_type
			.trim_start()
			.get(..5)
			.is_some_and(|media| media.eq_ignore_ascii_case("text/"));
		if ok
			&& !self.compressed
			&& (kind != Kind::Blob || declared_text)
			&& sniff::looks_binary(content_type_opt, prefix)
		{
			return self.refetch_compressed();
		}
		let is_html = kind == Kind::Html;
		let text = if kind == Kind::Blob {
			String::new()
		} else {
			decode::decode(&response.body, content_type_opt, is_html)
		};
		let mut blocked = wall::http(status, &response.headers, &text);
		let rendered = (ok && is_html && !self.options.raw && blocked.is_none())
			.then(|| render::render(&text, Some(&page_url), &self.options.render));
		if let Some(Rendered { verdict: Verdict::Wall(name), .. }) = &rendered {
			blocked = Some(name.clone());
		}

		if blocked.is_some() && !last_agent {
			// A 2xx challenge outranks a refusal's wall: a browser can still pass
			// it.
			if self.saved.is_none() || ok {
				self.saved = Some(Snapshot {
					status,
					url,
					wall: blocked,
					text,
					content_type,
					truncated: response.truncated,
				});
			}
			return self.retry();
		}
		// The last agent's error yields to a saved wall, unless both are walls
		// and the saved one is a refusal.
		if !ok
			&& self
				.saved
				.as_ref()
				.is_some_and(|saved| blocked.is_none() || saved.status < 300)
		{
			if !last_agent {
				return self.retry();
			}
			if let Some(saved) = self.saved.take() {
				return self.walled(saved);
			}
		}
		if blocked.is_some() {
			return self.walled(Snapshot {
				status,
				url,
				wall: blocked,
				text,
				content_type,
				truncated: response.truncated,
			});
		}
		if !ok {
			return self.failed(status, url, None, None);
		}

		self.saved = None;
		self.last_error = None;
		let mime = strategy::mime(&content_type);
		if status == 204 {
			return done(Page {
				content: String::new(),
				format: "text",
				content_type: mime,
				title: None,
				url,
				strategy: "no-content".to_owned(),
				verdict: Verdict::Empty.as_str().to_owned(),
				status,
				wall: None,
				notes: vec!["HTTP 204 No Content".to_owned()],
				truncated: false,
			});
		}

		let refresh = header(&response.headers, "refresh")
			.and_then(|value| facts::parse_refresh(value, &page_url))
			.or_else(|| match &rendered {
				Some(rendered) => rendered.facts.refresh.clone(),
				None if is_html && mentions_refresh(&text) => dom::parse(&text)
					.ok()
					.and_then(|nodes| facts::collect(&nodes, &page_url).refresh),
				None => None,
			});
		if let Some(refresh) = refresh
			&& self.follows(&refresh, &page_url)
		{
			self.hops += 1;
			self
				.notes
				.push(format!("Followed refresh to {}", refresh.url));
			self.target = refresh.url.into();
			return self.fetch_page(Purpose::Refresh);
		}

		if kind == Kind::Blob {
			return blob(&page_url, &mime, &response.headers);
		}
		if self.options.raw {
			return done(Page {
				content: text,
				format: "raw",
				content_type: mime,
				title: None,
				url,
				strategy: "raw".to_owned(),
				verdict: Verdict::Ok.as_str().to_owned(),
				status,
				wall: None,
				notes: self.notes.clone(),
				truncated: response.truncated,
			});
		}
		if kind == Kind::Html {
			let rendered = rendered
				.unwrap_or_else(|| render::render(&text, Some(&page_url), &self.options.render));
			return self.html(Html {
				url: page_url,
				status,
				content_type: mime,
				truncated: response.truncated,
				rendered,
			});
		}
		let passthrough =
			|content: String, format: &'static str, strategy: &str, notes: Vec<String>| Page {
				content,
				format,
				content_type: mime.clone(),
				title: None,
				url: url.clone(),
				strategy: strategy.to_owned(),
				verdict: Verdict::Ok.as_str().to_owned(),
				status,
				wall: None,
				notes,
				truncated: response.truncated,
			};
		let notes = self.notes.clone();
		let page = match kind {
			Kind::Json => match strategy::pretty_json(&text) {
				Some(pretty) => passthrough(pretty, "text", "json", notes),
				None => passthrough(strategy::finalize(&text), "text", "text", notes),
			},
			Kind::Feed => match feed::to_markdown(&text, strategy::FEED_ITEMS) {
				Some(markdown) => passthrough(strategy::finalize(&markdown), "markdown", "feed", notes),
				None => passthrough(strategy::finalize(&text), "text", "text", notes),
			},
			Kind::Markdown => passthrough(strategy::finalize(&text), "markdown", "text", notes),
			Kind::Text | Kind::Xml | Kind::Blob | Kind::Html => {
				passthrough(strategy::finalize(&text), "text", "text", notes)
			},
		};
		done(page)
	}

	fn follows(&self, refresh: &facts::Refresh, page_url: &Url) -> bool {
		let same = |a: &Url, b: &Url| a.as_str().split('#').next() == b.as_str().split('#').next();
		self.hops < MAX_REFRESH_HOPS
			&& refresh.delay_secs <= MAX_REFRESH_DELAY_SECS
			&& matches!(refresh.url.scheme(), "http" | "https")
			&& !same(&refresh.url, page_url)
	}

	/// Queue the probes for a rendered page and start the first.
	fn html(&mut self, html: Html) -> Step {
		let mut queue = VecDeque::new();
		if !self.probed {
			self.probed = true;
			let facts = &html.rendered.facts;
			if let Some(alternate) = facts
				.alternates
				.iter()
				.find(|a| a.kind == AlternateKind::Markdown)
			{
				queue.push_back(Probe::Alternate(alternate.href.clone()));
			}
			queue.push_back(Probe::Negotiate(html.url.clone()));
			if self.options.prefer_remote && !self.options.remote.is_empty() {
				queue.push_back(Probe::Remote(html.url.clone()));
			}
			if renders_to_nothing(&html.rendered) {
				// A page-scoped feed stands in only for a page that renders to
				// nothing.
				queue.extend(
					facts
						.alternates
						.iter()
						.filter(|a| a.kind == AlternateKind::Feed)
						.take(strategy::MAX_FEED_PROBES)
						.map(|a| Probe::Feed(a.href.clone())),
				);
				queue.extend(
					strategy::llms_candidates(&html.url)
						.into_iter()
						.map(Probe::Llms),
				);
				if let Some(link) = facts.document_links.first() {
					queue.push_back(Probe::LinkedDoc(link.clone()));
				}
			} else if let Some(link) =
				strategy::wrapped_document(&html.rendered.content, &facts.document_links)
			{
				queue.push_back(Probe::LinkedDoc(link.clone()));
			}
		}
		self.next_probe(html, queue)
	}

	fn next_probe(&mut self, html: Html, mut queue: VecDeque<Probe>) -> Step {
		let Some(probe) = queue.pop_front() else {
			return self.finish_html(html);
		};
		let step = match &probe {
			Probe::Remote(url) => {
				// The preferred reader is the first; the later remote ladder skips
				// it.
				self.remote = self.remote.max(1);
				match remote::request(&self.options.remote[0], url) {
					Some(request) => Step::Fetch(request),
					None => return self.next_probe(html, queue),
				}
			},
			Probe::Negotiate(_) => self.request(
				probe.url().as_str().to_owned(),
				strategy::ACCEPT_MARKDOWN,
				probe.purpose(),
			),
			_ => self.request(probe.url().as_str().to_owned(), strategy::ACCEPT_HTML, probe.purpose()),
		};
		self.pending = Pending::Probe { html: Box::new(html), queue, probe };
		step
	}

	fn on_probe(
		&mut self,
		response: Response,
		html: Html,
		queue: VecDeque<Probe>,
		probe: Probe,
	) -> Step {
		if let Probe::Remote(url) = probe {
			let kind = self.options.remote[0].kind;
			let Some(content) = remote::parse(kind, &response) else {
				return self.next_probe(html, queue);
			};
			let mut notes = self.notes.clone();
			notes.push(format!("Read through {} (preferred reader)", kind.as_str()));
			return done(remote_page(content, url, kind, notes));
		}
		if !(200..300).contains(&response.status) {
			return self.next_probe(html, queue);
		}
		let url = if response.url.is_empty() {
			probe.url().to_string()
		} else {
			response.url.clone()
		};
		let content_type = header(&response.headers, "content-type").unwrap_or_default();
		let content_type_opt = (!content_type.is_empty()).then_some(content_type);
		let mime = strategy::mime(content_type);
		if let Probe::LinkedDoc(_) = probe {
			let Ok(doc_url) = Url::parse(&url) else {
				return self.next_probe(html, queue);
			};
			let prefix = &response.body[..response.body.len().min(SNIFF_BYTES)];
			if sniff::classify(content_type_opt, &doc_url, prefix) == Kind::Blob {
				return blob(&doc_url, &mime, &response.headers);
			}
			return self.next_probe(html, queue);
		}
		let text = decode::decode(&response.body, content_type_opt, false);
		if wall::http(response.status, &response.headers, &text).is_some() {
			return self.next_probe(html, queue);
		}
		let found = match &probe {
			Probe::Alternate(href) if strategy::usable_markdown(&text) => Some((
				strategy::finalize(without_leading_comments(&text)),
				"text/markdown".to_owned(),
				"alternate-markdown",
				format!("Used markdown alternate: {href}"),
			)),
			Probe::Negotiate(_)
				if (mime.contains("markdown") || mime == "text/plain")
					&& !text.trim().is_empty()
					&& !strategy::looks_like_html(&text)
					&& !strategy::is_soft_404(&text) =>
			{
				Some((
					strategy::finalize(without_leading_comments(&text)),
					mime,
					"content-negotiation",
					format!("Content negotiation returned {content_type}"),
				))
			},
			Probe::Feed(href) if strategy::usable_feed(&text) => {
				feed::to_markdown(&text, strategy::FEED_ITEMS).map(|markdown| {
					(
						strategy::finalize(&markdown),
						"application/feed".to_owned(),
						"alternate-feed",
						format!("Used feed alternate: {href}"),
					)
				})
			},
			Probe::Llms(href) if strategy::usable_markdown(&text) => Some((
				strategy::finalize(&text),
				"text/plain".to_owned(),
				"llms.txt",
				format!("Used llms.txt fallback: {href}"),
			)),
			_ => None,
		};
		let Some((content, content_type, strategy, note)) = found else {
			return self.next_probe(html, queue);
		};
		let mut notes = self.notes.clone();
		notes.push(note);
		done(Page {
			content,
			format: "markdown",
			content_type,
			title: html.rendered.title,
			url,
			strategy: strategy.to_owned(),
			verdict: Verdict::Ok.as_str().to_owned(),
			status: response.status,
			wall: None,
			notes,
			truncated: response.truncated,
		})
	}

	/// Probes are exhausted: return the rendering, or send a JS shell to the
	/// browser.
	fn finish_html(&mut self, html: Html) -> Step {
		let nothing = renders_to_nothing(&html.rendered);
		let shell =
			matches!(html.rendered.verdict, Verdict::JsShell) && html.rendered.strategy != "embedded";
		let browse = shell && self.options.browser && !self.browsed;
		let url = html.url.clone();
		let output = self.html_output(html);
		let remote = nothing.then(|| "The page rendered no usable content".to_owned());
		if browse {
			self.browsed = true;
			self.pending = Pending::Browse { fallback: Box::new(output), remote };
			return Step::Browse { url: url.into() };
		}
		match remote {
			Some(reason) => self.remote(url, output, reason, false),
			None => Step::Done(output),
		}
	}

	fn html_output(&self, html: Html) -> Output {
		let mut rendered = html.rendered;
		// A script shell with nothing better left reads as its Open Graph
		// summary.
		let summary = rendered.summary.take();
		let (body, method) = match summary {
			Some(summary) => (summary, "embedded-summary"),
			None => (mem::take(&mut rendered.content), rendered.strategy),
		};
		let embedded = method.starts_with("embedded");
		let mut notes = self.notes.clone();
		match &rendered.verdict {
			Verdict::JsShell if method == "embedded" => {
				notes.push("Read from data embedded in the page".to_owned());
			},
			Verdict::JsShell if embedded => {
				notes.push(
					"Page appears to require JavaScript; read only its Open Graph summary".to_owned(),
				);
			},
			Verdict::JsShell => {
				notes.push("Page appears to require JavaScript or is mostly navigation".to_owned());
			},
			Verdict::Empty => notes.push("HTML rendering produced no usable content".to_owned()),
			Verdict::Wall(name) => notes.push(format!("Blocked by bot protection ({name})")),
			Verdict::Ok => {},
		}
		let format = if embedded {
			"markdown"
		} else {
			match self.options.render.format {
				Format::Markdown => "markdown",
				Format::Text => "text",
			}
		};
		let mut content = strategy::finalize(&body);
		// Embedded data already opens with its own title; a page with no content
		// keeps none, so its verdict stands alone.
		if format == "markdown" && !embedded && !content.is_empty() {
			content = front_matter(&rendered.facts) + &content;
		}
		let wall = match &rendered.verdict {
			Verdict::Wall(name) => Some(name.clone()),
			_ => None,
		};
		Output::Page(Page {
			content,
			format,
			content_type: html.content_type,
			title: rendered.title,
			url: html.url.into(),
			strategy: method.to_owned(),
			verdict: rendered.verdict.as_str().to_owned(),
			status: html.status,
			wall,
			notes,
			truncated: html.truncated,
		})
	}

	fn on_browse(&mut self, response: Response, fallback: Output, remote: Option<String>) -> Step {
		if response.status == 0 {
			let error = response.error.unwrap_or_else(|| "no response".to_owned());
			return self.after_browse(
				fallback,
				format!("The headless browser failed: {error}"),
				remote,
			);
		}
		let url = if response.url.is_empty() {
			self.target.clone()
		} else {
			response.url.clone()
		};
		let Ok(page_url) = Url::parse(&url) else {
			return self.after_browse(
				fallback,
				"The headless browser returned an invalid URL".to_owned(),
				remote,
			);
		};
		let content_type =
			header(&response.headers, "content-type").unwrap_or("text/html; charset=utf-8");
		let text = decode::decode(&response.body, Some(content_type), true);
		if let Some(name) = wall::http(response.status, &response.headers, &text) {
			return self.after_browse(
				fallback,
				format!("The headless browser was also stopped by {name}"),
				remote,
			);
		}
		if !(200..300).contains(&response.status) {
			let note = format!("The headless browser got HTTP {}", response.status);
			return self.after_browse(fallback, note, remote);
		}
		let rendered = render::render(&text, Some(&page_url), &self.options.render);
		if let Verdict::Wall(name) = &rendered.verdict {
			let note = format!("The headless browser was also stopped by {name}");
			return self.after_browse(fallback, note, remote);
		}
		// An empty or shell DOM never stands in for the page, even before the
		// page's own probes ran (a wall's challenge is still navigating).
		if renders_to_nothing(&rendered) && (self.probed || !matches!(rendered.verdict, Verdict::Ok))
		{
			let note = "The headless browser rendered no more content".to_owned();
			return self.after_browse(fallback, note, remote);
		}
		self.notes.push("Rendered in a headless browser".to_owned());
		self.html(Html {
			url: page_url,
			status: response.status,
			content_type: "text/html".to_owned(),
			truncated: response.truncated,
			rendered,
		})
	}

	/// The browser did not get the page: remote readers next when allowed, else
	/// the fallback.
	fn after_browse(&mut self, fallback: Output, note: String, remote: Option<String>) -> Step {
		let fallback = with_note(fallback, note);
		match (remote, Url::parse(output_url(&fallback))) {
			(Some(reason), Ok(url)) => self.remote(url, fallback, reason, false),
			_ => Step::Done(fallback),
		}
	}

	/// Ask the next remote reader that can serve `url`; the fallback once none
	/// is left.
	fn remote(&mut self, url: Url, fallback: Output, reason: String, tried: bool) -> Step {
		while let Some(backend) = self.options.remote.get(self.remote) {
			let index = self.remote;
			self.remote += 1;
			if let Some(request) = remote::request(backend, &url) {
				self.pending =
					Pending::Remote { backend: index, url, fallback: Box::new(fallback), reason };
				return Step::Fetch(request);
			}
		}
		if tried {
			return Step::Done(with_note(fallback, "No remote reader returned the page".to_owned()));
		}
		Step::Done(fallback)
	}

	fn on_remote(
		&mut self,
		response: &Response,
		backend: usize,
		url: Url,
		fallback: Output,
		reason: String,
	) -> Step {
		let kind = self.options.remote[backend].kind;
		let Some(content) = remote::parse(kind, response) else {
			return self.remote(url, fallback, reason, true);
		};
		let mut notes = self.notes.clone();
		notes.push(format!("{reason}; read through {}", kind.as_str()));
		done(remote_page(content, url, kind, notes))
	}

	/// The ladder ended on a wall.
	fn walled(&mut self, snapshot: Snapshot) -> Step {
		let wall = snapshot.wall.unwrap_or_else(|| "unknown".to_owned());
		if self.options.raw && (200..300).contains(&snapshot.status) {
			// A raw read returns a challenge page as fetched.
			let mut notes = self.notes.clone();
			notes.push(format!("Blocked by bot protection ({wall}, HTTP {})", snapshot.status));
			return done(Page {
				content: snapshot.text,
				format: "raw",
				content_type: strategy::mime(&snapshot.content_type),
				title: None,
				url: snapshot.url,
				strategy: "raw".to_owned(),
				verdict: "wall".to_owned(),
				status: snapshot.status,
				wall: Some(wall),
				notes,
				truncated: snapshot.truncated,
			});
		}
		self.failed(snapshot.status, snapshot.url, Some(wall), None)
	}

	/// The ladder ended without content: browse when allowed, else fail.
	fn failed(
		&mut self,
		status: u16,
		url: String,
		wall: Option<String>,
		error: Option<String>,
	) -> Step {
		let mut notes = self.notes.clone();
		match &wall {
			Some(name) if (200..300).contains(&status) => {
				notes.push(format!("Blocked by bot protection ({name}, HTTP {status})"));
			},
			_ => {
				notes.push(if status == 0 {
					"Failed to fetch URL".to_owned()
				} else {
					format!("Failed to fetch URL (HTTP {status})")
				});
				if let Some(name) = &wall {
					notes.push(format!("Blocked by bot protection ({name})"));
				}
			},
		}
		if let Some(error) = error {
			notes.push(format!("Cause: {error}"));
		}
		let escalates = wall.is_some()
			|| status == 0
			|| BLOCKED_STATUSES.contains(&status)
			|| BROWSE_STATUSES.contains(&status);
		// Remote readers only get a page whose wall served a challenge: a refusal
		// stays private.
		let remote = match &wall {
			Some(name) if (200..300).contains(&status) && !self.options.raw => {
				Some(format!("Direct fetch was stopped by bot protection ({name}, HTTP {status})"))
			},
			_ => None,
		};
		let output = Output::Failed {
			status,
			url: url.clone(),
			verdict: if wall.is_some() { "wall" } else { "failed" }.to_owned(),
			wall,
			notes,
		};
		if escalates && self.options.browser && !self.options.raw && !self.browsed {
			self.browsed = true;
			self.pending = Pending::Browse { fallback: Box::new(output), remote };
			return Step::Browse { url };
		}
		match (remote, Url::parse(&url)) {
			(Some(reason), Ok(target)) => self.remote(target, output, reason, false),
			_ => Step::Done(output),
		}
	}
}

/// YAML front matter for a rendered page: `title`, `description`, `author`,
/// `published` and `canonical`, absent keys omitted; empty without any.
fn front_matter(facts: &facts::Facts) -> String {
	let canonical = facts.canonical.as_ref().map(Url::as_str);
	let fields = [
		("title", facts.title.as_deref()),
		("description", facts.description.as_deref()),
		("author", facts.author.as_deref()),
		("published", facts.published.as_deref()),
		("canonical", canonical),
	];
	let mut out = String::new();
	for (key, value) in fields {
		let Some(value) = value else {
			continue;
		};
		if out.is_empty() {
			out.push_str("---\n");
		}
		out.push_str(key);
		out.push_str(": ");
		yaml_scalar(&mut out, value);
		out.push('\n');
	}
	if !out.is_empty() {
		out.push_str("---\n\n");
	}
	out
}

/// Write `value` as a plain YAML scalar when it cannot be read as anything but
/// a string, else double-quoted.
fn yaml_scalar(out: &mut String, value: &str) {
	const RESERVED: [&str; 10] = ["true", "false", "yes", "no", "on", "off", "null", "y", "n", "~"];
	let plain = value.chars().next().is_some_and(char::is_alphabetic)
		&& !value.ends_with(' ')
		&& value.chars().all(|c| {
			c.is_alphanumeric()
				|| matches!(c, ' ' | '-' | '_' | '.' | ',' | '(' | ')' | '/' | '?' | '!' | '&' | '\'')
		})
		&& !RESERVED.iter().any(|word| value.eq_ignore_ascii_case(word));
	if plain {
		out.push_str(value);
		return;
	}
	out.push('"');
	for c in value.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\t' => out.push_str("\\t"),
			c if c.is_control() => {
				let _ = std::fmt::Write::write_fmt(out, format_args!("\\u{:04x}", c as u32));
			},
			c => out.push(c),
		}
	}
	out.push('"');
}

/// A remote reader's Markdown as the page.
fn remote_page(content: String, url: Url, kind: remote::Kind, notes: Vec<String>) -> Page {
	Page {
		content: strategy::finalize(&content),
		format: "markdown",
		content_type: "text/markdown".to_owned(),
		title: None,
		url: url.into(),
		strategy: kind.as_str().to_owned(),
		verdict: Verdict::Ok.as_str().to_owned(),
		status: 0,
		wall: None,
		notes,
		truncated: false,
	}
}

/// URL an output stands for.
fn output_url(output: &Output) -> &str {
	match output {
		Output::Page(page) => &page.url,
		Output::Blob { url, .. } | Output::Failed { url, .. } => url,
	}
}

/// Hand a payload to the caller's converters.
fn blob(url: &Url, mime: &str, headers: &[(String, String)]) -> Step {
	Step::Done(Output::Blob {
		mime:      if mime.is_empty() {
			"application/octet-stream".to_owned()
		} else {
			mime.to_owned()
		},
		url:       url.to_string(),
		extension: strategy::extension_hint(url, header(headers, "content-disposition")),
	})
}

const fn done(page: Page) -> Step {
	Step::Done(Output::Page(page))
}

/// True when a rendering holds nothing a reader can use.
fn renders_to_nothing(rendered: &Rendered) -> bool {
	if rendered.strategy == "embedded" {
		return false;
	}
	!matches!(rendered.verdict, Verdict::Ok)
		|| !strategy::longer_than(&rendered.content, MIN_RENDERED_CHARS)
}

/// Markdown without the HTML comments it opens with: metadata a renderer hides
/// (Apple's documentation alternates open with a JSON comment).
fn without_leading_comments(markdown: &str) -> &str {
	let mut rest = markdown.trim_start();
	while let Some(comment) = rest.strip_prefix("<!--") {
		let Some(end) = comment.find("-->") else {
			break;
		};
		rest = comment[end + 3..].trim_start();
	}
	rest
}

/// Cheap check before parsing a raw body for a meta refresh.
fn mentions_refresh(text: &str) -> bool {
	text
		.as_bytes()
		.windows(7)
		.any(|w| w.eq_ignore_ascii_case(b"refresh"))
}

fn with_note(output: Output, note: String) -> Output {
	match output {
		Output::Page(mut page) => {
			page.notes.push(note);
			Output::Page(page)
		},
		Output::Failed { status, url, verdict, wall, mut notes } => {
			notes.push(note);
			Output::Failed { status, url, verdict, wall, notes }
		},
		blob @ Output::Blob { .. } => blob,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const ARTICLE: &str = r"<html><head><title>Filing</title></head><body><main><h1>Quarterly report</h1>
<p>Revenue grew in the quarter while operating costs held steady across every segment. Revenue grew in the quarter while operating costs held steady across every segment. Revenue grew in the quarter while operating costs held steady across every segment. Revenue grew in the quarter while operating costs held steady across every segment.</p>
</main></body></html>";
	const CHALLENGE: &str =
		r#"<html><body><form><input name="js_challenge" value="1"/></form></body></html>"#;
	const SHELL: &str = r#"<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>"#;

	fn response(status: u16, content_type: &str, body: &str) -> Response {
		let headers = if content_type.is_empty() {
			Vec::new()
		} else {
			vec![("Content-Type".to_owned(), content_type.to_owned())]
		};
		Response { status, headers, body: body.as_bytes().to_vec(), ..Response::default() }
	}

	fn html(body: &str) -> Response {
		response(200, "text/html", body)
	}

	fn not_found() -> Response {
		response(404, "text/plain", "Not found")
	}

	fn agent(request: &Request) -> &str {
		header(&request.headers, "user-agent").unwrap_or_default()
	}

	struct Run {
		output:   Output,
		requests: Vec<(Purpose, String, String)>,
		browsed:  Vec<String>,
	}

	impl Run {
		fn purposes(&self) -> Vec<Purpose> {
			self.requests.iter().map(|(purpose, ..)| *purpose).collect()
		}

		fn page(&self) -> &Page {
			match &self.output {
				Output::Page(page) => page,
				other => panic!("expected a page, got {other:?}"),
			}
		}
	}

	/// Pump the reader with scripted responses; `browse` answers `Step::Browse`.
	fn pump(
		options: Options,
		url: &str,
		mut serve: impl FnMut(&Request) -> Response,
		mut browse: impl FnMut(&str) -> Response,
	) -> Run {
		let mut reader = Reader::new(options);
		let mut step = reader.open(url);
		let (mut requests, mut browsed) = (Vec::new(), Vec::new());
		for _ in 0..64 {
			step = match step {
				Step::Done(output) => return Run { output, requests, browsed },
				Step::Fetch(request) => {
					requests.push((request.purpose, request.url.clone(), agent(&request).to_owned()));
					let mut response = serve(&request);
					if response.url.is_empty() {
						response.url = request.url.clone();
					}
					reader.resolve(response)
				},
				Step::Browse { url } => {
					browsed.push(url.clone());
					let mut response = browse(&url);
					if response.url.is_empty() {
						response.url = url;
					}
					reader.resolve(response)
				},
			};
		}
		panic!("reader did not finish");
	}

	fn no_browser(url: &str) -> Response {
		panic!("unexpected browse of {url}")
	}

	fn browser_on() -> Options {
		Options { browser: true, ..Options::default() }
	}

	#[test]
	fn ua_ladder_rotates_past_a_refusal() {
		let run = pump(
			Options::default(),
			"https://sec.test/filing.htm",
			|request| match request.purpose {
				Purpose::Page | Purpose::UaRetry if agent(request).starts_with("curl/") => {
					response(403, "text/html", "<h1>403 Forbidden</h1>")
				},
				Purpose::Page | Purpose::UaRetry => html(ARTICLE),
				_ => not_found(),
			},
			no_browser,
		);
		assert!(
			run.page()
				.content
				.starts_with("---\ntitle: Filing\n---\n\n")
		);
		assert!(run.page().content.contains("Revenue grew in the quarter"));
		assert_eq!(run.purposes(), [Purpose::Page, Purpose::UaRetry, Purpose::Negotiate]);
		// Probes keep the agent the site accepted.
		assert_eq!(run.requests[2].2, USER_AGENTS[1]);
	}

	#[test]
	fn a_callers_agent_is_final_on_refusal_but_retried_after_transport_errors() {
		let options = || Options { user_agents: vec!["omp/test".to_owned()], ..Options::default() };
		let refused = pump(
			options(),
			"https://x.test/api",
			|_| response(403, "text/plain", "denied"),
			no_browser,
		);
		assert!(matches!(refused.output, Output::Failed { status: 403, .. }));
		assert_eq!(refused.requests.len(), 1);

		let mut calls = 0;
		let recovered = pump(
			options(),
			"https://x.test/api",
			|_| {
				calls += 1;
				if calls == 1 {
					Response { error: Some("timed out".to_owned()), ..Response::default() }
				} else {
					response(200, "text/plain", "recovered")
				}
			},
			no_browser,
		);
		assert_eq!(recovered.page().content, "recovered");
		assert!(recovered.requests.iter().all(|(.., ua)| ua == "omp/test"));
		assert_eq!(recovered.requests.len(), 2);
	}

	#[test]
	fn a_saved_challenge_outlives_later_refusals() {
		let run = pump(
			Options::default(),
			"https://x.test/canonical",
			|request| {
				if agent(request).starts_with("curl/") {
					html(CHALLENGE)
				} else {
					response(403, "text/plain", "Forbidden")
				}
			},
			no_browser,
		);
		let Output::Failed { status, url, verdict, notes, .. } = &run.output else {
			panic!("expected failure, got {:?}", run.output);
		};
		assert_eq!(
			(*status, url.as_str(), verdict.as_str()),
			(200, "https://x.test/canonical", "wall")
		);
		assert!(
			notes
				.iter()
				.any(|n| n.contains("JavaScript challenge, HTTP 200"))
		);
	}

	#[test]
	fn only_the_last_agent_waits_out_a_rate_limit() {
		let mut reader = Reader::new(Options::default());
		let mut retries = Vec::new();
		let mut step = reader.open("https://x.test/page");
		while let Step::Fetch(request) = step {
			if request.purpose == Purpose::Negotiate {
				break;
			}
			retries.push(request.retry);
			step = reader.resolve(response(429, "text/plain", "Too Many Requests"));
		}
		assert_eq!(retries, [Retry::None, Retry::None, Retry::RateLimit]);
	}

	#[test]
	fn a_wall_is_named_on_failures_and_raw_challenges() {
		let refused = pump(Options::default(), "https://x.test/q", |_| cloudflare(), no_browser);
		let Output::Failed { wall, .. } = &refused.output else {
			panic!("expected failure, got {:?}", refused.output);
		};
		assert_eq!(wall.as_deref(), Some("Cloudflare"));

		let raw = pump(
			Options { raw: true, ..Options::default() },
			"https://x.test/q",
			|request| {
				if agent(request).starts_with("curl/") {
					html(CHALLENGE)
				} else {
					response(403, "text/plain", "Forbidden")
				}
			},
			no_browser,
		);
		let page = raw.page();
		assert_eq!((page.status, page.wall.as_deref()), (200, Some("JavaScript challenge")));
	}

	#[test]
	fn binary_bytes_under_a_text_type_are_refetched_compressed() {
		let run = pump(
			Options { raw: true, ..Options::default() },
			"https://x.test/article",
			|request| {
				if request.purpose == Purpose::Refetch {
					assert_eq!(header(&request.headers, "accept-encoding"), Some(COMPRESSED_ENCODINGS));
					response(200, "text/html; charset=windows-1252", "<h1>Caf\u{e9}</h1>")
				} else {
					Response {
						status: 200,
						headers: vec![("Content-Type".to_owned(), "text/html".to_owned())],
						body: vec![0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0x03],
						..Response::default()
					}
				}
			},
			no_browser,
		);
		assert_eq!(run.purposes(), [Purpose::Page, Purpose::Refetch]);
		assert!(run.page().content.contains("Caf"));
	}

	#[test]
	fn an_empty_browser_dom_keeps_the_wall() {
		let run = pump(
			browser_on(),
			"https://x.test/thread",
			|request| match request.purpose {
				Purpose::Page | Purpose::UaRetry => html(CHALLENGE),
				_ => not_found(),
			},
			|_| html(""),
		);
		let Output::Failed { verdict, wall, .. } = &run.output else {
			panic!("expected failure, got {:?}", run.output);
		};
		assert_eq!((verdict.as_str(), wall.as_deref()), ("wall", Some("JavaScript challenge")));
	}

	#[test]
	fn a_shell_reads_as_its_open_graph_summary_once_nothing_else_is_found() {
		let shell = SHELL.replace(
			"<title>App</title>",
			r#"<title>App</title><meta property="og:description" content="Manage members, billing and security for the workspace">"#,
		);
		let run = pump(
			Options::default(),
			"https://x.test/app/",
			|request| {
				if request.purpose == Purpose::Page {
					html(&shell)
				} else {
					not_found()
				}
			},
			no_browser,
		);
		let page = run.page();
		assert_eq!((page.verdict.as_str(), page.strategy.as_str()), ("js-shell", "embedded-summary"));
		assert_eq!(page.content, "# App\n\nManage members, billing and security for the workspace");
	}

	#[test]
	fn a_challenge_then_error_still_tries_the_last_agent() {
		let run = pump(
			Options::default(),
			"https://x.test/filing.htm",
			|request| match agent(request) {
				ua if ua.starts_with("curl/") => html(CHALLENGE),
				ua if ua.contains("TextBot") => not_found(),
				_ if request.purpose == Purpose::Negotiate => not_found(),
				_ => html(ARTICLE),
			},
			no_browser,
		);
		assert!(run.page().content.contains("Revenue grew"));
	}

	fn cloudflare() -> Response {
		Response {
			status: 403,
			headers: vec![
				("content-type".to_owned(), "text/html".to_owned()),
				("cf-mitigated".to_owned(), "challenge".to_owned()),
			],
			body: b"<html><head><title>Just a moment...</title></head></html>".to_vec(),
			..Response::default()
		}
	}

	#[test]
	fn a_wall_goes_to_the_browser_and_its_dom_is_rendered() {
		let run = pump(
			browser_on(),
			"https://x.test/q/1",
			|request| match request.purpose {
				Purpose::Page | Purpose::UaRetry => cloudflare(),
				_ => not_found(),
			},
			|_| html(ARTICLE),
		);
		assert_eq!(run.browsed, ["https://x.test/q/1"]);
		let page = run.page();
		assert!(page.content.contains("Revenue grew"));
		assert!(
			page
				.notes
				.iter()
				.any(|n| n == "Rendered in a headless browser")
		);
		assert_eq!(run.purposes()[..3], [Purpose::Page, Purpose::UaRetry, Purpose::UaRetry]);
	}

	#[test]
	fn the_browser_off_never_browses() {
		let run = pump(Options::default(), "https://x.test/q/1", |_| cloudflare(), no_browser);
		let Output::Failed { status, verdict, notes, .. } = &run.output else {
			panic!("expected failure, got {:?}", run.output);
		};
		assert_eq!((*status, verdict.as_str()), (403, "wall"));
		assert!(
			notes
				.iter()
				.any(|n| n == "Blocked by bot protection (Cloudflare)")
		);
		assert_eq!(run.requests.len(), USER_AGENTS.len());
	}

	#[test]
	fn a_js_shell_with_embedded_data_never_browses() {
		let body = "Readers arrive at the lake before sunrise. They cross the bridge to watch the \
		            herons lift from the reeds as the tide turns. The bridge was closed last winter \
		            when the final storm swept away its wooden deck, but volunteers rebuilt it from \
		            salvaged planks in spring.";
		let data = serde_json::json!({ "@type": "NewsArticle", "headline": "A bridge restored", "articleBody": body });
		let page = format!(
			r#"<html><head><title>Shell</title><script type="application/ld+json">{data}</script></head><body><div id="root"></div><script src="/app.js"></script></body></html>"#
		);
		let run = pump(
			browser_on(),
			"https://x.test/story",
			|request| {
				if request.purpose == Purpose::Page {
					html(&page)
				} else {
					not_found()
				}
			},
			no_browser,
		);
		let page = run.page();
		assert_eq!(page.strategy, "embedded");
		assert!(page.content.contains("herons"));
		assert_eq!(run.purposes(), [Purpose::Page, Purpose::Negotiate]);
	}

	#[test]
	fn a_bare_js_shell_tries_its_probes_then_browses() {
		let run = pump(
			browser_on(),
			"https://x.test/app/",
			|request| {
				if request.purpose == Purpose::Page {
					html(SHELL)
				} else {
					not_found()
				}
			},
			|_| html(ARTICLE),
		);
		assert_eq!(run.browsed, ["https://x.test/app/"]);
		assert!(run.purposes().contains(&Purpose::Llms));
		assert!(run.page().content.contains("Revenue grew"));
	}

	#[test]
	fn refresh_chains_are_capped() {
		let run = pump(
			Options::default(),
			"https://x.test/r/0",
			|request| {
				let hop: usize = request.url.rsplit('/').next().unwrap().parse().unwrap_or(0);
				if request.purpose == Purpose::Negotiate {
					return not_found();
				}
				html(&format!(
					r#"<meta http-equiv="refresh" content="0; url=/r/{}">{ARTICLE}"#,
					hop + 1
				))
			},
			no_browser,
		);
		let refreshes = run
			.purposes()
			.iter()
			.filter(|p| **p == Purpose::Refresh)
			.count();
		assert_eq!(refreshes, MAX_REFRESH_HOPS);
		assert_eq!(run.page().url, format!("https://x.test/r/{MAX_REFRESH_HOPS}"));
	}

	#[test]
	fn a_refresh_header_applies_in_raw_mode() {
		let run = pump(
			Options { raw: true, ..Options::default() },
			"https://x.test/a",
			|request| {
				if request.url.ends_with("/a") {
					let mut response = response(200, "text/plain", "moved");
					response
						.headers
						.push(("Refresh".to_owned(), "0; url=/b".to_owned()));
					response
				} else {
					response(200, "text/plain", " body\r\n")
				}
			},
			no_browser,
		);
		assert_eq!(run.purposes(), [Purpose::Page, Purpose::Refresh]);
		assert_eq!(run.page().content, " body\r\n");
		assert_eq!(run.page().url, "https://x.test/b");
	}

	#[test]
	fn a_page_specific_markdown_alternate_is_preferred() {
		let page = format!(
			r#"<html><head><link rel="alternate" type="text/markdown" href="/guide/index.txt"></head><body>{ARTICLE}</body></html>"#
		);
		let markdown = format!("# GUIDE_MARKDOWN\n\n{}", "Guide prose. ".repeat(20));
		let run = pump(
			Options::default(),
			"https://x.test/guide/",
			|request| match request.purpose {
				Purpose::Page => html(&page),
				Purpose::Alternate => response(200, "text/markdown", &markdown),
				_ => not_found(),
			},
			no_browser,
		);
		let page = run.page();
		assert_eq!(page.strategy, "alternate-markdown");
		assert_eq!(page.url, "https://x.test/guide/index.txt");
		assert!(page.content.starts_with("# GUIDE_MARKDOWN"));
		assert_eq!(run.purposes(), [Purpose::Page, Purpose::Alternate]);
	}

	#[test]
	fn a_soft_404_markdown_suffix_is_rejected_and_never_guessed() {
		let releases = format!(
			r#"<html><head><title>Releases</title><link rel="alternate" type="text/markdown" href="index.html.md"></head><body><main><h1>Releases &amp; Upgrading</h1><p>{}</p></main></body></html>"#,
			"Upgrade notes for every supported release live on this page. ".repeat(4)
		);
		let not_found_md = format!(
			"---\ntitle: \"Page Not Found\"\n---\n# Page Not Found\n\n{}",
			"filler ".repeat(30)
		);
		let run = pump(
			Options::default(),
			"https://x.test/self-hosted/releases/",
			|request| match request.purpose {
				Purpose::Page => html(&releases),
				Purpose::Alternate => response(200, "text/markdown", &not_found_md),
				_ => not_found(),
			},
			no_browser,
		);
		assert!(run.page().content.contains("Releases & Upgrading"));
		assert!(!run.page().content.contains("Page Not Found"));

		// Without an advertised alternate no Markdown suffix is probed.
		let plain = pump(
			Options::default(),
			"https://x.test/release_notes.html",
			|request| {
				if request.purpose == Purpose::Page {
					html(ARTICLE)
				} else {
					not_found()
				}
			},
			no_browser,
		);
		assert!(plain.requests.iter().all(|(_, url, _)| {
			!std::path::Path::new(url)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
		}));
		assert_eq!(plain.purposes(), [Purpose::Page, Purpose::Negotiate]);
	}

	#[test]
	fn a_feed_stands_in_only_when_the_page_renders_to_nothing() {
		let rss = format!(
			r#"<?xml version="1.0"?><rss version="2.0"><channel><title>APP_FEED</title><item><title>Entry</title><description>{}</description></item></channel></rss>"#,
			"Feed entry text that is long enough to count. ".repeat(6)
		);
		let rss = rss.as_str();
		let feed_link = r#"<link rel="alternate" type="application/rss+xml" href="/app/index.xml">"#;
		let serve = |page: String| {
			move |request: &Request| match request.purpose {
				Purpose::Page => html(&page),
				Purpose::Feed => response(200, "application/rss+xml", rss),
				_ => not_found(),
			}
		};

		let shell = SHELL.replace("<title>", &format!("{feed_link}<title>"));
		let run1 = pump(Options::default(), "https://x.test/app", serve(shell), no_browser);
		let page = run1.page();
		assert_eq!(page.strategy, "alternate-feed");
		assert!(
			page
				.notes
				.contains(&"Used feed alternate: https://x.test/app/index.xml".to_owned())
		);
		assert!(page.content.contains("APP_FEED"));

		let post = ARTICLE.replace("<title>", &format!("{feed_link}<title>"));
		let run2 = pump(Options::default(), "https://x.test/app", serve(post), no_browser);
		assert!(run2.page().content.contains("Revenue grew"));
		assert!(!run2.purposes().contains(&Purpose::Feed));
	}

	#[test]
	fn non_text_payloads_pass_through_as_blobs() {
		let run = pump(
			Options::default(),
			"https://x.test/download",
			|_| {
				let mut response = response(200, "application/pdf", "%PDF-1.7");
				response.headers.push((
					"Content-Disposition".to_owned(),
					"attachment; filename=\"Paper.PDF\"".to_owned(),
				));
				response
			},
			no_browser,
		);
		let Output::Blob { mime, url, extension } = &run.output else {
			panic!("expected a blob, got {:?}", run.output);
		};
		assert_eq!(
			(mime.as_str(), url.as_str(), extension.as_str()),
			("application/pdf", "https://x.test/download", ".pdf")
		);
	}

	#[test]
	fn raw_mode_returns_bodies_as_fetched() {
		let raw = || Options { raw: true, ..Options::default() };
		for (content_type, body) in [
			("application/json", "{\"ok\":true}\n"),
			("text/plain", " \talpha\r\n\r\n\r\nomega\r\n "),
			("text/html", "<!doctype html>\n<html>\n\n\n<body>raw</body>\n</html>\n"),
		] {
			let run =
				pump(raw(), "https://x.test/body", |_| response(200, content_type, body), no_browser);
			let page = run.page();
			assert_eq!(
				(page.content.as_str(), page.format, page.strategy.as_str()),
				(body, "raw", "raw")
			);
			assert_eq!(page.content_type, content_type);
			assert!(page.notes.is_empty());
			assert_eq!(run.requests.len(), 1);
		}

		let challenge = pump(raw(), "https://x.test/post", |_| html(CHALLENGE), no_browser);
		assert_eq!(challenge.page().verdict, "wall");
		assert!(challenge.page().content.contains("js_challenge"));
		assert!(challenge.browsed.is_empty());
	}

	fn jina() -> Options {
		Options {
			remote: vec![
				remote::Backend { kind: remote::Kind::Firecrawl, api_key: None, base_url: None },
				remote::Backend { kind: remote::Kind::Jina, api_key: None, base_url: None },
			],
			..Options::default()
		}
	}

	const JINA_POST: &str = "Title: Post\n\nMarkdown Content:\n# Software 2.0\n\nNeural networks \
	                         are not just another classifier; they change how software is written. \
	                         Neural networks are not just another classifier.";

	#[test]
	fn a_challenge_goes_to_remote_readers_after_the_ladder() {
		let run = pump(
			jina(),
			"https://x.test/canonical",
			|request| match request.purpose {
				Purpose::Remote => response(200, "text/plain", JINA_POST),
				_ => html(CHALLENGE),
			},
			no_browser,
		);
		let page = run.page();
		assert_eq!((page.strategy.as_str(), page.url.as_str()), ("jina", "https://x.test/canonical"));
		assert!(page.content.starts_with("# Software 2.0"));
		assert!(
			page
				.notes
				.iter()
				.any(|n| n.contains("JavaScript challenge, HTTP 200); read through jina"))
		);
		// Firecrawl has no key, so the only remote request is Jina's.
		let remote: Vec<&str> = run
			.requests
			.iter()
			.filter(|r| r.0 == Purpose::Remote)
			.map(|r| r.1.as_str())
			.collect();
		assert_eq!(remote, ["https://r.jina.ai/https://x.test/canonical"]);
	}

	#[test]
	fn a_blocked_remote_copy_is_rejected_and_a_refusal_never_goes_remote() {
		let blocked = "Markdown Content:\nYou've been blocked by network security.\n\nTo continue, \
		               log in to your account or use your developer token";
		let run = pump(
			jina(),
			"https://x.test/post",
			|request| match request.purpose {
				Purpose::Remote => response(200, "text/plain", blocked),
				_ => html(CHALLENGE),
			},
			no_browser,
		);
		let Output::Failed { verdict, notes, .. } = &run.output else {
			panic!("expected failure, got {:?}", run.output);
		};
		assert_eq!(verdict, "wall");
		assert!(
			notes
				.iter()
				.any(|n| n == "No remote reader returned the page")
		);

		let refused = pump(jina(), "https://x.test/q/1", |_| cloudflare(), no_browser);
		assert!(matches!(refused.output, Output::Failed { status: 403, .. }));
		assert!(!refused.purposes().contains(&Purpose::Remote));
	}

	#[test]
	fn a_preferred_remote_reader_runs_before_the_local_rendering() {
		let options = Options { prefer_remote: true, ..jina() };
		let options = Options {
			remote: vec![remote::Backend {
				kind:     remote::Kind::Jina,
				api_key:  Some("k".to_owned()),
				base_url: None,
			}],
			..options
		};
		let run = pump(
			options,
			"https://x.test/filing",
			|request| match request.purpose {
				Purpose::Page => html(ARTICLE),
				Purpose::Remote => response(200, "text/plain", JINA_POST),
				_ => not_found(),
			},
			no_browser,
		);
		assert_eq!(run.page().strategy, "jina");
		assert_eq!(run.purposes(), [Purpose::Page, Purpose::Negotiate, Purpose::Remote]);
	}

	#[test]
	fn site_handlers_own_their_urls_and_fall_through_on_failure() {
		let api = serde_json::json!({
			"crate": { "name": "serde", "max_version": "1.0.0", "downloads": 1, "recent_downloads": 1 },
			"versions": []
		});
		let run = pump(
			Options { api_user_agent: "omp/test".to_owned(), ..Options::default() },
			"https://crates.io/crates/serde",
			|request| {
				assert_eq!(request.purpose, Purpose::Site);
				assert_eq!(agent(request), "omp/test");
				if request.url.contains("/api/") {
					response(200, "application/json", &api.to_string())
				} else {
					not_found()
				}
			},
			no_browser,
		);
		assert_eq!(run.page().strategy, "crates.io");
		assert_eq!(run.page().url, "https://crates.io/crates/serde");
		assert!(run.page().content.starts_with("# serde"));

		let fallback = pump(
			Options::default(),
			"https://crates.io/crates/serde",
			|request| match request.purpose {
				Purpose::Site => not_found(),
				Purpose::Page => html(ARTICLE),
				_ => not_found(),
			},
			no_browser,
		);
		assert_eq!(fallback.purposes(), [Purpose::Site, Purpose::Page, Purpose::Negotiate]);
		assert!(fallback.page().content.contains("Revenue grew"));

		let off = pump(
			Options { sites: false, ..Options::default() },
			"https://crates.io/crates/serde",
			|request| {
				if request.purpose == Purpose::Page {
					html(ARTICLE)
				} else {
					not_found()
				}
			},
			no_browser,
		);
		assert_eq!(off.purposes(), [Purpose::Page, Purpose::Negotiate]);
	}

	#[test]
	fn front_matter_quotes_what_yaml_would_misread() {
		let facts = facts::Facts {
			title: Some("Rust: a \"guide\"".to_owned()),
			author: Some("Ada Lovelace".to_owned()),
			published: Some("2024-01-02".to_owned()),
			canonical: Some(Url::parse("https://x.test/a").unwrap()),
			..facts::Facts::default()
		};
		assert_eq!(
			front_matter(&facts),
			"---\ntitle: \"Rust: a \\\"guide\\\"\"\nauthor: Ada Lovelace\npublished: \"2024-01-02\"\ncanonical: \"https://x.test/a\"\n---\n\n"
		);
		assert_eq!(front_matter(&facts::Facts::default()), "");
	}

	#[test]
	fn json_is_pretty_printed_and_204_is_an_empty_read() {
		let json = pump(
			Options::default(),
			"https://x.test/api",
			|_| response(200, "application/json", r#"{"b":1,"a":[2]}"#),
			no_browser,
		);
		assert_eq!(json.page().content, "{\n  \"b\": 1,\n  \"a\": [\n    2\n  ]\n}");
		assert_eq!(json.page().strategy, "json");

		let empty = pump(
			Options::default(),
			"https://x.test/healthz",
			|_| response(204, "text/html", ""),
			no_browser,
		);
		assert_eq!(empty.page().strategy, "no-content");
		assert!(
			empty
				.page()
				.notes
				.contains(&"HTTP 204 No Content".to_owned())
		);

		let failed =
			pump(Options::default(), "https://x.test/healthz", |_| response(503, "", ""), no_browser);
		let Output::Failed { status, notes, .. } = &failed.output else {
			panic!("expected failure");
		};
		assert_eq!(*status, 503);
		assert!(notes.contains(&"Failed to fetch URL (HTTP 503)".to_owned()));
	}
}
