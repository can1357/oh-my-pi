//! Revision-3 browser-compatible room-link formatting, parsing, and endpoint
//! validation.

use std::{borrow::Cow, fmt};

use omp_core::{Str, base64_url, qr};
use thiserror::Error;
use url::Url;

use crate::crypto::{
	CryptoError, ROOM_ID_BYTES, ROOM_KEY_BYTES, RoomId, RoomKey, WRITE_TOKEN_BYTES, WriteToken,
};

/// Public collaboration relay used by compact bare links.
pub const DEFAULT_RELAY_URL: &str = "wss://my.omp.sh";
/// Browser and native collaboration room route.
pub const ROOM_PATH_PREFIX: &str = "/r/";
const OSC8_OPEN: &str = "\x1b]8;;";
const OSC8_CLOSE: &str = "\x1b]8;;\x1b\\";
const STRING_TERMINATOR: &str = "\x1b\\";
const QR_ANSI_DARK_ON_LIGHT: &str = "\x1b[30;47m";
const ANSI_RESET: &str = "\x1b[0m";
/// Light modules framing the symbol on each side, per the QR specification.
const QR_QUIET_ZONE: u16 = 4;

/// Terminal-ready browser join presentation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalJoinPresentation {
	/// Browser URL with credentials confined to the fragment.
	pub browser_url: Str,
	/// Scheme-less label wrapped in an OSC-8 hyperlink.
	pub hyperlink:   Str,
	/// ANSI-colored Unicode half-block QR rows with a four-module quiet zone.
	pub qr_rows:     Vec<Str>,
	/// Minimum terminal columns required to display the QR rows.
	pub min_columns: usize,
}

impl TerminalJoinPresentation {
	/// Selects QR rows for a transcript allocation.
	///
	/// A clipped symbol becomes one width-bounded row whose visible `Join`
	/// label retains the full browser URL as its OSC-8 target.
	pub fn qr_rows_for_layout(&self, columns: usize, allocated_rows: usize) -> Cow<'_, [Str]> {
		if columns >= self.min_columns && allocated_rows >= self.qr_rows.len() {
			return Cow::Borrowed(self.qr_rows.as_slice());
		}
		Cow::Owned(vec![self.clipped_qr_row(columns)])
	}

	fn clipped_qr_row(&self, columns: usize) -> Str {
		if columns == 0 {
			return Str::new_static("");
		}
		const LABEL: &str = "Join";
		const WIDTH_REASON: &str = " QR hidden: narrow terminal";
		const HEIGHT_REASON: &str = " QR hidden: clipped viewport";
		let label = &LABEL[..columns.min(LABEL.len())];
		let reason = if columns < self.min_columns {
			WIDTH_REASON
		} else {
			HEIGHT_REASON
		};
		let remaining = columns.saturating_sub(label.len());
		let suffix = &reason[..remaining.min(reason.len())];
		let mut row = String::with_capacity(
			OSC8_OPEN
				.len()
				.saturating_add(self.browser_url.len())
				.saturating_add(STRING_TERMINATOR.len())
				.saturating_add(label.len())
				.saturating_add(OSC8_CLOSE.len())
				.saturating_add(suffix.len()),
		);
		push_osc8_hyperlink(&mut row, &self.browser_url, label);
		row.push_str(suffix);
		Str::from(row)
	}
}

/// A query-free collaboration relay origin.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayEndpoint(Url);

impl RelayEndpoint {
	/// Validates and normalizes a relay origin. `http(s)` inputs are accepted
	/// as configuration convenience and converted to `ws(s)`.
	pub fn parse(input: &str) -> Result<Self, EndpointError> {
		let mut url = Url::parse(input.trim()).map_err(EndpointError::Parse)?;
		let websocket_scheme = match url.scheme() {
			"wss" | "https" => "wss",
			"ws" | "http" => "ws",
			_ => return Err(EndpointError::Scheme),
		};
		if websocket_scheme == "ws" && !is_local_hostname(url.host_str()) {
			return Err(EndpointError::InsecureRemote);
		}
		validate_origin(&url)?;
		url.set_scheme(websocket_scheme)
			.map_err(|()| EndpointError::Scheme)?;
		Ok(Self(url))
	}

	/// Returns the normalized relay origin.
	pub const fn as_url(&self) -> &Url {
		&self.0
	}

