//! Transactional native OAuth callback registration and one-shot delivery.

mod context;
#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod unsupported {
	use anyhow::bail;
	use serde::{Deserialize, Serialize};

	use super::context::Context;

	#[derive(Clone, Debug, Deserialize, Serialize)]
	pub(super) struct Snapshot;

	pub(super) fn prepare(_context: &Context) -> anyhow::Result<Snapshot> {
		bail!("native OAuth callbacks are unsupported on this platform")
	}

	pub(super) fn activate(_context: &Context, _snapshot: &Snapshot) -> anyhow::Result<()> {
		bail!("native OAuth callbacks are unsupported on this platform")
	}

	pub(super) fn restore(_context: &Context, _snapshot: &Snapshot) -> anyhow::Result<()> {
		bail!("native OAuth callbacks are unsupported on this platform")
	}
}

use std::{
	collections::BTreeMap,
	fs::{self, File},
	io::{self, Read},
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use anyhow::{Context as _, Result as AnyResult, anyhow, bail};
use context::{Context, atomic_write, ensure_private_dir};
#[cfg(all(not(test), target_os = "macos"))]
use darwin as platform;
#[cfg(all(not(test), target_os = "linux"))]
use linux as platform;
use napi::{Env, Error, Result, bindgen_prelude::PromiseRaw};
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use tests::backend as platform;
#[cfg(all(
	not(test),
	not(any(target_os = "linux", target_os = "macos", target_os = "windows"))
))]
use unsupported as platform;
#[cfg(all(not(test), target_os = "windows"))]
use windows as platform;

use crate::{
	file_lock::FileLock,
	task::{self, AbortReason, AbortToken, CancelToken},
};

const JOURNAL_VERSION: u32 = 1;
const JOURNAL_LIMIT: u64 = 1024 * 1024;
const CALLBACK_LIMIT: u64 = 16 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const CLEANUP_TIMEOUT_MS: u32 = 15_000;
const SETUP_TIMEOUT_MS: u32 = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS: u32 = 300_000;
const JOURNAL_ENVIRONMENT_KEYS: [&str; 3] =
	["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CURRENT_DESKTOP"];

#[cfg(target_os = "macos")]
const HELPER_BYTES: &[u8] = include_bytes!(env!("OMP_OAUTH_DARWIN_HELPER"));
#[cfg(not(target_os = "macos"))]
const HELPER_BYTES: &[u8] = include_bytes!(env!("OMP_OAUTH_RELAY_BINARY"));

/// Construction options for [`NativeOAuthCallback`].
#[napi(object)]
pub struct NativeOAuthCallbackOptions {
	/// Custom URL scheme to register.
	pub scheme: String,
}

/// A transactional, process-owned native OAuth callback receiver.
#[napi]
pub struct NativeOAuthCallback {
	core: Arc<Core>,
}

struct Core {
	home:      PathBuf,
	scheme:    String,
	env:       BTreeMap<String, String>,
	state:     Mutex<State>,
	operation: Mutex<()>,
}

struct State {
	phase:     Phase,
	waits:     BTreeMap<u64, AbortToken>,
	next_wait: u64,
	next_op:   u64,
}

enum Phase {
	Idle,
	Starting { operation: u64, abort: AbortToken },
	Active(Box<Registration>),
	Disposing,
}

struct Registration {
	context:      Context,
	journal_path: PathBuf,
	snapshot:     platform::Snapshot,
	lease:        FileLock,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
	version:     u32,
	id:          String,
	scheme:      String,
	environment: BTreeMap<String, String>,
	snapshot:    platform::Snapshot,
}

#[napi]
impl NativeOAuthCallback {
	/// Create a receiver without touching the filesystem or OS registration.
	#[napi(constructor)]
	pub fn new(options: NativeOAuthCallbackOptions) -> Result<Self> {
		validate_scheme(&options.scheme).map_err(napi_error)?;
		let env: BTreeMap<_, _> = std::env::vars().collect();
		let home = environment_home(&env)
			.ok_or_else(|| Error::from_reason("NativeOAuthCallback requires a user home"))?;
		if !home.is_absolute() {
			return Err(Error::from_reason("NativeOAuthCallback home must be absolute"));
		}
		Ok(Self {
			core: Arc::new(Core {
				home,
				scheme: options.scheme,
				env,
				state: Mutex::new(State {
					phase:     Phase::Idle,
					waits:     BTreeMap::new(),
					next_wait: 1,
					next_op:   1,
				}),
				operation: Mutex::new(()),
			}),
		})
	}

