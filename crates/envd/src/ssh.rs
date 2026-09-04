//! Native Rust SSH/SFTP sessions and configured-host authority.

use std::{
	collections::BTreeMap,
	fs,
	future::Future,
	io,
	net::SocketAddr,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use flume::Receiver;
use omp_core::{CowBytes, Str};
use parking_lot::RwLock;
use russh::{
	client, keys,
	keys::{HashAlg, PrivateKeyWithHashAlg, agent::client::AgentClient, load_secret_key},
};
use russh_sftp::{
	client::{SftpSession, error},
	protocol::OpenFlags,
};
use serde::{Deserialize, Serialize};
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _, copy_bidirectional},
	net::TcpListener,
	task::{JoinError, JoinHandle, JoinSet},
	time,
};
use tokio_util::sync::CancellationToken;
use toml::{de, ser};

const DEFAULT_READ_LIMIT: usize = 8 * 1024 * 1024;
const DEFAULT_WRITE_LIMIT: usize = 8 * 1024 * 1024;
const DEFAULT_LIST_LIMIT: usize = 1_000;
const DEFAULT_EXEC_LIMIT: usize = 1024 * 1024;
const MAX_TIMEOUT_SECS: u64 = 120;
const INTERACTIVE_MESSAGE_LIMIT: usize = 64 * 1024;
const INTERACTIVE_CHANNEL_CAPACITY: usize = 16;
const FORWARD_ERROR_CAPACITY: usize = 8;
const MAX_FORWARD_CONNECTIONS: usize = 16;

/// A configured native SSH host.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostConfig {
	/// DNS name or numeric address.
	pub address:      Str,
	/// SSH port.
	#[serde(default = "default_port")]
	pub port:         u16,
	/// Remote account name.
	pub user:         Str,
	/// SHA-256 host-key fingerprint, including the `SHA256:` prefix.
	pub host_key:     Str,
	/// Authentication policy.
	pub auth:         AuthPolicy,
	/// Per-operation timeout in seconds.
	#[serde(default = "default_timeout")]
	pub timeout_secs: u64,
}

const fn default_port() -> u16 {
	22
}
const fn default_timeout() -> u64 {
	30
}

/// Explicit SSH authentication policy. Passwords are intentionally unsupported.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthPolicy {
	/// Use identities from the native SSH agent protocol.
	Agent,
	/// Load one unencrypted private key after checking its filesystem
	/// permissions.
	Key {
		/// Filesystem path passed to the key loader after rejecting unsafe
		/// permissions.
		path: PathBuf,
	},
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostFile {
	#[serde(default)]
	hosts: BTreeMap<Str, HostConfig>,
}

/// The two `hosts.toml` files one process reads and mutates.
///
/// User configuration lives under `~/.o2`
/// ([`omp_core::dirs::user_config_root`], profile-aware) and never under the
/// data or state directory; project declarations live in
/// `<project>/.omp/hosts.toml` and shadow user aliases.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostPaths {
	/// User-owned `<config root>/hosts.toml`.
	pub user:              PathBuf,
	/// Project-owned `<project>/.omp/hosts.toml`.
	pub project:           PathBuf,
	/// Legacy user JSON source, read-only and lower precedence than TOML.
	legacy_user:           PathBuf,
	/// Legacy project JSON source, read-only and lower precedence than TOML.
	legacy_project:        PathBuf,
	/// Legacy hidden project JSON source.
	legacy_project_hidden: PathBuf,
}

impl HostPaths {
	/// Resolves both files from the user configuration root and the project
	/// root.
	#[must_use]
	pub fn new(user_config_root: &Path, project_root: &Path) -> Self {
		Self {
			user:                  user_config_root.join("hosts.toml"),
			project:               project_root.join(".omp/hosts.toml"),
			legacy_user:           user_config_root.join("ssh.json"),
			legacy_project:        project_root.join("ssh.json"),
			legacy_project_hidden: project_root.join(".ssh.json"),
		}
	}
}

/// Immutable configured-host store, reloadable by its owner.
#[derive(Clone, Debug, Default)]
pub struct HostStore {
	hosts: Arc<RwLock<BTreeMap<Str, HostConfig>>>,
	paths: Option<Arc<HostPaths>>,
}

impl HostStore {
	/// Loads the effective host authority: every user host, shadowed by any
	/// project host with the same alias. The result is read-only; scoped
	/// writers load one file with [`HostStore::load`].
	pub fn load_layered(paths: &HostPaths) -> Result<Self, SshError> {
		Ok(Self {
			hosts: Arc::new(RwLock::new(load_effective_hosts(paths)?)),
			paths: Some(Arc::new(paths.clone())),
		})
	}

	/// Loads `hosts.toml`. A missing file produces an empty store.
	pub fn load(path: &Path) -> Result<Self, SshError> {
		Ok(Self { hosts: Arc::new(RwLock::new(parse_hosts(path)?)), paths: None })
	}

	/// Atomically refreshes a layered store from every retained source.
	///
	/// Missing foreign files remain empty, malformed foreign files are
	/// contained to that source, and a malformed native file leaves the
	/// previously published snapshot intact.
	pub fn refresh(&self) -> Result<(), SshError> {
		let Some(paths) = &self.paths else {
			return Ok(());
		};
		let hosts = load_effective_hosts(paths)?;
		*self.hosts.write() = hosts;
		Ok(())
	}