	/// Returns the room-specific WebSocket endpoint.
	pub fn room_url(&self, room_id: &RoomId) -> Url {
		let mut url = self.0.clone();
		url.set_path(&format!("{ROOM_PATH_PREFIX}{}", encode_room_id(room_id)));
		url
	}

	/// Transfers the validated URL to a transport owner.
	pub fn into_url(self) -> Url {
		self.0
	}
}

/// A query-free browser collaboration UI base.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebEndpoint(Url);

impl WebEndpoint {
	/// Validates a browser base. Plain HTTP is accepted only for localhost.
	pub fn parse(input: &str) -> Result<Self, EndpointError> {
		let mut url = Url::parse(input.trim()).map_err(EndpointError::Parse)?;
		if !matches!(url.scheme(), "http" | "https") {
			return Err(EndpointError::WebScheme);
		}
		if url.scheme() == "http" && !is_local_hostname(url.host_str()) {
			return Err(EndpointError::InsecureRemote);
		}
		validate_authority(&url)?;
		let path = url.path().trim_end_matches('/').to_owned();
		url.set_path(&path);
		Ok(Self(url))
	}

	/// Derives the matching browser origin from a relay.
	pub fn from_relay(relay: &RelayEndpoint) -> Self {
		let mut url = relay.0.clone();
		let scheme = if url.scheme() == "wss" {
			"https"
		} else {
			"http"
		};
		url.set_scheme(scheme)
			.expect("http and https are valid URL schemes");
		Self(url)
	}

	/// Returns the validated browser base.
	pub const fn as_url(&self) -> &Url {
		&self.0
	}
}

/// Credentials carried only in a compact link or browser fragment.
#[derive(Clone, Eq, PartialEq)]
pub enum LinkCredentials {
	/// A viewer can decrypt public room traffic but cannot mutate the host.
	ReadOnly([u8; ROOM_KEY_BYTES]),
	/// A trusted guest also carries the exact-width host write token.
	Full {
		/// AES-256 room key.
		key:         [u8; ROOM_KEY_BYTES],
		/// Host-authorized write token.
		write_token: [u8; WRITE_TOKEN_BYTES],
	},
}

impl LinkCredentials {
	/// Constructs read-only credentials.
	pub const fn read_only(key: [u8; ROOM_KEY_BYTES]) -> Self {
		Self::ReadOnly(key)
	}

	/// Constructs full-access credentials.
	pub const fn full(key: [u8; ROOM_KEY_BYTES], write_token: [u8; WRITE_TOKEN_BYTES]) -> Self {
		Self::Full { key, write_token }
	}

	/// Returns the room key.
	pub const fn key(&self) -> &[u8; ROOM_KEY_BYTES] {
		match self {
			Self::ReadOnly(key) | Self::Full { key, .. } => key,
		}
	}

	/// Returns a write token only for full-access links.
	pub const fn write_token(&self) -> Option<WriteToken> {
		match self {
			Self::ReadOnly(_) => None,
			Self::Full { write_token, .. } => Some(WriteToken::from_bytes(*write_token)),
		}
	}

	/// Reports whether the credentials are read-only.
	pub const fn is_read_only(&self) -> bool {
		matches!(self, Self::ReadOnly(_))
	}

	fn encoded(&self) -> String {
		match self {
			Self::ReadOnly(key) => base64_url::encode_raw(key).into_string(),
			Self::Full { key, write_token } => {
				let mut packed = [0_u8; ROOM_KEY_BYTES + WRITE_TOKEN_BYTES];
				packed[..ROOM_KEY_BYTES].copy_from_slice(key);
				packed[ROOM_KEY_BYTES..].copy_from_slice(write_token);
				base64_url::encode_raw(&packed).into_string()
			},
		}
	}
}

impl fmt::Debug for LinkCredentials {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("LinkCredentials")
			.field("read_only", &self.is_read_only())
			.finish_non_exhaustive()
	}
}

/// Parsed native collaboration room link.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabLink {
	relay:       RelayEndpoint,
	room_id:     RoomId,
	credentials: LinkCredentials,
}
/// Full and viewer links plus the opaque cryptographic owners needed to host
/// one room.
pub struct HostedRoom {
	/// Trusted writable-guest link.
	pub full:        CollabLink,
	/// Read-only viewer link.
	pub view:        CollabLink,
	/// Opaque frame key retained by the relay client.
	pub room_key:    RoomKey,
	/// Writable-peer admission authority retained by the host.
	pub write_token: WriteToken,
}