	/// Register the scheme transactionally. Returns false on unsupported or
	/// remote sessions.
	#[napi]
	pub fn start(&self) -> task::Promise<bool> {
		let mut cancel = CancelToken::new(Some(SETUP_TIMEOUT_MS), None);
		let abort = cancel.emplace_abort_token();
		let operation = {
			let mut state = self.core.state.lock();
			match &state.phase {
				Phase::Active(_) => return task::blocking("oauthCallback.start", (), |_| Ok(true)),
				Phase::Starting { .. } => {
					return task::blocking("oauthCallback.start", (), |_| {
						Err(Error::from_reason("Native OAuth callback start is already in progress"))
					});
				},
				Phase::Disposing => {
					return task::blocking("oauthCallback.start", (), |_| {
						Err(Error::from_reason("Native OAuth callback disposal is in progress"))
					});
				},
				Phase::Idle => {},
			}
			let operation = state.next_op;
			state.next_op = state.next_op.wrapping_add(1).max(1);
			state.phase = Phase::Starting { operation, abort };
			operation
		};
		let core = Arc::clone(&self.core);
		task::blocking("oauthCallback.start", cancel, move |cancel| {
			let _serial = core.operation.lock();
			let result = start_blocking(&core, cancel);
			finish_start(&core, operation, result).map_err(napi_error)
		})
	}

	/// Cancel an in-progress start and every pending callback wait.
	#[napi]
	pub fn cancel(&self) {
		let state = self.core.state.lock();
		if let Phase::Starting { abort, .. } = &state.phase {
			abort.abort(AbortReason::User);
		}
		for abort in state.waits.values() {
			abort.abort(AbortReason::User);
		}
	}

	/// Wait for and atomically claim the callback URL.
	#[napi]
	pub fn wait_for_callback<'env>(
		&self,
		env: &'env Env,
		timeout_ms: Option<u32>,
	) -> Result<PromiseRaw<'env, String>> {
		let mut cancel = CancelToken::new(Some(timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)), None);
		let abort = cancel.emplace_abort_token();
		let registration = {
			let mut state = self.core.state.lock();
			let (path, scheme, transaction) = match &state.phase {
				Phase::Active(registration) => (
					registration.context.callback_path.clone(),
					registration.context.scheme.clone(),
					registration.context.id.clone(),
				),
				_ => {
					return task::future(env, "oauthCallback.wait", async {
						Err(Error::from_reason("Native OAuth callback is not active"))
					});
				},
			};
			let wait = state.next_wait;
			state.next_wait = state.next_wait.wrapping_add(1).max(1);
			state.waits.insert(wait, abort);
			(wait, path, scheme, transaction)
		};
		let core = Arc::clone(&self.core);
		task::future(env, "oauthCallback.wait", async move {
			let result = wait_for_callback_async(
				&registration.1,
				&registration.2,
				&registration.3,
				registration.0,
				&cancel,
			)
			.await;
			core.state.lock().waits.remove(&registration.0);
			result.map_err(napi_error)
		})
	}

	/// Restore prior OS state and release ownership. Safe to call repeatedly.
	#[napi]
	pub fn dispose(&self) -> task::Promise<()> {
		let captured = {
			let mut state = self.core.state.lock();
			for abort in state.waits.values() {
				abort.abort(AbortReason::User);
			}
			match std::mem::replace(&mut state.phase, Phase::Disposing) {
				Phase::Idle => {
					state.phase = Phase::Idle;
					return task::blocking("oauthCallback.dispose", (), |_| Ok(()));
				},
				Phase::Starting { abort, .. } => {
					abort.abort(AbortReason::User);
					None
				},
				Phase::Active(registration) => Some(registration),
				Phase::Disposing => {
					state.phase = Phase::Disposing;
					None
				},
			}
		};
		let core = Arc::clone(&self.core);
		let cleanup = CancelToken::new(Some(CLEANUP_TIMEOUT_MS), None);
		task::blocking("oauthCallback.dispose", cleanup, move |cleanup| {
			let _serial = core.operation.lock();
			let mut registration = captured.or_else(|| {
				let mut state = core.state.lock();
				match std::mem::replace(&mut state.phase, Phase::Disposing) {
					Phase::Active(registration) => Some(registration),
					phase => {
						state.phase = phase;
						None
					},
				}
			});
			let result = registration
				.as_mut()
				.map_or(Ok(()), |registration| cleanup_registration(registration, cleanup));
			let mut state = core.state.lock();
			match result {
				Ok(()) => {
					state.phase = Phase::Idle;
					Ok(())
				},
				Err(error) => {
					if let Some(registration) = registration {
						state.phase = Phase::Active(registration);
					} else {
						state.phase = Phase::Idle;
					}
					Err(napi_error(error))
				},
			}
		})
	}
}