	/// Returns a configured host without permitting URI-provided connection
	/// overrides.
	pub fn get(&self, alias: &str) -> Result<HostConfig, SshError> {
		self.refresh()?;
		self
			.hosts
			.read()
			.get(alias)
			.cloned()
			.ok_or_else(|| SshError::UnknownHost { alias: Str::new(alias) })
	}

	/// Returns configured aliases in deterministic order.
	pub fn aliases(&self) -> Vec<Str> {
		if let Err(error) = self.refresh() {
			tracing::warn!(%error, "failed to refresh configured SSH hosts");
		}
		self.hosts.read().keys().cloned().collect()
	}

	/// Atomically inserts or replaces one validated host in this scoped store.
	pub fn upsert(&self, path: &Path, alias: Str, host: HostConfig) -> Result<(), SshError> {
		validate_alias(alias.as_str())?;
		validate_host(&host)?;
		let mut hosts = self.hosts.write();
		hosts.insert(alias, host);
		persist_hosts(path, &hosts)
	}

	/// Atomically removes one host from this scoped store.
	pub fn remove(&self, path: &Path, alias: &str) -> Result<bool, SshError> {
		validate_alias(alias)?;
		let mut hosts = self.hosts.write();
		let removed = hosts.remove(alias).is_some();
		if removed {
			persist_hosts(path, &hosts)?;
		}
		Ok(removed)
	}
}

fn load_effective_hosts(paths: &HostPaths) -> Result<BTreeMap<Str, HostConfig>, SshError> {
	let mut hosts = parse_legacy_hosts(&paths.legacy_user);
	hosts.extend(parse_hosts(&paths.user)?);
	hosts.extend(parse_legacy_hosts(&paths.legacy_project_hidden));
	hosts.extend(parse_legacy_hosts(&paths.legacy_project));
	hosts.extend(parse_hosts(&paths.project)?);
	Ok(hosts)
}

#[derive(Debug, Default, Deserialize)]
struct LegacyHostFile {
	#[serde(default)]
	hosts: BTreeMap<Str, LegacyHostConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHostConfig {
	host:     Str,
	username: Str,
	#[serde(default = "default_port")]
	port:     u16,
	host_key: Str,
	#[serde(default)]
	key_path: Option<PathBuf>,
}

fn parse_legacy_hosts(path: &Path) -> BTreeMap<Str, HostConfig> {
	let body = match fs::read_to_string(path) {
		Ok(body) => body,
		Err(source)
			if matches!(source.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
		{
			return BTreeMap::new();
		},
		Err(source) => {
			tracing::warn!(path = %path.display(), %source, "failed to read legacy SSH configuration");
			return BTreeMap::new();
		},
	};
	let parsed = match serde_json::from_str::<LegacyHostFile>(&body) {
		Ok(parsed) => parsed,
		Err(source) => {
			tracing::warn!(path = %path.display(), %source, "failed to parse legacy SSH configuration");
			return BTreeMap::new();
		},
	};
	let home = omp_core::dirs::home_dir();
	parsed
		.hosts
		.into_iter()
		.filter_map(|(alias, legacy)| {
			let key = legacy.key_path.map(|path| {
				let home_relative = path.strip_prefix("~").ok().map(Path::to_path_buf);
				match (home_relative, &home) {
					(Some(rest), Some(home)) => home.join(rest),
					_ => path,
				}
			});
			let host = HostConfig {
				address:      legacy.host,
				port:         legacy.port,
				user:         legacy.username,
				host_key:     legacy.host_key,
				auth:         key.map_or(AuthPolicy::Agent, |path| AuthPolicy::Key { path }),
				timeout_secs: default_timeout(),
			};
			if validate_alias(&alias).is_err() || validate_host(&host).is_err() {
				tracing::warn!(path = %path.display(), host = %alias, "ignored invalid legacy SSH host");
				None
			} else {
				Some((alias, host))
			}
		})
		.collect()
}

fn parse_hosts(path: &Path) -> Result<BTreeMap<Str, HostConfig>, SshError> {
	let body = match fs::read_to_string(path) {
		Ok(body) => body,
		Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
		Err(source) => return Err(SshError::ConfigIo { path: path.to_path_buf(), source }),
	};
	let parsed: HostFile = toml::from_str(&body)
		.map_err(|source| SshError::ConfigParse { path: path.to_path_buf(), source })?;
	for (alias, host) in &parsed.hosts {
		validate_alias(alias)?;
		validate_host(host)?;
	}
	Ok(parsed.hosts)
}

fn persist_hosts(path: &Path, hosts: &BTreeMap<Str, HostConfig>) -> Result<(), SshError> {
	let body = toml::to_string_pretty(&HostFile { hosts: hosts.clone() })
		.map_err(|source| SshError::ConfigEncode { path: path.to_path_buf(), source })?;
	crate::atomic_replace(path, &body)
		.map_err(|source| SshError::ConfigWrite { path: path.to_path_buf(), source })
}

fn validate_alias(alias: &str) -> Result<(), SshError> {
	if alias.is_empty()
		|| alias.len() > 128
		|| !alias
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
	{
		return Err(SshError::InvalidAlias { alias: Str::new(alias) });
	}
	Ok(())
}

fn validate_host(host: &HostConfig) -> Result<(), SshError> {
	if host.address.is_empty()
		|| host.user.is_empty()
		|| host.port == 0
		|| !host.host_key.starts_with("SHA256:")
	{
		return Err(SshError::InvalidHostConfig);
	}
	Ok(())
}

/// Capabilities observed for a configured host and retained in the service
/// cache.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HostCapabilities {
	/// Whether an SFTP subsystem has been initialized successfully.
	pub sftp: bool,
	/// Whether execution succeeded or probing inferred support from SFTP
	/// initialization.
	pub exec: bool,
}

/// A projection of one SFTP directory entry returned by a bounded listing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteEntry {
	/// UTF-8 entry name returned by the SFTP directory listing.
	pub name:      Str,
	/// Whether the SFTP attributes identify this entry as a directory.
	pub directory: bool,
	/// SFTP-reported length in bytes, or zero when the server omits it.
	pub size:      u64,
}