impl HostedRoom {
	/// Generates one room and both exact-width credential tiers.
	pub fn generate(relay: RelayEndpoint) -> Result<Self, CryptoError> {
		let room_id = RoomId::generate()?;
		let (room_key, raw_key) = RoomKey::generate()?;
		let write_token = WriteToken::generate()?;
		let full = CollabLink::new(
			relay.clone(),
			room_id,
			LinkCredentials::full(raw_key, *write_token.as_bytes()),
		);
		let view = CollabLink::new(relay, room_id, LinkCredentials::read_only(raw_key));
		Ok(Self { full, view, room_key, write_token })
	}
}

impl CollabLink {
	/// Creates one room link from validated components.
	pub const fn new(relay: RelayEndpoint, room_id: RoomId, credentials: LinkCredentials) -> Self {
		Self { relay, room_id, credentials }
	}

	/// Returns the relay origin.
	pub const fn relay(&self) -> &RelayEndpoint {
		&self.relay
	}

	/// Returns the room identifier.
	pub const fn room_id(&self) -> &RoomId {
		&self.room_id
	}

	/// Returns the link credentials.
	pub const fn credentials(&self) -> &LinkCredentials {
		&self.credentials
	}

	/// Returns the exact WebSocket room endpoint.
	pub fn room_url(&self) -> Url {
		self.relay.room_url(&self.room_id)
	}

	/// Renders the compact CLI form. The default relay collapses to
	/// `<room>.<credential>`; other secure relays omit only `wss://`.
	pub fn compact(&self) -> String {
		let room = encode_room_id(&self.room_id);
		let credential = self.credentials.encoded();
		if is_default_relay(&self.relay) {
			return format!("{room}.{credential}");
		}
		let origin = self.relay.as_url().as_str().trim_end_matches('/');
		if let Some(secure) = origin.strip_prefix("wss://") {
			format!("{secure}{ROOM_PATH_PREFIX}{room}.{credential}")
		} else {
			format!("{origin}{ROOM_PATH_PREFIX}{room}.{credential}")
		}
	}

	/// Renders a browser deep link. Credentials remain exclusively in the URL
	/// fragment and therefore never enter an HTTP request target.
	pub fn browser(&self, web: &WebEndpoint) -> String {
		format!("{}/#{}", web.as_url().as_str().trim_end_matches('/'), self.compact())
	}

	/// Builds a scannable terminal QR code and OSC-8 browser link.
	pub fn terminal_join(
		&self,
		web: &WebEndpoint,
	) -> Result<TerminalJoinPresentation, TerminalLinkError> {
		let browser_url = self.browser(web);
		let display = browser_url
			.strip_prefix("https://")
			.or_else(|| browser_url.strip_prefix("http://"))
			.unwrap_or(&browser_url);
		let hyperlink = osc8_hyperlink(&browser_url, display);
		let code = qr::QrCode::encode(browser_url.as_bytes(), qr::QrEc::M)?;
		let qr_rows = half_block_rows(&code);
		let min_columns = usize::from(code.side() + 2 * QR_QUIET_ZONE);
		Ok(TerminalJoinPresentation {
			browser_url: Str::from(browser_url),
			hyperlink,
			qr_rows,
			min_columns,
		})
	}

	/// Parses compact, relay, legacy-hash, percent-mangled, scheme-less, and
	/// nested browser forms.
	pub fn parse(input: &str) -> Result<Self, LinkError> {
		parse_inner(input, 0)
	}
}

/// Wraps a safe browser target in an OSC-8 hyperlink.
///
/// Control characters are stripped from the visible label. Callers should
/// pass a URL produced by [`CollabLink::browser`].
pub fn osc8_hyperlink(target: &str, label: &str) -> Str {
	let mut rendered = String::with_capacity(
		OSC8_OPEN
			.len()
			.saturating_add(target.len())
			.saturating_add(STRING_TERMINATOR.len())
			.saturating_add(label.len())
			.saturating_add(OSC8_CLOSE.len()),
	);
	push_osc8_hyperlink(&mut rendered, target, label);
	Str::from(rendered)
}