enum StartOutcome {
	Unsupported,
	Active(Box<Registration>),
}

fn start_blocking(core: &Core, cancel: CancelToken) -> AnyResult<StartOutcome> {
	cancel
		.heartbeat()
		.map_err(|error| anyhow!(error.to_string()))?;
	if !session_supported(&core.env) {
		return Ok(StartOutcome::Unsupported);
	}
	#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows", test)))]
	return Ok(StartOutcome::Unsupported);

	#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", test))]
	{
		let home = fs::canonicalize(&core.home)
			.with_context(|| format!("failed to resolve user home {}", core.home.display()))?;
		let root = storage_root(&home, &core.scheme);
		ensure_storage_root(&root)?;
		let lease_path = root.join("lease");
		let lease = FileLock::try_acquire_path(&lease_path)?;
		if !lease.is_acquired() {
			bail!("another process owns the native OAuth callback for {}", core.scheme);
		}
		let journal_path = root.join("registration.json");
		if journal_path.exists() {
			recover_stale(core, &root, &journal_path, cancel.clone())?;
		}
		cancel
			.heartbeat()
			.map_err(|error| anyhow!(error.to_string()))?;
		let id = transaction_id()?;
		let directory = root.join(&id);
		ensure_private_dir(&directory)?;
		let context =
			Context::new(home, directory, core.scheme.clone(), id.clone(), core.env.clone(), cancel);
		if let Err(error) = extract_helper(&context).and_then(|()| context.check()) {
			let _ = fs::remove_dir_all(&context.directory);
			return Err(error);
		}
		let snapshot = match platform::prepare(&context) {
			Ok(snapshot) => snapshot,
			Err(error) => {
				let _ = fs::remove_dir_all(&context.directory);
				return Err(error);
			},
		};
		let journal = Journal {
			version: JOURNAL_VERSION,
			id,
			scheme: core.scheme.clone(),
			environment: journal_environment(&core.env),
			snapshot,
		};
		let bytes =
			match serde_json::to_vec(&journal).context("failed to serialize OAuth recovery journal") {
				Ok(bytes) => bytes,
				Err(error) => {
					let _ = fs::remove_dir_all(&context.directory);
					return Err(error);
				},
			};
		if let Err(error) = atomic_write(&journal_path, &bytes, 0o600) {
			let _ = fs::remove_dir_all(&context.directory);
			return Err(error);
		}
		if let Err(activation) =
			platform::activate(&context, &journal.snapshot).and_then(|()| context.check())
		{
			let cleanup_context =
				context.with_cancel(CancelToken::new(Some(CLEANUP_TIMEOUT_MS), None));
			return match platform::restore(&cleanup_context, &journal.snapshot) {
				Ok(()) => {
					remove_transaction_then_journal(&context.directory, &journal_path)?;
					Err(activation)
				},
				Err(restoration) => Err(anyhow!(
					"activation failed: {activation:#}; restoration is uncertain: {restoration:#}; \
					 recovery journal retained at {}",
					journal_path.display()
				)),
			};
		}
		Ok(StartOutcome::Active(Box::new(Registration {
			context,
			journal_path,
			snapshot: journal.snapshot,
			lease,
		})))
	}
}

fn finish_start(core: &Core, operation: u64, result: AnyResult<StartOutcome>) -> AnyResult<bool> {
	match result {
		Ok(StartOutcome::Unsupported) => {
			let mut state = core.state.lock();
			if matches!(state.phase, Phase::Starting { operation: current, .. } if current == operation)
			{
				state.phase = Phase::Idle;
			}
			Ok(false)
		},
		Ok(StartOutcome::Active(mut registration)) => {
			let mut state = core.state.lock();
			if matches!(state.phase, Phase::Starting { operation: current, .. } if current == operation)
			{
				state.phase = Phase::Active(registration);
				return Ok(true);
			}
			drop(state);
			let cleanup = CancelToken::new(Some(CLEANUP_TIMEOUT_MS), None);
			if let Err(error) = cleanup_registration(&mut registration, cleanup) {
				core.state.lock().phase = Phase::Active(registration);
				return Err(error);
			}
			bail!("Native OAuth callback start was cancelled");
		},
		Err(error) => {
			let mut state = core.state.lock();
			if matches!(state.phase, Phase::Starting { operation: current, .. } if current == operation)
			{
				state.phase = Phase::Idle;
			}
			Err(error)
		},
	}
}