/// Projection of SFTP attributes for one remote path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoteMetadata {
	/// Whether the SFTP attributes identify the remote object as a directory.
	pub directory: bool,
	/// SFTP-reported length in bytes, or zero when the server omits it.
	pub size:      u64,
}

/// Projection of collected SSH exec-channel output and status messages.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecOutput {
	/// Raw stdout bytes, bounded independently by the execution byte limit.
	pub stdout:      CowBytes<'static>,
	/// Raw stderr bytes, bounded independently by the execution byte limit.
	pub stderr:      CowBytes<'static>,
	/// Status sent by the SSH server, or `None` when the channel closed without
	/// one.
	pub exit_status: Option<u32>,
}
#[derive(Debug)]
enum InteractiveInput {
	Data(CowBytes<'static>),
	Eof,
}

/// One bounded event emitted by an interactive SSH command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InteractiveEvent {
	/// Bytes written by the remote command to stdout.
	Stdout(CowBytes<'static>),
	/// Bytes written by the remote command to stderr.
	Stderr(CowBytes<'static>),
	/// Exit status reported by the remote command.
	ExitStatus(u32),
}

/// Bounded bidirectional channel for one interactive SSH command.
#[derive(Debug)]
pub struct InteractiveChannel {
	input:  flume::Sender<InteractiveInput>,
	events: Receiver<Result<InteractiveEvent, SshError>>,
}

impl InteractiveChannel {
	/// Sends one bounded stdin chunk to the remote command.
	pub async fn write(&self, bytes: &[u8]) -> Result<(), SshError> {
		if bytes.len() > INTERACTIVE_MESSAGE_LIMIT {
			return Err(SshError::Limit { limit: INTERACTIVE_MESSAGE_LIMIT });
		}
		self
			.input
			.send_async(InteractiveInput::Data(CowBytes::from(bytes.to_vec())))
			.await
			.map_err(|_| SshError::InteractiveClosed)
	}

	/// Closes the remote command's stdin while retaining its output stream.
	pub async fn eof(&self) -> Result<(), SshError> {
		self
			.input
			.send_async(InteractiveInput::Eof)
			.await
			.map_err(|_| SshError::InteractiveClosed)
	}

	/// Receives the next stdout, stderr, or exit-status event.
	pub async fn next_event(&self) -> Result<Option<InteractiveEvent>, SshError> {
		match self.events.recv_async().await {
			Ok(event) => event.map(Some),
			Err(_) => Ok(None),
		}
	}
}

/// Active loopback listener forwarding accepted connections through SSH.
#[derive(Debug)]
pub struct LocalForward {
	local_addr: SocketAddr,
	errors:     Receiver<SshError>,
	shutdown:   CancellationToken,
	task:       Option<JoinHandle<()>>,
}

impl LocalForward {
	/// Returns the bound loopback address.
	pub const fn local_addr(&self) -> SocketAddr {
		self.local_addr
	}

	/// Receives the next forwarding failure, if the listener is still active.
	pub async fn next_error(&self) -> Option<SshError> {
		self.errors.recv_async().await.ok()
	}

	/// Stops the listener and every active forwarded connection.
	pub async fn close(mut self) -> Result<(), SshError> {
		self.shutdown.cancel();
		if let Some(task) = self.task.take() {
			task.await?;
		}
		Ok(())
	}
}

impl Drop for LocalForward {
	fn drop(&mut self) {
		self.shutdown.cancel();
	}
}

#[derive(Clone, Debug)]
struct ClientHandler {
	expected: Str,
}

impl client::Handler for ClientHandler {
	type Error = russh::Error;

	async fn check_server_key(
		&mut self,
		key: &russh::keys::PublicKeyOrCertificate,
	) -> Result<bool, Self::Error> {
		let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
		Ok(fingerprint == self.expected.as_str())
	}
}

/// Native SSH/SFTP service with a configured-host authority and capability
/// cache.
#[derive(Clone, Debug)]
pub struct SshService {
	hosts:        HostStore,
	capabilities: Arc<RwLock<BTreeMap<Str, HostCapabilities>>>,
}

impl SshService {
	/// Creates a service backed by the supplied configured-host authority and an
	/// empty capability cache.
	pub fn new(hosts: HostStore) -> Self {
		Self { hosts, capabilities: Arc::new(RwLock::new(BTreeMap::new())) }
	}

	/// Returns configured host aliases in deterministic lexical order.
	pub fn aliases(&self) -> Vec<Str> {
		self.hosts.aliases()
	}

	/// Returns capability flags recorded by SFTP initialization, execution, or
	/// probing.
	pub fn cached_capabilities(&self, alias: &str) -> Option<HostCapabilities> {
		self.capabilities.read().get(alias).copied()
	}

	async fn with_deadline<T>(
		&self,
		alias: &str,
		operation: impl Future<Output = Result<T, SshError>>,
	) -> Result<T, SshError> {
		let host = self.hosts.get(alias)?;
		let timeout = Duration::from_secs(host.timeout_secs.clamp(1, MAX_TIMEOUT_SECS));
		let deadline = time::Instant::now() + timeout;
		match time::timeout_at(deadline, operation).await {
			Ok(result) => result,
			Err(_) => Err(SshError::Timeout),
		}
	}

	#[tracing::instrument(
		name = "ssh_connect",
		level = "debug",
		skip_all,
		fields(alias = %alias, host = tracing::field::Empty, port = tracing::field::Empty),
	)]
	async fn connect(&self, alias: &str) -> Result<client::Handle<ClientHandler>, SshError> {
		let host = self.hosts.get(alias)?;
		tracing::Span::current().record("host", host.address.as_str());
		tracing::Span::current().record("port", host.port);
		let connect = client::connect(
			Arc::new(client::Config::default()),
			(host.address.as_str(), host.port),
			ClientHandler { expected: host.host_key.clone() },
		);
		let mut session = connect.await?;
		let authenticated = match &host.auth {
			AuthPolicy::Key { path } => {
				check_key_permissions(path)?;
				let key = load_secret_key(path, None)
					.map_err(|source| SshError::Key { path: path.clone(), source })?;
				let hash = session.best_supported_rsa_hash().await?.flatten();
				session
					.authenticate_publickey(
						host.user.as_str(),
						PrivateKeyWithHashAlg::new(Arc::new(key), hash),
					)
					.await?
					.success()
			},
			AuthPolicy::Agent => authenticate_agent(&mut session, host.user.as_str()).await?,
		};
		if !authenticated {
			return Err(SshError::Authentication { alias: Str::new(alias) });
		}
		Ok(session)
	}

