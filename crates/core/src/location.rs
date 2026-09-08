//! Compact, namespace-safe location value types.

use std::fmt::{self, Display};

use crate::Str;

const NO_OFFSET: u16 = u16::MAX;

/// An error parsing a typed location.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LocationError {
	/// The location is empty.
	#[error("location must not be empty")]
	Empty,
	/// A filesystem-namespace path contains a forbidden character.
	#[error("path contains a NUL character")]
	InvalidPath,
	/// A tool path does not match its component grammar.
	#[error("invalid tool path")]
	InvalidToolPath,
	/// An artifact address is neither a canonical ordinal nor a BLAKE3 digest.
	#[error("invalid artifact address")]
	InvalidArtifactAddress,
	/// A URL carries a scheme other than the one required by its type.
	#[error("URL must use the {expected} scheme")]
	WrongScheme {
		/// The scheme required by the destination type.
		expected: &'static str,
	},
	/// A URI has no scheme or resource component, or contains forbidden
	/// characters.
	#[error("invalid URI")]
	InvalidUri,
}

macro_rules! path_type {
	($name:ident, $doc:literal) => {
		#[doc = $doc]
		#[derive(Debug, Clone, PartialEq, Eq, Hash)]
		#[repr(transparent)]
		pub struct $name(Str);

		impl $name {
			/// Parses a path in this location's filesystem namespace.
			pub fn new(value: impl Into<Str>) -> Result<Self, LocationError> {
				let value = value.into();
				if value.is_empty() {
					return Err(LocationError::Empty);
				}
				if value.as_bytes().contains(&0) {
					return Err(LocationError::InvalidPath);
				}
				Ok(Self(value))
			}

			/// Returns the path spelling without allocating.
			pub fn as_str(&self) -> &str {
				self.0.as_str()
			}
		}

		impl Display for $name {
			fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				formatter.write_str(self.as_str())
			}
		}
	};
}

path_type!(
	EnvPath,
	"A path in the workspace Environment's filesystem namespace.\n\nThis type deliberately does \
	 not implement `AsRef<Path>`: resolving it may require a remote Environment."
);
path_type!(
	ClientPath,
	"A path in the client machine's filesystem namespace.\n\nIt is distinct from [`EnvPath`], \
	 preventing a client path from being handed to an Environment API."
);

/// A parsed `name[/sub]` tool-tree path with an optional `@publisher/extension`
/// claimant.
///
/// Component accessors borrow from one compact [`Str`] allocation. Device name
/// and sub-tool segments match `^[a-z][a-z0-9_]{0,63}$`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ToolPath {
	text:            Str,
	name_end:        u16,
	sub_start:       u16,
	sub_end:         u16,
	claimant_start:  u16,
	extension_start: u16,
}

impl ToolPath {
	/// Parses a tool-tree path and optional claimant qualifier.
	pub fn new(value: impl Into<Str>) -> Result<Self, LocationError> {
		let text = value.into();
		if text.is_empty() {
			return Err(LocationError::Empty);
		}
		if text.len() >= usize::from(NO_OFFSET) {
			return Err(LocationError::InvalidToolPath);
		}

		let (path, claimant, claimant_start) = match text.as_str().split_once('@') {
			Some((path, claimant))
				if !path.is_empty() && !claimant.is_empty() && !claimant.contains('@') =>
			{
				(path, Some(claimant), path.len() + 1)
			},
			Some(_) => return Err(LocationError::InvalidToolPath),
			None => (text.as_str(), None, usize::from(NO_OFFSET)),
		};
		let (name, sub, sub_start, sub_end) = match path.split_once('/') {
			Some((name, sub)) if !sub.contains('/') => (name, Some(sub), name.len() + 1, path.len()),
			Some(_) => return Err(LocationError::InvalidToolPath),
			None => (path, None, usize::from(NO_OFFSET), usize::from(NO_OFFSET)),
		};
		if !valid_device_segment(name) || sub.is_some_and(|segment| !valid_device_segment(segment)) {
			return Err(LocationError::InvalidToolPath);
		}

		let extension_start = if let Some(claimant) = claimant {
			let Some((publisher, extension)) = claimant.split_once('/') else {
				return Err(LocationError::InvalidToolPath);
			};
			if publisher.is_empty()
				|| extension.is_empty()
				|| extension.contains('/')
				|| !publisher.bytes().all(valid_claimant_byte)
				|| !extension.bytes().all(valid_claimant_byte)
			{
				return Err(LocationError::InvalidToolPath);
			}
			claimant_start + publisher.len() + 1
		} else {
			usize::from(NO_OFFSET)
		};

		Ok(Self {
			name_end: name.len() as u16,
			sub_start: sub_start as u16,
			sub_end: sub_end as u16,
			claimant_start: claimant_start as u16,
			extension_start: extension_start as u16,
			text,
		})
	}