fn recover_stale(
	core: &Core,
	root: &Path,
	journal_path: &Path,
	cancel: CancelToken,
) -> AnyResult<()> {
	let journal = read_journal(journal_path)?;
	validate_journal(&journal, &core.scheme)?;
	let directory = root.join(&journal.id);
	let mut environment = core.env.clone();
	for key in JOURNAL_ENVIRONMENT_KEYS {
		environment.remove(key);
		if let Some(value) = journal.environment.get(key) {
			environment.insert(key.to_owned(), value.clone());
		}
	}
	let home = root
		.ancestors()
		.nth(5)
		.ok_or_else(|| anyhow!("invalid native OAuth storage root"))?
		.to_owned();
	let context = Context::new(
		home,
		directory,
		journal.scheme.clone(),
		journal.id.clone(),
		environment,
		cancel,
	);
	extract_helper(&context).with_context(|| {
		format!(
			"failed to recreate native OAuth recovery helper; journal retained at {}",
			journal_path.display()
		)
	})?;
	platform::restore(&context, &journal.snapshot).with_context(|| {
		format!(
			"stale native OAuth restoration is uncertain; recovery journal retained at {}",
			journal_path.display()
		)
	})?;
	remove_transaction_then_journal(&context.directory, journal_path)
}

fn cleanup_registration(registration: &mut Registration, cancel: CancelToken) -> AnyResult<()> {
	let context = registration.context.with_cancel(cancel);
	extract_helper(&context).with_context(|| {
		format!(
			"failed to recreate native OAuth cleanup helper; recovery journal retained at {}",
			registration.journal_path.display()
		)
	})?;
	if !registration.journal_path.exists() {
		let journal = Journal {
			version:     JOURNAL_VERSION,
			id:          context.id.clone(),
			scheme:      context.scheme.clone(),
			environment: journal_environment(&context.env),
			snapshot:    registration.snapshot.clone(),
		};
		atomic_write(
			&registration.journal_path,
			&serde_json::to_vec(&journal).context("failed to serialize OAuth recovery journal")?,
			0o600,
		)
		.with_context(|| {
			format!(
				"failed to recreate OAuth recovery journal at {}",
				registration.journal_path.display()
			)
		})?;
	}
	platform::restore(&context, &registration.snapshot).with_context(|| {
		format!(
			"native OAuth restoration is uncertain; recovery journal retained at {}",
			registration.journal_path.display()
		)
	})?;
	remove_transaction_then_journal(&context.directory, &registration.journal_path).with_context(
		|| {
			format!(
				"restoration completed but cleanup is incomplete; journal retained when possible at {}",
				registration.journal_path.display()
			)
		},
	)?;
	registration
		.lease
		.release_native()
		.context("failed to release native OAuth callback lease")
}

fn read_journal(path: &Path) -> AnyResult<Journal> {
	let metadata = fs::symlink_metadata(path)
		.with_context(|| format!("failed to inspect recovery journal {}", path.display()))?;
	if !metadata.file_type().is_file() || metadata.len() > JOURNAL_LIMIT {
		bail!("invalid recovery journal at {}", path.display());
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		if metadata.permissions().mode() & 0o077 != 0 {
			bail!("recovery journal is not private at {}", path.display());
		}
	}
	let mut bytes = Vec::with_capacity(metadata.len() as usize);
	File::open(path)
		.with_context(|| format!("failed to open recovery journal {}", path.display()))?
		.take(JOURNAL_LIMIT + 1)
		.read_to_end(&mut bytes)?;
	if bytes.len() as u64 > JOURNAL_LIMIT {
		bail!("recovery journal exceeds size limit at {}", path.display());
	}
	serde_json::from_slice(&bytes)
		.with_context(|| format!("invalid recovery journal at {}", path.display()))
}