	async fn sftp(&self, alias: &str) -> Result<SftpSession, SshError> {
		let session = self.connect(alias).await?;
		let channel = session.channel_open_session().await?;
		channel.request_subsystem(true, "sftp").await?;
		let sftp = SftpSession::new(channel.into_stream()).await?;
		self
			.capabilities
			.write()
			.entry(Str::new(alias))
			.or_default()
			.sftp = true;
		Ok(sftp)
	}

	/// Initializes SFTP, then marks both SFTP and exec available without running
	/// a probe command.
	#[tracing::instrument(name = "ssh_probe", level = "debug", skip_all, fields(alias = %alias))]
	pub async fn probe(&self, alias: &str) -> Result<HostCapabilities, SshError> {
		self
			.with_deadline(alias, async {
				let _ = self.sftp(alias).await?;
				let mut caps = self.cached_capabilities(alias).unwrap_or_default();
				caps.exec = true;
				self.capabilities.write().insert(Str::new(alias), caps);
				Ok(caps)
			})
			.await
	}

	/// Reads a non-directory SFTP path without shell escaping or path rewriting.
	///
	/// The effective bound is the smaller of `max_bytes` and 8 MiB; metadata
	/// known to exceed it, or a stream that crosses it, returns
	/// [`SshError::Limit`].
	#[tracing::instrument(name = "ssh_read", level = "debug", skip_all, fields(alias = %alias, path = %path, max_bytes = max_bytes))]
	pub async fn read(
		&self,
		alias: &str,
		path: &str,
		max_bytes: usize,
	) -> Result<CowBytes<'static>, SshError> {
		self
			.with_deadline(alias, async {
				let limit = max_bytes.min(DEFAULT_READ_LIMIT);
				let sftp = self.sftp(alias).await?;
				let metadata = sftp.metadata(path).await?;
				if metadata.file_type().is_dir() {
					return Err(SshError::IsDirectory);
				}
				if metadata.size.unwrap_or(0) > limit as u64 {
					return Err(SshError::Limit { limit });
				}
				let file = sftp.open(path).await?;
				let mut bytes =
					Vec::with_capacity(metadata.size.unwrap_or(0).min(limit as u64) as usize);
				file
					.take((limit + 1) as u64)
					.read_to_end(&mut bytes)
					.await?;
				if bytes.len() > limit {
					return Err(SshError::Limit { limit });
				}
				Ok(CowBytes::from(bytes))
			})
			.await
	}

	/// Creates or truncates an SFTP path and writes at most 8 MiB of bytes to
	/// it.
	///
	/// The UTF-8 `path` is passed directly to SFTP, and completion includes a
	/// server sync and channel shutdown.
	#[tracing::instrument(
		name = "ssh_write",
		level = "debug",
		skip_all,
		fields(alias = %alias, path = %path, bytes = bytes.len()),
	)]
	pub async fn write(&self, alias: &str, path: &str, bytes: &[u8]) -> Result<(), SshError> {
		if bytes.len() > DEFAULT_WRITE_LIMIT {
			return Err(SshError::Limit { limit: DEFAULT_WRITE_LIMIT });
		}
		self
			.with_deadline(alias, async {
				let sftp = self.sftp(alias).await?;
				let mut file = sftp
					.open_with_flags(path, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
					.await?;
				file.write_all(bytes).await?;
				file.sync_all().await?;
				file.shutdown().await?;
				Ok(())
			})
			.await
	}

	/// Projects SFTP attributes for `path` into directory status and byte
	/// length.
	///
	/// The UTF-8 path is passed directly to SFTP; an omitted server length is
	/// reported as zero.
	#[tracing::instrument(name = "ssh_stat", level = "debug", skip_all, fields(alias = %alias, path = %path))]
	pub async fn stat(&self, alias: &str, path: &str) -> Result<RemoteMetadata, SshError> {
		self
			.with_deadline(alias, async {
				let metadata = self.sftp(alias).await?.metadata(path).await?;
				Ok(RemoteMetadata {
					directory: metadata.file_type().is_dir(),
					size:      metadata.size.unwrap_or(0),
				})
			})
			.await
	}

	/// Lists an SFTP directory in entry-name order, without rewriting its UTF-8
	/// path.
	///
	/// At most the smaller of `max_entries` and 1,000 entries are returned; the
	/// boolean result reports whether additional entries were discarded.
	#[tracing::instrument(name = "ssh_list", level = "debug", skip_all, fields(alias = %alias, path = %path, max_entries = max_entries))]
	pub async fn list(
		&self,
		alias: &str,
		path: &str,
		max_entries: usize,
	) -> Result<(Vec<RemoteEntry>, bool), SshError> {
		self
			.with_deadline(alias, async {
				let limit = max_entries.min(DEFAULT_LIST_LIMIT);
				let mut entries = self
					.sftp(alias)
					.await?
					.read_dir(path)
					.await?
					.collect::<Vec<_>>();
				entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
				let truncated = entries.len() > limit;
				entries.truncate(limit);
				Ok((
					entries
						.into_iter()
						.map(|entry| RemoteEntry {
							name:      Str::new(entry.file_name()),
							directory: entry.metadata().file_type().is_dir(),
							size:      entry.metadata().size.unwrap_or(0),
						})
						.collect(),
					truncated,
				))
			})
			.await
	}

	/// Opens a bounded bidirectional channel to one remote command.
	#[tracing::instrument(name = "ssh_interactive_open", level = "debug", skip_all, fields(alias = %alias))]
	pub async fn open_interactive(
		&self,
		alias: &str,
		command: &str,
	) -> Result<InteractiveChannel, SshError> {
		if command.as_bytes().contains(&0) {
			return Err(SshError::InvalidCommand);
		}
		self
			.with_deadline(alias, async {
				let session = self.connect(alias).await?;
				let channel = session.channel_open_session().await?;
				channel.exec(true, command.as_bytes()).await?;
				let (interactive, inputs, events) = interactive_channel_pair();
				tokio::spawn(run_interactive_channel(channel, inputs, events));
				Ok(interactive)
			})
			.await
	}

	/// Binds a loopback listener and forwards accepted TCP connections through
	/// the configured SSH host.
	#[tracing::instrument(
		name = "ssh_local_forward",
		level = "debug",
		skip_all,
		fields(alias = %alias, local_port = local_port, remote_host = %remote_host, remote_port = remote_port),
	)]
	pub async fn local_forward(
		&self,
		alias: &str,
		local_port: u16,
		remote_host: &str,
		remote_port: u16,
	) -> Result<LocalForward, SshError> {
		if remote_host.is_empty() || remote_port == 0 {
			return Err(SshError::InvalidForwardTarget);
		}
		self
			.with_deadline(alias, async {
				let session = Arc::new(self.connect(alias).await?);
				let listener = TcpListener::bind(("127.0.0.1", local_port)).await?;
				let local_addr = listener.local_addr()?;
				let shutdown = CancellationToken::new();
				let (error_tx, errors) = flume::bounded(FORWARD_ERROR_CAPACITY);
				let task = tokio::spawn(run_local_forward(
					listener,
					session,
					Str::new(remote_host),
					remote_port,
					shutdown.clone(),
					error_tx,
				));
				Ok(LocalForward { local_addr, errors, shutdown, task: Some(task) })
			})
			.await
	}

	/// Executes a non-interactive remote command and collects its raw channel
	/// output.
	///
	/// NUL-containing commands are rejected. Stdout and stderr are each bounded
	/// independently by the smaller of `max_bytes` and 1 MiB.
	#[tracing::instrument(name = "ssh_exec", level = "debug", skip_all, fields(alias = %alias, max_bytes = max_bytes))]
	pub async fn exec(
		&self,
		alias: &str,
		command: &str,
		max_bytes: usize,
	) -> Result<ExecOutput, SshError> {
		if command.as_bytes().contains(&0) {
			return Err(SshError::InvalidCommand);
		}
		self
			.with_deadline(alias, async {
				let limit = max_bytes.min(DEFAULT_EXEC_LIMIT);
				let session = self.connect(alias).await?;
				let mut channel = session.channel_open_session().await?;
				channel.exec(true, command.as_bytes()).await?;
				let mut stdout = Vec::new();
				let mut stderr = Vec::new();
				let mut status = None;
				while let Some(message) = channel.wait().await {
					match message {
						russh::ChannelMsg::Data { data } => append_bounded(&mut stdout, &data, limit)?,
						russh::ChannelMsg::ExtendedData { data, .. } => {
							append_bounded(&mut stderr, &data, limit)?
						},
						russh::ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
						_ => {},
					}
				}
				self
					.capabilities
					.write()
					.entry(Str::new(alias))
					.or_default()
					.exec = true;
				Ok(ExecOutput {
					stdout:      CowBytes::from(stdout),
					stderr:      CowBytes::from(stderr),
					exit_status: status,
				})
			})
			.await
	}
}