	/// Returns the canonical path spelling without allocating.
	pub fn as_str(&self) -> &str {
		self.text.as_str()
	}

	/// Returns the root device name.
	pub fn name(&self) -> &str {
		&self.as_str()[..usize::from(self.name_end)]
	}

	/// Returns the optional sub-tool name.
	pub fn sub(&self) -> Option<&str> {
		self.range(self.sub_start, self.sub_end)
	}

	/// Returns the optional `publisher/extension` claimant.
	pub fn claimant(&self) -> Option<&str> {
		if self.claimant_start == NO_OFFSET {
			None
		} else {
			Some(&self.as_str()[usize::from(self.claimant_start)..])
		}
	}

	/// Returns the claimant's publisher component when qualified.
	pub fn publisher(&self) -> Option<&str> {
		if self.claimant_start == NO_OFFSET {
			None
		} else {
			Some(
				&self.as_str()[usize::from(self.claimant_start)..usize::from(self.extension_start) - 1],
			)
		}
	}

	/// Returns the claimant's extension component when qualified.
	pub fn extension(&self) -> Option<&str> {
		if self.extension_start == NO_OFFSET {
			None
		} else {
			Some(&self.as_str()[usize::from(self.extension_start)..])
		}
	}

	fn range(&self, start: u16, end: u16) -> Option<&str> {
		(start != NO_OFFSET).then(|| &self.as_str()[usize::from(start)..usize::from(end)])
	}
}