fn validate_journal(journal: &Journal, expected_scheme: &str) -> AnyResult<()> {
	if journal.version != JOURNAL_VERSION {
		bail!("unsupported native OAuth recovery journal version {}", journal.version);
	}
	if journal.scheme != expected_scheme {
		bail!("native OAuth recovery journal scheme mismatch");
	}
	validate_scheme(&journal.scheme)?;
	validate_transaction_id(&journal.id)?;
	if journal.environment.len() > JOURNAL_ENVIRONMENT_KEYS.len()
		|| journal.environment.iter().any(|(key, value)| {
			!JOURNAL_ENVIRONMENT_KEYS.contains(&key.as_str())
				|| value.contains('\0')
				|| value.len() > 128 * 1024
		}) {
		bail!("invalid environment in native OAuth recovery journal");
	}
	Ok(())
}

fn journal_environment(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
	JOURNAL_ENVIRONMENT_KEYS
		.into_iter()
		.filter_map(|key| env.get(key).map(|value| (key.to_owned(), value.clone())))
		.collect()
}

fn extract_helper(context: &Context) -> AnyResult<()> {
	context.check()?;
	ensure_private_dir(&context.directory)?;
	if fs::symlink_metadata(&context.helper_path)
		.is_ok_and(|metadata| metadata.file_type().is_file())
		&& fs::read(&context.helper_path).is_ok_and(|bytes| bytes == HELPER_BYTES)
	{
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			fs::set_permissions(&context.helper_path, fs::Permissions::from_mode(0o700))?;
		}
		return Ok(());
	}
	#[cfg(target_os = "windows")]
	if context.helper_path.exists() {
		fs::remove_file(&context.helper_path)?;
	}
	atomic_write(&context.helper_path, HELPER_BYTES, 0o700)
}

fn remove_transaction_then_journal(directory: &Path, journal: &Path) -> AnyResult<()> {
	if directory.exists() {
		fs::remove_dir_all(directory)
			.with_context(|| format!("failed to remove OAuth transaction {}", directory.display()))?;
	}
	fs::remove_file(journal)
		.with_context(|| format!("failed to remove OAuth recovery journal {}", journal.display()))?;
	Ok(())
}

async fn wait_for_callback_async(
	path: &Path,
	scheme: &str,
	transaction: &str,
	wait: u64,
	cancel: &CancelToken,
) -> AnyResult<String> {
	let claim = path.with_file_name(format!("callback.claimed-{transaction}-{wait}"));
	loop {
		cancel
			.heartbeat()
			.map_err(|error| anyhow!(error.to_string()))?;
		match tokio::fs::rename(path, &claim).await {
			Ok(()) => break,
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				tokio::select! {
					() = tokio::time::sleep(POLL_INTERVAL) => {},
					_ = cancel.wait() => {
						cancel.heartbeat().map_err(|error| anyhow!(error.to_string()))?;
						bail!("native OAuth callback wait was cancelled");
					},
				}
			},
			Err(error) => return Err(error).context("failed to claim native OAuth callback"),
		}
	}
	let result = async {
		cancel
			.heartbeat()
			.map_err(|error| anyhow!(error.to_string()))?;
		let metadata = tokio::fs::symlink_metadata(&claim).await?;
		if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > CALLBACK_LIMIT {
			bail!("invalid native OAuth callback file");
		}
		let bytes = tokio::fs::read(&claim).await?;
		if bytes.len() as u64 > CALLBACK_LIMIT {
			bail!("native OAuth callback exceeds size limit");
		}
		let url = String::from_utf8(bytes).context("native OAuth callback was not UTF-8")?;
		if !url.starts_with(&format!("{scheme}:"))
			|| url.chars().any(char::is_control)
			|| url.trim() != url
		{
			bail!("native OAuth callback URL did not match the registered scheme");
		}
		Ok(url)
	}
	.await;
	let _ = tokio::fs::remove_file(&claim).await;
	result
}

fn validate_scheme(scheme: &str) -> AnyResult<()> {
	let mut chars = scheme.chars();
	if !matches!(chars.next(), Some('a'..='z'))
		|| !chars.all(|character| {
			character.is_ascii_lowercase()
				|| character.is_ascii_digit()
				|| matches!(character, '+' | '-' | '.')
		}) || scheme.len() > 128
	{
		bail!("invalid native OAuth URL scheme");
	}
	Ok(())
}