fn push_osc8_hyperlink(rendered: &mut String, target: &str, label: &str) {
	rendered.push_str(OSC8_OPEN);
	rendered.extend(target.chars().filter(|character| !character.is_control()));
	rendered.push_str(STRING_TERMINATOR);
	rendered.extend(label.chars().filter(|character| !character.is_control()));
	rendered.push_str(OSC8_CLOSE);
}

fn parse_inner(input: &str, depth: u8) -> Result<CollabLink, LinkError> {
	if depth > 2 {
		return Err(LinkError::Nested);
	}
	let normalized = input.trim().replace("%23", "#");
	let text = normalized.as_str();
	if let Some((room, credential)) = split_bare(text) {
		return decode_link(RelayEndpoint::parse(DEFAULT_RELAY_URL)?, room, credential);
	}

	let candidate = if text.contains("://") {
		text.to_owned()
	} else {
		format!("wss://{text}")
	};
	let url = Url::parse(&candidate).map_err(LinkError::Parse)?;
	if matches!(url.scheme(), "http" | "https")
		&& let Some(fragment) = url.fragment()
		&& let Ok(link) = parse_inner(fragment, depth + 1)
	{
		return Ok(link);
	}
	if !matches!(url.scheme(), "ws" | "wss" | "http" | "https") {
		if let Some(fragment) = url.fragment() {
			return parse_inner(fragment, depth + 1);
		}
		return Err(LinkError::Endpoint(EndpointError::Scheme));
	}

	let path = url.path();
	let Some(room_and_secret) = path.strip_prefix(ROOM_PATH_PREFIX) else {
		return Err(LinkError::RoomPath);
	};
	if room_and_secret.contains('/') {
		return Err(LinkError::RoomPath);
	}
	let (room, credential) = room_and_secret
		.split_once('.')
		.or_else(|| url.fragment().map(|fragment| (room_and_secret, fragment)))
		.ok_or(LinkError::MissingCredential)?;
	let relay = RelayEndpoint::parse(url.origin().ascii_serialization().as_str())?;
	decode_link(relay, room, credential)
}

fn split_bare(input: &str) -> Option<(&str, &str)> {
	let separator = input.find(['.', '#'])?;
	let (room, remainder) = input.split_at(separator);
	let credential = remainder.get(1..)?;
	if room.contains('/') || credential.contains(['.', '#', '/']) {
		return None;
	}
	Some((room, credential))
}

fn decode_link(
	relay: RelayEndpoint,
	room: &str,
	credential: &str,
) -> Result<CollabLink, LinkError> {
	if !is_base64url(room) || !is_base64url(credential) {
		return Err(LinkError::Encoding);
	}
	let room = base64_url::decode_raw(room.as_bytes())
		.into_vec()
		.map_err(|_| LinkError::Encoding)?;
	let room: [u8; ROOM_ID_BYTES] = room
		.try_into()
		.map_err(|value: Vec<u8>| LinkError::RoomWidth { actual: value.len() })?;
	let secret = base64_url::decode_raw(credential.as_bytes())
		.into_vec()
		.map_err(|_| LinkError::Encoding)?;
	let credentials = match secret.len() {
		ROOM_KEY_BYTES => {
			let key: [u8; ROOM_KEY_BYTES] =
				secret.try_into().expect("length checked before conversion");
			LinkCredentials::ReadOnly(key)
		},
		len if len == ROOM_KEY_BYTES + WRITE_TOKEN_BYTES => {
			let mut key = [0_u8; ROOM_KEY_BYTES];
			let mut write_token = [0_u8; WRITE_TOKEN_BYTES];
			key.copy_from_slice(&secret[..ROOM_KEY_BYTES]);
			write_token.copy_from_slice(&secret[ROOM_KEY_BYTES..]);
			LinkCredentials::Full { key, write_token }
		},
		actual => return Err(LinkError::CredentialWidth { actual }),
	};
	Ok(CollabLink::new(relay, RoomId::from_bytes(room), credentials))
}

fn encode_room_id(room_id: &RoomId) -> String {
	base64_url::encode_raw(room_id.as_bytes()).into_string()
}