fn interactive_channel_pair() -> (
	InteractiveChannel,
	Receiver<InteractiveInput>,
	flume::Sender<Result<InteractiveEvent, SshError>>,
) {
	let (input, inputs) = flume::bounded(INTERACTIVE_CHANNEL_CAPACITY);
	let (events, output) = flume::bounded(INTERACTIVE_CHANNEL_CAPACITY);
	(InteractiveChannel { input, events: output }, inputs, events)
}

async fn run_interactive_channel(
	mut channel: russh::Channel<client::Msg>,
	inputs: Receiver<InteractiveInput>,
	events: flume::Sender<Result<InteractiveEvent, SshError>>,
) {
	let result: Result<(), russh::Error> = async {
		loop {
			tokio::select! {
				input = inputs.recv_async() => match input {
					Ok(InteractiveInput::Data(data)) => channel.data_bytes(data).await?,
					Ok(InteractiveInput::Eof) => channel.eof().await?,
					Err(_) => return Ok(()),
				},
				message = channel.wait() => {
					let Some(message) = message else {
						return Ok(());
					};
					let event = match message {
						russh::ChannelMsg::Data { data } => {
							Some(InteractiveEvent::Stdout(CowBytes::from(data.to_vec())))
						},
						russh::ChannelMsg::ExtendedData { data, .. } => {
							Some(InteractiveEvent::Stderr(CowBytes::from(data.to_vec())))
						},
						russh::ChannelMsg::ExitStatus { exit_status } => {
							Some(InteractiveEvent::ExitStatus(exit_status))
						},
						_ => None,
					};
					if let Some(event) = event
						&& events.send_async(Ok(event)).await.is_err()
					{
						return Ok(());
					}
				},
			}
		}
	}
	.await;
	if let Err(error) = result {
		let _ = events.send_async(Err(SshError::Ssh(error))).await;
	}
}