fn validate_transaction_id(id: &str) -> AnyResult<()> {
	if id.len() != 32
		|| !id
			.bytes()
			.all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	{
		bail!("invalid native OAuth transaction id");
	}
	Ok(())
}

fn transaction_id() -> AnyResult<String> {
	const HEX: &[u8; 16] = b"0123456789abcdef";

	let mut bytes = [0_u8; 16];
	fill_random(&mut bytes)?;
	let mut id = String::with_capacity(32);
	for byte in bytes {
		id.push(char::from(HEX[usize::from(byte >> 4)]));
		id.push(char::from(HEX[usize::from(byte & 0x0f)]));
	}
	Ok(id)
}

#[cfg(unix)]
fn fill_random(bytes: &mut [u8; 16]) -> AnyResult<()> {
	use std::io::Read as _;

	File::open("/dev/urandom")
		.context("failed to open the operating-system random source")?
		.read_exact(bytes)
		.context("failed to generate OAuth ownership nonce")
}

#[cfg(target_os = "windows")]
fn fill_random(bytes: &mut [u8; 16]) -> AnyResult<()> {
	let mut guid = windows_sys::core::GUID::default();
	// SAFETY: `guid` is a live writable GUID for the duration of the call.
	let result = unsafe { windows_sys::Win32::System::Com::CoCreateGuid(&raw mut guid) };
	if result < 0 {
		bail!("failed to generate OAuth ownership nonce (HRESULT {result:#010x})");
	}
	// SAFETY: a GUID and the destination are both exactly 16 bytes and do not
	// overlap.
	unsafe {
		std::ptr::copy_nonoverlapping(
			std::ptr::from_ref(&guid).cast::<u8>(),
			bytes.as_mut_ptr(),
			bytes.len(),
		);
	}
	Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn fill_random(_bytes: &mut [u8; 16]) -> AnyResult<()> {
	bail!("native OAuth callbacks are unsupported on this platform")
}

fn environment_home(env: &BTreeMap<String, String>) -> Option<PathBuf> {
	#[cfg(target_os = "windows")]
	let home = env.get("USERPROFILE").or_else(|| env.get("HOME"));
	#[cfg(not(target_os = "windows"))]
	let home = env.get("HOME").or_else(|| env.get("USERPROFILE"));
	home
		.map(PathBuf::from)
		.or_else(|| Some(PathBuf::from(format!("{}{}", env.get("HOMEDRIVE")?, env.get("HOMEPATH")?))))
}

fn storage_root(home: &Path, scheme: &str) -> PathBuf {
	home
		.join(".omp")
		.join("oauth")
		.join("native")
		.join(platform_name())
		.join(scheme)
}

const fn platform_name() -> &'static str {
	if cfg!(target_os = "macos") {
		"darwin"
	} else if cfg!(target_os = "linux") {
		"linux"
	} else if cfg!(target_os = "windows") {
		"windows"
	} else {
		"unsupported"
	}
}

fn ensure_storage_root(root: &Path) -> AnyResult<()> {
	ensure_private_dir(root)?;
	let metadata = fs::symlink_metadata(root)?;
	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		bail!("native OAuth storage root is not a private directory");
	}
	Ok(())
}

fn session_supported(env: &BTreeMap<String, String>) -> bool {
	if ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
		.iter()
		.any(|name| env.get(*name).is_some_and(|value| !value.is_empty()))
	{
		return false;
	}
	#[cfg(target_os = "linux")]
	{
		if env
			.get("WSL_DISTRO_NAME")
			.is_some_and(|value| !value.is_empty())
			|| env
				.get("WSL_INTEROP")
				.is_some_and(|value| !value.is_empty())
			|| fs::read_to_string("/proc/sys/kernel/osrelease")
				.is_ok_and(|release| release.to_ascii_lowercase().contains("microsoft"))
		{
			return false;
		}
		if !["DISPLAY", "WAYLAND_DISPLAY"]
			.iter()
			.any(|name| env.get(*name).is_some_and(|value| !value.is_empty()))
		{
			return false;
		}
	}
	#[cfg(target_os = "windows")]
	if env
		.get("SESSIONNAME")
		.is_some_and(|value| value.eq_ignore_ascii_case("services"))
	{
		return false;
	}
	true
}

fn napi_error(error: impl std::fmt::Display) -> Error {
	Error::from_reason(error.to_string())
}

#[cfg(test)]
mod tests;
