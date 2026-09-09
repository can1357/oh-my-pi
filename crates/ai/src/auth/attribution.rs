//! Stable client identity carried only across OMP gateway and broker
//! transports.

use std::{env, fs, io, path::Path};

use http::{HeaderMap, HeaderValue};
use omp_core::Str;
use ring::rand::{SecureRandom as _, SystemRandom};
use thiserror::Error;

/// Usage-attribution install header used on OMP-owned transports.
pub const INSTALL_ID_HEADER: &str = "x-omp-install-id";
/// Usage-attribution application header used on OMP-owned transports.
pub const APP_HEADER: &str = "x-omp-app";
/// Usage-attribution hostname header used on OMP-owned transports.
pub const HOSTNAME_HEADER: &str = "x-omp-hostname";

const INSTALL_ID_FILE: &str = "install-id";

/// One resolved identity used for gateway-side usage accounting.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientUsageIdentity {
	install_id: Str,
	app:        Str,
	hostname:   Option<Str>,
}

impl ClientUsageIdentity {
	/// Constructs an already-resolved usage identity.
	pub fn new(
		install_id: impl Into<Str>,
		app: impl Into<Str>,
		hostname: Option<impl Into<Str>>,
	) -> Self {
		Self {
			install_id: install_id.into(),
			app:        app.into(),
			hostname:   hostname.map(Into::into),
		}
	}

	/// Returns the stable installation identifier.
	pub fn install_id(&self) -> &str {
		self.install_id.as_str()
	}

	/// Returns the resolved application label.
	pub fn app(&self) -> &str {
		self.app.as_str()
	}

	/// Returns the human-readable hostname, when available.
	pub fn hostname(&self) -> Option<&str> {
		self.hostname.as_deref()
	}
}

/// Composition-time client identity with precomputed OMP transport headers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageAttribution {
	identity: ClientUsageIdentity,
	headers:  HeaderMap,
}

impl UsageAttribution {
	/// Resolves one process identity and persists the installation id below
	/// `data_dir`.
	///
	/// `OMP_APP_NAME` wins over a non-empty explicit name, which wins over the
	/// current executable's file name. Resolution happens once; later
	/// environment changes do not mutate this value.
	pub fn compose(data_dir: &Path, explicit_app: Option<&str>) -> Result<Self, AttributionError> {
		Ok(Self::from_identity(ClientUsageIdentity::new(
			install_id(data_dir)?,
			resolve_app_name(explicit_app),
			hostname(),
		)))
	}

	/// Constructs an already-resolved identity, primarily for embedded callers.
	pub fn new(
		install_id: impl Into<Str>,
		app: impl Into<Str>,
		hostname: Option<impl Into<Str>>,
	) -> Self {
		Self::from_identity(ClientUsageIdentity::new(install_id, app, hostname))
	}

	fn from_identity(identity: ClientUsageIdentity) -> Self {
		let mut headers = HeaderMap::new();
		insert_header(&mut headers, INSTALL_ID_HEADER, identity.install_id());
		insert_header(&mut headers, APP_HEADER, identity.app());
		if let Some(hostname) = identity.hostname() {
			insert_header(&mut headers, HOSTNAME_HEADER, hostname);
		}
		Self { identity, headers }
	}

	/// Returns the resolved usage identity.
	pub const fn identity(&self) -> &ClientUsageIdentity {
		&self.identity
	}

	/// Adds attribution headers to an OMP-owned gateway or broker request.
	///
	/// Values are scrubbed to visible ASCII before insertion. Provider request
	/// transports must not call this method.
	pub fn apply_headers(&self, headers: &mut HeaderMap) {
		for name in [INSTALL_ID_HEADER, APP_HEADER, HOSTNAME_HEADER] {
			if let Some(value) = self.headers.get(name) {
				headers.insert(name, value.clone());
			}
		}
	}

	/// Builds the complete attribution header set for an OMP-owned transport.
	pub const fn headers(&self) -> &HeaderMap {
		&self.headers
	}
}

/// Resolves forwarded request metadata, falling back to the gateway identity.
///
/// A forwarded app without an install id labels the gateway's own install. An
/// install id without an app uses the gateway process label.
pub fn resolve_forwarded_attribution(
	install_id: Option<&str>,
	app: Option<&str>,
	hostname: Option<&str>,
	gateway: &UsageAttribution,
) -> ClientUsageIdentity {
	let install_id = non_empty(install_id);
	ClientUsageIdentity::new(
		install_id.map_or_else(|| gateway.identity.install_id.clone(), Str::new),
		non_empty(app).map_or_else(|| gateway.identity.app.clone(), Str::new),
		if install_id.is_some() {
			non_empty(hostname).map(Str::new)
		} else {
			gateway.identity.hostname.clone()
		},
	)
}

/// Resolves the process application label using environment, explicit, then
/// binary-identity precedence.
pub fn resolve_app_name(explicit: Option<&str>) -> Str {
	resolve_app_name_from(env::var("OMP_APP_NAME").ok().as_deref(), explicit, &binary_identity())
}

fn resolve_app_name_from(environment: Option<&str>, explicit: Option<&str>, fallback: &str) -> Str {
	Str::new(
		non_empty(environment)
			.or_else(|| non_empty(explicit))
			.unwrap_or(fallback),
	)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
	value.map(str::trim).filter(|value| !value.is_empty())
}

