//! Host-owned URI schemes the agent reads and writes (`set_host_uri_schemes`,
//! `host_uri_request`).

use std::{
	fmt,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use crate::{
	client::Error,
	host_tool::HostToolError,
	wire::{HostUriOperation, HostUriResultContentType, HostUriSchemeDefinition},
};

/// Error a handler returns; its text becomes the request's error result.
pub type HostUriError = HostToolError;

type ReadHandler = dyn Fn(&str, &HostUriContext) -> Result<HostUriRead, HostUriError> + Send + Sync;
type WriteHandler = dyn Fn(&str, &str, &HostUriContext) -> Result<(), HostUriError> + Send + Sync;

/// A `<scheme>://` namespace served by the host.
#[derive(Clone)]
pub struct HostUri {
	scheme:      String,
	description: Option<String>,
	immutable:   bool,
	read:        Arc<ReadHandler>,
	write:       Option<Arc<WriteHandler>>,
}

impl HostUri {
	/// `scheme` is trimmed and lowercased and must not be empty. The read
	/// handler runs on its own thread for every request and receives the full
	/// URL.
	pub fn new(
		scheme: &str,
		read: impl Fn(&str, &HostUriContext) -> Result<HostUriRead, HostUriError> + Send + Sync + 'static,
	) -> Result<Self, Error> {
		let scheme = scheme.trim().to_lowercase();
		if scheme.is_empty() {
			return Err(Error::InvalidArgument(
				"host URI scheme must be a non-empty string".to_owned(),
			));
		}
		Ok(Self { scheme, description: None, immutable: false, read: Arc::new(read), write: None })
	}

	/// Makes the scheme writable: the handler receives the URL and the full new
	/// content.
	pub fn write(
		mut self,
		handler: impl Fn(&str, &str, &HostUriContext) -> Result<(), HostUriError> + Send + Sync + 'static,
	) -> Self {
		self.write = Some(Arc::new(handler));
		self
	}

	pub fn description(mut self, description: impl Into<String>) -> Self {
		self.description = Some(description.into());
		self
	}

	/// Content never changes, so the agent may cache reads.
	pub fn immutable(mut self, immutable: bool) -> Self {
		self.immutable = immutable;
		self
	}

	pub fn scheme(&self) -> &str {
		&self.scheme
	}

	/// True when a write handler is set.
	pub fn writable(&self) -> bool {
		self.write.is_some()
	}

	/// The entry sent with `set_host_uri_schemes`.
	pub fn definition(&self) -> HostUriSchemeDefinition {
		HostUriSchemeDefinition {
			scheme:      self.scheme.clone(),
			description: self.description.clone(),
			writable:    Some(self.writable()),
			immutable:   Some(self.immutable),
		}
	}

	pub(crate) fn run_read(
		&self,
		url: &str,
		context: &HostUriContext,
	) -> Result<HostUriRead, HostUriError> {
		(self.read)(url, context)
	}

	/// `None` when the scheme has no write handler.
	pub(crate) fn run_write(
		&self,
		url: &str,
		content: &str,
		context: &HostUriContext,
	) -> Option<Result<(), HostUriError>> {
		self
			.write
			.as_ref()
			.map(|write| write(url, content, context))
	}
}

impl fmt::Debug for HostUri {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("HostUri")
			.field("scheme", &self.scheme)
			.field("description", &self.description)
			.field("immutable", &self.immutable)
			.field("writable", &self.writable())
			.finish_non_exhaustive()
	}
}

/// A read handler's result; `From<String>`/`From<&str>` give the text shortcut.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HostUriRead {
	pub content:      String,
	pub content_type: Option<HostUriResultContentType>,
	pub notes:        Option<Vec<String>>,
	pub immutable:    Option<bool>,
}

impl From<String> for HostUriRead {
	fn from(content: String) -> Self {
		Self { content, ..Self::default() }
	}
}

impl From<&str> for HostUriRead {
	fn from(content: &str) -> Self {
		Self::from(content.to_owned())
	}
}

/// Per-request context handed to a handler.
pub struct HostUriContext {
	pub(crate) url:       String,
	pub(crate) operation: HostUriOperation,
	pub(crate) cancelled: Arc<AtomicBool>,
}

impl HostUriContext {
	pub fn url(&self) -> &str {
		&self.url
	}

	pub fn operation(&self) -> HostUriOperation {
		self.operation
	}

	/// True once the server sent `host_uri_cancel` for this request or the
	/// client closed; nothing is sent for a cancelled request.
	pub fn is_cancelled(&self) -> bool {
		self.cancelled.load(Ordering::SeqCst)
	}
}

/// The URL's scheme, lowercased; empty when the URL has none.
pub(crate) fn uri_scheme(url: &str) -> String {
	let Some((scheme, _)) = url.split_once(':') else {
		return String::new();
	};
	let mut chars = scheme.chars();
	let valid = chars
		.next()
		.is_some_and(|first| first.is_ascii_alphabetic())
		&& chars.all(|char| char.is_ascii_alphanumeric() || matches!(char, '+' | '.' | '-'));
	if valid {
		scheme.to_ascii_lowercase()
	} else {
		String::new()
	}
}