async fn run_local_forward(
	listener: TcpListener,
	session: Arc<client::Handle<ClientHandler>>,
	remote_host: Str,
	remote_port: u16,
	shutdown: CancellationToken,
	errors: flume::Sender<SshError>,
) {
	let mut connections = JoinSet::new();
	loop {
		tokio::select! {
			() = shutdown.cancelled() => break,
			completed = connections.join_next(), if !connections.is_empty() => {
				match completed {
					Some(Ok(Err(error))) => report_forward_error(&errors, error),
					Some(Err(error)) => report_forward_error(&errors, SshError::Join(error)),
					Some(Ok(Ok(()))) | None => {},
				}
			},
			accepted = listener.accept() => {
				let (mut socket, peer) = match accepted {
					Ok(accepted) => accepted,
					Err(error) => {
						report_forward_error(&errors, SshError::Io(error));
						break;
					},
				};
				if connections.len() >= MAX_FORWARD_CONNECTIONS {
					report_forward_error(
						&errors,
						SshError::ForwardCapacity { limit: MAX_FORWARD_CONNECTIONS },
					);
					continue;
				}
				let channel = match session
					.channel_open_direct_tcpip(
						remote_host.as_str(),
						u32::from(remote_port),
						peer.ip().to_string(),
						u32::from(peer.port()),
					)
					.await
				{
					Ok(channel) => channel,
					Err(error) => {
						report_forward_error(&errors, SshError::Ssh(error));
						continue;
					},
				};
				connections.spawn(async move {
					let mut stream = channel.into_stream();
					copy_bidirectional(&mut socket, &mut stream).await?;
					Ok::<_, SshError>(())
				});
			},
		}
	}
	connections.abort_all();
	while connections.join_next().await.is_some() {}
}

fn report_forward_error(errors: &flume::Sender<SshError>, error: SshError) {
	let _ = errors.try_send(error);
}

fn append_bounded(target: &mut Vec<u8>, bytes: &[u8], limit: usize) -> Result<(), SshError> {
	if target.len().saturating_add(bytes.len()) > limit {
		return Err(SshError::Limit { limit });
	}
	target.extend_from_slice(bytes);
	Ok(())
}

#[cfg(unix)]
fn check_key_permissions(path: &Path) -> Result<(), SshError> {
	use std::os::unix::fs::MetadataExt as _;
	let metadata = fs::metadata(path)
		.map_err(|source| SshError::ConfigIo { path: path.to_path_buf(), source })?;
	if metadata.mode() & 0o077 != 0 {
		return Err(SshError::UnsafeKeyPermissions { path: path.to_path_buf() });
	}
	Ok(())
}
#[cfg(not(unix))]
fn check_key_permissions(path: &Path) -> Result<(), SshError> {
	if !path.is_file() {
		return Err(SshError::UnsafeKeyPermissions { path: path.to_path_buf() });
	}
	Ok(())
}