impl Display for ToolPath {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

fn valid_device_segment(value: &str) -> bool {
	(1..=64).contains(&value.len())
		&& value.as_bytes()[0].is_ascii_lowercase()
		&& value
			.as_bytes()
			.iter()
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

const fn valid_claimant_byte(byte: u8) -> bool {
	byte.is_ascii_graphic() && !matches!(byte, b'/' | b'@' | b'\\')
}

/// The canonical address carried by an [`ArtifactUrl`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArtifactAddress<'a> {
	/// A session-local artifact ordinal.
	Ordinal(u64),
	/// A durable cross-session SHA-256 digest, without the `sha256/` prefix.
	Digest(&'a str),
}

/// A typed artifact address.
///
/// The canonical resource is either a session-local decimal `u64` ordinal or
/// `sha256/` followed by exactly 64 lowercase hexadecimal digest digits.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct ArtifactUrl(Str);

impl ArtifactUrl {
	/// Parses a canonical artifact URL, refusing other schemes and ambiguous
	/// addresses.
	pub fn new(value: impl Into<Str>) -> Result<Self, LocationError> {
		let value = value.into();
		let Some(after_scheme) = value.as_str().strip_prefix("artifact://") else {
			return Err(LocationError::WrongScheme { expected: "artifact" });
		};
		let (resource, selector) = match after_scheme.split_once(':') {
			Some((resource, selector)) => (resource, Some(selector)),
			None => (after_scheme, None),
		};
		if selector.is_some_and(str::is_empty)
			|| selector
				.unwrap_or_default()
				.bytes()
				.any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
			|| !valid_artifact_resource(resource)
		{
			return Err(LocationError::InvalidArtifactAddress);
		}
		Ok(Self(value))
	}

	/// Creates a canonical session-local artifact URL.
	pub fn from_ordinal(ordinal: u64) -> Self {
		Self(Str::from(format!("artifact://{ordinal}")))
	}

	/// Creates a canonical durable artifact URL from a SHA-256 digest.
	pub fn from_digest(digest: [u8; 32]) -> Self {
		Self(Str::from(format!("artifact://sha256/{}", crate::hex::encode(&digest))))
	}

	/// Returns the complete wire-form URL without allocating.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}

	/// Returns the canonical resource component with its selector removed.
	pub fn resource(&self) -> &str {
		let resource = self.after_scheme();
		resource.split_once(':').map_or(resource, |parts| parts.0)
	}

	/// Returns the optional trailing selector without its `:` delimiter.
	pub fn selector(&self) -> Option<&str> {
		self.after_scheme().split_once(':').map(|parts| parts.1)
	}

	/// Returns the parsed canonical artifact address.
	pub fn address(&self) -> ArtifactAddress<'_> {
		if let Some(digest) = self.resource().strip_prefix("sha256/") {
			ArtifactAddress::Digest(digest)
		} else {
			ArtifactAddress::Ordinal(
				self
					.resource()
					.parse()
					.expect("ArtifactUrl validates its ordinal at construction"),
			)
		}
	}

	/// Returns the session-local ordinal, or [`None`] for a durable address.
	pub fn ordinal(&self) -> Option<u64> {
		match self.address() {
			ArtifactAddress::Ordinal(ordinal) => Some(ordinal),
			ArtifactAddress::Digest(_) => None,
		}
	}

	/// Returns the borrowed durable digest, or [`None`] for a session-local
	/// address.
	pub fn digest(&self) -> Option<&str> {
		match self.address() {
			ArtifactAddress::Ordinal(_) => None,
			ArtifactAddress::Digest(digest) => Some(digest),
		}
	}

	fn after_scheme(&self) -> &str {
		&self.as_str()["artifact://".len()..]
	}
}

impl Display for ArtifactUrl {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

fn valid_artifact_resource(resource: &str) -> bool {
	if !resource.is_empty()
		&& resource.bytes().all(|byte| byte.is_ascii_digit())
		&& (resource == "0" || !resource.starts_with('0'))
	{
		return resource.parse::<u64>().is_ok();
	}
	let Some(digest) = resource.strip_prefix("sha256/") else {
		return false;
	};
	digest.len() == 64
		&& digest
			.bytes()
			.all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

macro_rules! typed_url {
	($name:ident, $scheme:literal, $doc:literal) => {
		#[doc = $doc]
		#[derive(Debug, Clone, PartialEq, Eq, Hash)]
		#[repr(transparent)]
		pub struct $name(Str);

		impl $name {
			/// Parses this typed URL, refusing every other scheme.
			pub fn new(value: impl Into<Str>) -> Result<Self, LocationError> {
				let value = value.into();
				let Some(resource) = value.as_str().strip_prefix(concat!($scheme, "://")) else {
					return Err(LocationError::WrongScheme { expected: $scheme });
				};
				let (resource, selector) = match resource.split_once(':') {
					Some((resource, selector)) => (resource, Some(selector)),
					None => (resource, None),
				};
				if resource.is_empty()
					|| selector.is_some_and(str::is_empty)
					|| resource
						.bytes()
						.chain(selector.unwrap_or_default().bytes())
						.any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
				{
					return Err(LocationError::InvalidUri);
				}
				Ok(Self(value))
			}

			/// Returns the complete wire-form URL without allocating.
			pub fn as_str(&self) -> &str {
				self.0.as_str()
			}

			/// Returns the resource component with its selector removed.
			pub fn resource(&self) -> &str {
				self
					.after_scheme()
					.split_once(':')
					.map_or(self.after_scheme(), |parts| parts.0)
			}

			/// Returns the optional trailing selector without its `:` delimiter.
			pub fn selector(&self) -> Option<&str> {
				self.after_scheme().split_once(':').map(|parts| parts.1)
			}

			fn after_scheme(&self) -> &str {
				&self.as_str()[concat!($scheme, "://").len()..]
			}
		}

		impl Display for $name {
			fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				formatter.write_str(self.as_str())
			}
		}
	};
}

// `ArtifactUrl` has a stricter two-tier address grammar than the generic typed
// URLs.
typed_url!(HistoryUrl, "history", "A typed `history://` address for a read-only agent transcript.");
typed_url!(AgentUrl, "agent", "A typed `agent://` address for settled subagent output.");

/// A canonical, machine-qualified workspace URI.
///
/// This is an identity value only; it performs no URL resolution or filesystem
/// access.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct WorkspaceUri(Str);

impl WorkspaceUri {
	/// Parses a non-empty absolute URI.
	pub fn new(value: impl Into<Str>) -> Result<Self, LocationError> {
		let value = value.into();
		let Some((scheme, resource)) = value.as_str().split_once("://") else {
			return Err(LocationError::InvalidUri);
		};
		if scheme.is_empty()
			|| resource.is_empty()
			|| !scheme.bytes().enumerate().all(|(index, byte)| {
				if index == 0 {
					byte.is_ascii_alphabetic()
				} else {
					byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
				}
			}) || value
			.as_bytes()
			.iter()
			.any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
		{
			return Err(LocationError::InvalidUri);
		}
		Ok(Self(value))
	}