/// Renders a symbol as ANSI dark-on-light half-block rows with the
/// four-module quiet zone; each terminal row carries two module rows.
fn half_block_rows(code: &qr::QrCode) -> Vec<Str> {
	let columns = code.side() + 2 * QR_QUIET_ZONE;
	let dark = |x: u16, y: u16| {
		let (Some(x), Some(y)) = (x.checked_sub(QR_QUIET_ZONE), y.checked_sub(QR_QUIET_ZONE)) else {
			return false;
		};
		code.dark(x, y)
	};
	(0..columns.div_ceil(2))
		.map(|row| {
			let mut line = String::with_capacity(
				QR_ANSI_DARK_ON_LIGHT.len() + usize::from(columns) * 3 + ANSI_RESET.len(),
			);
			line.push_str(QR_ANSI_DARK_ON_LIGHT);
			for column in 0..columns {
				line.push(match (dark(column, row * 2), dark(column, row * 2 + 1)) {
					(true, true) => '█',
					(true, false) => '▀',
					(false, true) => '▄',
					(false, false) => ' ',
				});
			}
			line.push_str(ANSI_RESET);
			Str::from(line)
		})
		.collect()
}

fn validate_origin(url: &Url) -> Result<(), EndpointError> {
	validate_authority(url)?;
	if url.path() != "/" && !url.path().is_empty() {
		return Err(EndpointError::BasePath);
	}
	Ok(())
}

fn validate_authority(url: &Url) -> Result<(), EndpointError> {
	if !url.username().is_empty()
		|| url.password().is_some()
		|| url.query().is_some()
		|| url.fragment().is_some()
	{
		return Err(EndpointError::SecretBearingEndpoint);
	}
	if url.host_str().is_none() {
		return Err(EndpointError::MissingHost);
	}
	Ok(())
}

fn is_default_relay(relay: &RelayEndpoint) -> bool {
	let url = relay.as_url();
	url.scheme() == "wss" && url.host_str() == Some("my.omp.sh") && url.port().is_none()
}

fn is_local_hostname(host: Option<&str>) -> bool {
	matches!(host, Some("localhost" | "127.0.0.1" | "::1"))
}