#[cfg(unix)]
async fn authenticate_agent(
	session: &mut client::Handle<ClientHandler>,
	user: &str,
) -> Result<bool, SshError> {
	let mut agent = AgentClient::connect_env().await?;
	for identity in agent.request_identities().await? {
		let key = identity.public_key().into_owned();
		if session
			.authenticate_publickey_with(user, key, None, &mut agent)
			.await?
			.success()
		{
			return Ok(true);
		}
	}
	Ok(false)
}
#[cfg(not(unix))]
async fn authenticate_agent(
	_session: &mut client::Handle<ClientHandler>,
	_user: &str,
) -> Result<bool, SshError> {
	Err(SshError::AgentUnavailable)
}

/// Native SSH operation failure.
#[derive(Debug, thiserror::Error)]
pub enum SshError {
	/// Reading host configuration or private-key metadata failed.
	#[error("cannot read SSH host configuration {path}")]
	ConfigIo {
		/// Configuration or private-key path that could not be inspected.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// TOML host configuration could not be decoded.
	#[error("invalid SSH host configuration {path}")]
	ConfigParse {
		/// Configuration file containing invalid TOML or fields.
		path:   PathBuf,
		/// TOML decoder failure.
		#[source]
		source: de::Error,
	},
	/// The in-memory host map could not be serialized as TOML.
	#[error("cannot encode SSH host configuration {path}")]
	ConfigEncode {
		/// Destination configuration path associated with the serialization
		/// attempt.
		path:   PathBuf,
		/// TOML encoder failure.
		#[source]
		source: ser::Error,
	},
	/// Atomically replacing the persisted host configuration failed.
	#[error("cannot atomically write SSH host configuration {path}")]
	ConfigWrite {
		/// Configuration path that could not be replaced.
		path:   PathBuf,
		/// Atomic filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A host alias was empty, exceeded 128 bytes, or contained a disallowed
	/// ASCII character.
	#[error("invalid configured SSH alias {alias}")]
	InvalidAlias {
		/// Rejected alias supplied by the caller or configuration.
		alias: Str,
	},
	/// A host lacked an address, user, nonzero port, or `SHA256:` host-key
	/// fingerprint.
	#[error("configured SSH host is missing an address, user, port, or SHA-256 host key")]
	InvalidHostConfig,
	/// No configured host matched the requested alias.
	#[error("SSH host {alias} is not configured")]
	UnknownHost {
		/// Alias absent from the configured-host authority.
		alias: Str,
	},
	/// A private key failed the platform filesystem-safety check.
	#[error("private key {path} has unsafe permissions")]
	UnsafeKeyPermissions {
		/// Path with Unix group/other access bits, or a non-file path on other
		/// platforms.
		path: PathBuf,
	},
	/// Loading or decoding a configured private key failed.
	#[error("cannot load private key {path}")]
	Key {
		/// Configured private-key path passed to the key loader.
		path:   PathBuf,
		/// Key loading or decoding failure.
		#[source]
		source: keys::Error,
	},
	/// The configured key or every available agent identity was rejected by the
	/// host.
	#[error("SSH authentication failed for configured host {alias}")]
	Authentication {
		/// Configured host whose authentication attempts were rejected.
		alias: Str,
	},
	/// A complete SSH operation exceeded the host timeout, clamped to 1–120
	/// seconds.
	#[error("SSH operation timed out")]
	Timeout,
	/// A bounded file-read request targeted a directory.
	#[error("remote path is a directory")]
	IsDirectory,
	/// A file read, write, command stream, or interactive input exceeded its
	/// byte bound.
	#[error("remote operation exceeded its {limit}-byte/item bound")]
	Limit {
		/// Maximum permitted bytes for the failing operation.
		limit: usize,
	},
	/// A command was rejected locally because its byte representation contained
	/// NUL.
	#[error("remote command contains a NUL byte")]
	InvalidCommand,
	/// Interactive input could not be delivered because the command task had
	/// closed.
	#[error("interactive SSH command channel is closed")]
	InteractiveClosed,
	/// A forwarding target had an empty host name or zero port.
	#[error("SSH local-forward target is invalid")]
	InvalidForwardTarget,
	/// A loopback forwarding listener already had the maximum 16 active
	/// connections.
	#[error("SSH local-forward connection limit {limit} was reached")]
	ForwardCapacity {
		/// Maximum number of simultaneous forwarded connections.
		limit: usize,
	},
	/// SSH-agent authentication was requested on a platform without native agent
	/// support.
	#[error("native SSH agent authentication is unavailable on this platform")]
	AgentUnavailable,
	/// The underlying SSH transport or channel operation failed.
	#[error(transparent)]
	Ssh(#[from] russh::Error),
	/// The underlying SFTP protocol or subsystem operation failed.
	#[error(transparent)]
	Sftp(#[from] error::Error),
	/// Local socket or asynchronous stream I/O failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// Connecting to or querying the native SSH agent failed.
	#[error(transparent)]
	Agent(#[from] keys::Error),
	/// The SSH agent could not complete a public-key authentication exchange.
	#[error(transparent)]
	AgentAuth(#[from] russh::AgentAuthError),
	/// A spawned forwarding task panicked or was cancelled unexpectedly.
	#[error(transparent)]
	Join(#[from] JoinError),
}
#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	#[tokio::test]
	async fn interactive_channel_carries_bounded_input_and_output() {
		let (channel, inputs, events) = interactive_channel_pair();
		channel
			.write(b"pasted-code\n")
			.await
			.expect("send interactive input");
		let InteractiveInput::Data(input) = inputs.recv_async().await.expect("receive input") else {
			panic!("expected interactive data");
		};
		assert_eq!(input.as_ref(), b"pasted-code\n");

		events
			.send_async(Ok(InteractiveEvent::Stdout(CowBytes::from_static(b"Credentials saved\n"))))
			.await
			.expect("send interactive output");
		assert_eq!(
			channel.next_event().await.expect("receive output"),
			Some(InteractiveEvent::Stdout(CowBytes::from_static(b"Credentials saved\n")))
		);

		let oversized = vec![0_u8; INTERACTIVE_MESSAGE_LIMIT + 1];
		assert!(matches!(
			channel.write(&oversized).await,
			Err(SshError::Limit { limit: INTERACTIVE_MESSAGE_LIMIT })
		));
	}

	#[tokio::test]
	async fn operation_deadline_is_single_and_absolute() {
		let store = HostStore::default();
		store
			.hosts
			.write()
			.insert(Str::new("deadline"), HostConfig {
				address:      sf!("localhost"),
				port:         22,
				user:         sf!("test"),
				host_key:     sf!("SHA256:test"),
				auth:         AuthPolicy::Agent,
				timeout_secs: 1,
			});
		let service = SshService::new(store);
		let started = time::Instant::now();
		let result = service
			.with_deadline("deadline", async {
				time::sleep(Duration::from_secs(5)).await;
				Ok::<_, SshError>(())
			})
			.await;
		assert!(matches!(result, Err(SshError::Timeout)));
		assert!(started.elapsed() < Duration::from_secs(3));
	}

	#[test]
	fn layered_store_reads_user_config_root_and_project_shadows_it() {
		let temp = tempfile::tempdir().expect("tempdir");
		let user_root = temp.path().join("o2");
		let project_root = temp.path().join("project");
		fs::create_dir_all(&user_root).expect("user root");
		fs::create_dir_all(project_root.join(".omp")).expect("project root");
		let paths = HostPaths::new(&user_root, &project_root);
		assert_eq!(paths.user, user_root.join("hosts.toml"));
		assert_eq!(paths.project, project_root.join(".omp/hosts.toml"));

		let host = |user: &str| HostConfig {
			address:      sf!("localhost"),
			port:         22,
			user:         Str::new(user),
			host_key:     sf!("SHA256:test"),
			auth:         AuthPolicy::Agent,
			timeout_secs: 30,
		};
		HostStore::default()
			.upsert(&paths.user, sf!("shared"), host("from-user"))
			.expect("write user host");
		let user_store = HostStore::load(&paths.user).expect("load user store");
		user_store
			.upsert(&paths.user, sf!("user-only"), host("user-only"))
			.expect("write second user host");
		HostStore::default()
			.upsert(&paths.project, sf!("shared"), host("from-project"))
			.expect("write project host");

		let layered = HostStore::load_layered(&paths).expect("layered load");
		assert_eq!(layered.aliases(), vec![sf!("shared"), sf!("user-only")]);
		assert_eq!(layered.get("shared").expect("shared").user, "from-project");
		assert_eq!(layered.get("user-only").expect("user-only").user, "user-only");
		assert!(matches!(layered.get("absent"), Err(SshError::UnknownHost { .. })));

		fs::write(
			&paths.legacy_project,
			r#"{"hosts":{"legacy":{"host":"example.test","username":"legacy","hostKey":"SHA256:legacy"},"shared":{"host":"ignored.test","username":"legacy","hostKey":"SHA256:legacy"}}}"#,
		)
		.expect("write legacy project source");
		fs::write(&paths.legacy_project_hidden, "{").expect("write malformed independent source");
		assert_eq!(layered.aliases(), vec![sf!("legacy"), sf!("shared"), sf!("user-only")]);
		assert_eq!(layered.get("legacy").expect("legacy").user, "legacy");
		assert_eq!(layered.get("shared").expect("shared").user, "from-project");

		let project_store = HostStore::load(&paths.project).expect("reload project writer");
		project_store
			.upsert(&paths.project, sf!("refreshed"), host("new"))
			.expect("write refreshed host");
		assert_eq!(layered.get("refreshed").expect("refreshed").user, "new");

		let missing = HostPaths::new(&temp.path().join("nope"), &temp.path().join("nope"));
		assert!(
			HostStore::load_layered(&missing)
				.expect("missing files are empty")
				.aliases()
				.is_empty()
		);
	}

	#[tokio::test]
	async fn local_forward_rejects_invalid_target_without_connecting() {
		let service = SshService::new(HostStore::default());
		assert!(matches!(
			service.local_forward("missing", 0, "", 0).await,
			Err(SshError::InvalidForwardTarget)
		));
	}
}