	/// Returns the canonical URI without allocating.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}
}

impl Display for WorkspaceUri {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

#[cfg(test)]
mod tests {
	use super::{
		AgentUrl, ArtifactAddress, ArtifactUrl, HistoryUrl, LocationError, ToolPath, WorkspaceUri,
	};
	use crate::IntoStr;

	#[test]
	fn typed_urls_refuse_relabeling_other_schemes() {
		assert!(ArtifactUrl::new("artifact://17".into_str()).is_ok());
		assert_eq!(
			ArtifactUrl::new("history://17".into_str()),
			Err(LocationError::WrongScheme { expected: "artifact" })
		);
		assert!(HistoryUrl::new("agent://child".into_str()).is_err());
		assert!(AgentUrl::new("artifact://17".into_str()).is_err());
	}

	#[test]
	fn artifact_url_accessors_borrow_resource_and_parse_selectors_separately() {
		let url = ArtifactUrl::new("artifact://18446744073709551615:20-40".into_str()).unwrap();
		assert_eq!(url.resource(), "18446744073709551615");
		assert_eq!(url.selector(), Some("20-40"));
		assert_eq!(url.address(), ArtifactAddress::Ordinal(u64::MAX));
		assert_eq!(url.ordinal(), Some(u64::MAX));
		assert_eq!(url.digest(), None);
		assert_eq!(url.resource().as_ptr(), url.as_str()["artifact://".len()..].as_ptr());
		assert_eq!(url.as_str().as_ptr(), url.clone().as_str().as_ptr());
	}

	#[test]
	fn artifact_url_accepts_only_canonical_durable_digests() {
		const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		let url = ArtifactUrl::new(
			concat!(
				"artifact://sha256/",
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				":raw"
			)
			.into_str(),
		)
		.unwrap();
		assert_eq!(url.address(), ArtifactAddress::Digest(DIGEST));
		assert_eq!(url.digest(), Some(DIGEST));
		assert_eq!(url.ordinal(), None);
		assert_eq!(url.selector(), Some("raw"));

		let minted = ArtifactUrl::from_digest([0xab; 32]);
		assert_eq!(
			minted.digest(),
			Some("abababababababababababababababababababababababababababababababab")
		);
		assert_eq!(ArtifactUrl::from_ordinal(42).ordinal(), Some(42));
	}

	#[test]
	fn artifact_url_rejects_ambiguous_or_malformed_addresses() {
		for value in [
			"artifact://",
			"artifact://00",
			"artifact://01",
			"artifact://+1",
			"artifact://18446744073709551616",
			"artifact://sha256/abcdef",
			"artifact://sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			"artifact://1:",
		] {
			assert_eq!(ArtifactUrl::new(value.into_str()), Err(LocationError::InvalidArtifactAddress));
		}
	}

	#[test]
	fn tool_path_parses_subtool_and_claimant_without_component_storage() {
		let path = ToolPath::new("jira/create@ed25519:abcdef/acme.reviewer".into_str()).unwrap();
		assert_eq!(path.name(), "jira");
		assert_eq!(path.sub(), Some("create"));
		assert_eq!(path.claimant(), Some("ed25519:abcdef/acme.reviewer"));
		assert_eq!(path.publisher(), Some("ed25519:abcdef"));
		assert_eq!(path.extension(), Some("acme.reviewer"));
		assert_eq!(path.as_str().as_ptr(), path.name().as_ptr());
		assert_eq!(path.as_str().as_ptr(), path.clone().as_str().as_ptr());
	}

	#[test]
	fn tool_path_rejects_invalid_segments_and_claimants() {
		for value in ["", "UPPER", "jira/", "jira/create/more", "jira@publisher", "jira@/ext"] {
			assert!(matches!(
				ToolPath::new(value.into_str()),
				Err(LocationError::Empty | LocationError::InvalidToolPath)
			));
		}
	}

	#[test]
	fn workspace_uri_requires_an_absolute_uri() {
		assert!(WorkspaceUri::new("git+ssh://git@github.com/corp/repo.git".into_str()).is_ok());
		assert_eq!(WorkspaceUri::new("/work/repo".into_str()), Err(LocationError::InvalidUri));
	}
}