fn binary_identity() -> String {
	env::args_os()
		.next()
		.as_deref()
		.map(Path::new)
		.and_then(Path::file_stem)
		.and_then(|name| name.to_str())
		.filter(|name| !name.is_empty())
		.unwrap_or("omp")
		.to_owned()
}

fn hostname() -> Option<Str> {
	env::var("HOSTNAME")
		.or_else(|_| env::var("COMPUTERNAME"))
		.ok()
		.as_deref()
		.and_then(|value| non_empty(Some(value)))
		.map(Str::new)
}

fn install_id(data_dir: &Path) -> Result<Str, AttributionError> {
	fs::create_dir_all(data_dir).map_err(|source| AttributionError::PrepareDirectory {
		path: data_dir.to_path_buf(),
		source,
	})?;
	let path = data_dir.join(INSTALL_ID_FILE);
	match fs::read_to_string(&path) {
		Ok(value) if non_empty(Some(&value)).is_some() => {
			return Ok(Str::new(value.trim()));
		},
		Ok(_) => {},
		Err(source) if source.kind() == io::ErrorKind::NotFound => {},
		Err(source) => return Err(AttributionError::ReadInstallId { path, source }),
	}
	let mut random = [0_u8; 16];
	SystemRandom::new()
		.fill(&mut random)
		.map_err(|_| AttributionError::RandomInstallId)?;
	let value = hex_id(random);
	match fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&path)
	{
		Ok(mut file) => {
			use io::Write as _;
			file
				.write_all(value.as_bytes())
				.and_then(|()| file.sync_all())
				.map_err(|source| AttributionError::WriteInstallId { path, source })?;
			Ok(Str::from(value))
		},
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
			let value = fs::read_to_string(&path)
				.map_err(|source| AttributionError::ReadInstallId { path, source })?;
			non_empty(Some(&value))
				.map(Str::new)
				.ok_or(AttributionError::EmptyInstallId)
		},
		Err(source) => Err(AttributionError::WriteInstallId { path, source }),
	}
}

fn hex_id(bytes: [u8; 16]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(32);
	for byte in bytes {
		output.push(char::from(HEX[usize::from(byte >> 4)]));
		output.push(char::from(HEX[usize::from(byte & 0x0f)]));
	}
	output
}

fn insert_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
	let scrubbed = value
		.bytes()
		.map(|byte| {
			if (0x20..=0x7e).contains(&byte) {
				byte
			} else {
				b'?'
			}
		})
		.collect::<Vec<_>>();
	if let Ok(value) = HeaderValue::from_bytes(&scrubbed) {
		headers.insert(name, value);
	}
}

/// Failure to resolve or persist attribution metadata.
#[derive(Debug, Error)]
pub enum AttributionError {
	/// The profile data directory could not be created.
	#[error("could not prepare attribution directory {path}")]
	PrepareDirectory {
		/// Profile data directory.
		path:   std::path::PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The persisted installation identifier could not be read.
	#[error("could not read attribution install id from {path}")]
	ReadInstallId {
		/// Install-id path.
		path:   std::path::PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The installation identifier could not be persisted.
	#[error("could not write attribution install id to {path}")]
	WriteInstallId {
		/// Install-id path.
		path:   std::path::PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// Secure randomness was unavailable.
	#[error("secure randomness was unavailable for attribution install id")]
	RandomInstallId,
	/// A concurrently created installation identifier was empty.
	#[error("persisted attribution install id is empty")]
	EmptyInstallId,
}

#[cfg(test)]
mod tests {
	use super::{
		APP_HEADER, ClientUsageIdentity, HOSTNAME_HEADER, INSTALL_ID_HEADER, UsageAttribution,
		resolve_app_name_from, resolve_forwarded_attribution,
	};

	#[test]
	fn app_name_precedence_is_environment_then_explicit_then_binary() {
		assert_eq!(resolve_app_name_from(Some(" env-app "), Some("explicit"), "omp"), "env-app");
		assert_eq!(resolve_app_name_from(Some("  "), Some(" explicit "), "omp"), "explicit");
		assert_eq!(resolve_app_name_from(None, None, "omp"), "omp");
	}

	#[test]
	fn forwarded_identity_falls_back_as_one_gateway_identity() {
		let gateway = UsageAttribution::new("gateway-install", "gateway", Some("gateway-host"));
		assert_eq!(
			resolve_forwarded_attribution(None, Some("sdk"), Some("ignored"), &gateway),
			ClientUsageIdentity::new("gateway-install", "sdk", Some("gateway-host")),
		);
		assert_eq!(
			resolve_forwarded_attribution(
				Some("client-install"),
				Some("client-app"),
				Some("client-host"),
				&gateway,
			),
			ClientUsageIdentity::new("client-install", "client-app", Some("client-host")),
		);
	}
	#[test]
	fn gateway_headers_use_only_omp_attribution_names() {
		let attribution = UsageAttribution::new("install", "robömp", Some("host\u{7f}name"));
		let headers = attribution.headers();
		assert_eq!(headers[INSTALL_ID_HEADER], "install");
		assert_eq!(headers[APP_HEADER], "rob??mp");
		assert_eq!(headers[HOSTNAME_HEADER], "host?name");
		assert_eq!(headers.len(), 3);
	}
}