fn is_base64url(input: &str) -> bool {
	!input.is_empty()
		&& input
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Invalid collaboration endpoint.
#[derive(Debug, Error)]
pub enum EndpointError {
	/// URL syntax was invalid.
	#[error("invalid collaboration endpoint URL")]
	Parse(#[source] url::ParseError),
	/// Only WebSocket or HTTP relay schemes are accepted.
	#[error("collaboration relay URL must use ws, wss, http, or https")]
	Scheme,
	/// Browser bases require HTTP semantics.
	#[error("collaboration web URL must use http or https")]
	WebScheme,
	/// Plaintext transports are restricted to loopback hosts.
	#[error("insecure collaboration endpoints are allowed only for localhost")]
	InsecureRemote,
	/// User info, queries, and fragments are forbidden in configured endpoints.
	#[error("collaboration endpoint must not contain credentials, a query, or a fragment")]
	SecretBearingEndpoint,
	/// A relay endpoint must identify a host.
	#[error("collaboration endpoint must include a host")]
	MissingHost,
	/// Relay and browser settings are origins, not application routes.
	#[error("collaboration endpoint must not include a path")]
	BasePath,
}
/// Terminal join-link rendering failure.
#[derive(Debug, Error)]
pub enum TerminalLinkError {
	/// Browser link exceeded QR byte-mode capacity.
	#[error(transparent)]
	Qr(#[from] qr::QrOverflow),
}

/// Invalid collaboration room link.
#[derive(Debug, Error)]
pub enum LinkError {
	/// URL syntax was invalid.
	#[error("invalid collaboration link")]
	Parse(#[source] url::ParseError),
	/// The relay or web endpoint was invalid.
	#[error(transparent)]
	Endpoint(#[from] EndpointError),
	/// A nested deep link exceeded the normalization bound.
	#[error("collaboration link nesting is too deep")]
	Nested,
	/// Only the route is accepted.
	#[error("collaboration link must contain a /r/<room> route")]
	RoomPath,
	/// The room route omitted credentials.
	#[error("collaboration link is missing credentials")]
	MissingCredential,
	/// Room or credential text was not unpadded base64url.
	#[error("collaboration room and credentials must be unpadded base64url")]
	Encoding,
	/// Room identifiers are exact-width.
	#[error("collaboration room identifier decoded to {actual} bytes, expected 16")]
	RoomWidth {
		/// Actual decoded byte length.
		actual: usize,
	},
	/// Link credentials are exact-width.
	#[error("collaboration credentials decoded to {actual} bytes, expected 32 or 48")]
	CredentialWidth {
		/// Actual decoded byte length.
		actual: usize,
	},
}

#[cfg(test)]
mod tests {
	use super::*;

	fn link(full: bool) -> CollabLink {
		let credentials = if full {
			LinkCredentials::full([2; ROOM_KEY_BYTES], [3; WRITE_TOKEN_BYTES])
		} else {
			LinkCredentials::read_only([2; ROOM_KEY_BYTES])
		};
		CollabLink::new(
			RelayEndpoint::parse(DEFAULT_RELAY_URL).expect("relay"),
			RoomId::from_bytes([1; ROOM_ID_BYTES]),
			credentials,
		)
	}

	#[test]
	fn compact_round_trip_preserves_access_tier() {
		for full in [false, true] {
			let original = link(full);
			let parsed = CollabLink::parse(&original.compact()).expect("parse");
			assert_eq!(parsed, original);
			assert_eq!(parsed.credentials().is_read_only(), !full);
		}
	}

	#[test]
	fn browser_fragment_round_trip_keeps_secret_out_of_request_target() {
		let original = link(true);
		let web = WebEndpoint::parse("https://collab.example").expect("web");
		let browser = original.browser(&web);
		let url = Url::parse(&browser).expect("url");
		assert_eq!(url.path(), "/");
		assert!(url.query().is_none());
		assert!(url.fragment().is_some());
		assert_eq!(CollabLink::parse(&browser).expect("parse"), original);
	}

	#[test]
	fn localhost_is_the_only_insecure_exception() {
		assert!(RelayEndpoint::parse("ws://localhost:9000").is_ok());
		assert!(RelayEndpoint::parse("http://127.0.0.1:9000").is_ok());
		assert!(RelayEndpoint::parse("ws://relay.example").is_err());
		assert!(WebEndpoint::parse("http://collab.example").is_err());
	}

	#[test]
	fn parser_accepts_legacy_separator_and_percent_mangling() {
		let compact = link(false).compact();
		let legacy = compact.replacen('.', "#", 1);
		assert_eq!(CollabLink::parse(&legacy).expect("legacy"), link(false));
		let mangled = legacy.replace('#', "%23");
		assert_eq!(CollabLink::parse(&mangled).expect("mangled"), link(false));
	}

	#[test]
	fn parser_accepts_collab_web_room_route() {
		let original = link(false);
		assert_eq!(original.room_url().path(), format!("/r/{}", encode_room_id(original.room_id())));
		assert_eq!(CollabLink::parse(&original.compact()).expect("collab-web route"), original);
	}
	#[test]
	fn terminal_join_is_scannable_and_osc8_linked() {
		let presentation = link(true)
			.terminal_join(&WebEndpoint::parse("https://collab.example").expect("web"))
			.expect("terminal join");
		assert!(presentation.browser_url.contains('#'));
		assert!(presentation.hyperlink.starts_with(OSC8_OPEN));
		assert!(presentation.hyperlink.ends_with(OSC8_CLOSE));
		assert!(!presentation.qr_rows.is_empty());
		assert!(
			presentation
				.qr_rows
				.iter()
				.all(|row| { row.starts_with(QR_ANSI_DARK_ON_LIGHT) && row.ends_with(ANSI_RESET) })
		);
		assert!(presentation.min_columns > 0);
	}

	#[test]
	fn clipped_qr_keeps_a_width_bounded_browser_link_row() {
		let presentation = link(true)
			.terminal_join(&WebEndpoint::parse("https://collab.example").expect("web"))
			.expect("terminal join");
		let height_clipped = presentation.qr_rows_for_layout(presentation.min_columns, 1);
		assert_eq!(height_clipped.len(), 1);
		assert!(
			height_clipped[0].contains(presentation.browser_url.as_str()),
			"{:?}",
			height_clipped[0]
		);
		let rows = presentation.qr_rows_for_layout(10, 1);
		assert_eq!(rows.len(), 1);
		let row = &rows[0];
		assert!(row.contains(presentation.browser_url.as_str()), "{row:?}");
		let (_, after_target) = row
			.split_once(STRING_TERMINATOR)
			.expect("fallback carries an OSC-8 target");
		let (label, suffix) = after_target
			.split_once(OSC8_CLOSE)
			.expect("fallback closes its OSC-8 target");
		assert!(label.chars().count() + suffix.chars().count() <= 10, "{row:?}");
	}
}
