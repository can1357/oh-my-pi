use std::{
	fs,
	io::ErrorKind,
	path::{Component, Path, PathBuf},
};

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};

use super::context::{Context, atomic_write};

const SNAPSHOT_VERSION: u32 = 1;
const BUNDLE_PREFIX: &str = "dev.omp.oauth-callback.";
const APP_PREFIX: &str = "omp OAuth Callback ";
const STAGING_APP_NAME: &str = "OMP OAuth Callback.app";
const EXECUTABLE_NAME: &str = "darwin-helper";
const LEGACY_RECOVERY_FILE: &str = "darwin-url-callback.json";
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/\
                          LaunchServices.framework/Support/lsregister";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum ApplicationState {
	Absent,
	Found {
		#[serde(rename = "appPath")]
		app_path:  PathBuf,
		#[serde(rename = "bundleId")]
		bundle_id: String,
	},
	Unknown,
}

impl ApplicationState {
	fn found(&self) -> Option<(&Path, &str)> {
		match self {
			Self::Found { app_path, bundle_id } => Some((app_path, bundle_id)),
			Self::Absent | Self::Unknown => None,
		}
	}

	fn is_valid_snapshot_value(&self) -> bool {
		match self {
			Self::Absent => true,
			Self::Found { app_path, bundle_id } => {
				is_safe_absolute_path(app_path)
					&& valid_bundle_id(bundle_id)
					&& !bundle_id.starts_with(BUNDLE_PREFIX)
			},
			Self::Unknown => false,
		}
	}
}

/// Durable macOS Launch Services state needed to undo one callback
/// registration.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
	version:       u32,
	id:            String,
	scheme:        String,
	app_path:      PathBuf,
	bundle_id:     String,
	callback_path: PathBuf,
	previous:      ApplicationState,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationResult {
	status: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LegacyRecoveryRecord {
	app_path:         PathBuf,
	bundle_id:        String,
	pid:              i32,
	previous_handler: String,
	scheme:           String,
}

fn staging_app_path(context: &Context) -> PathBuf {
	context.directory.join(STAGING_APP_NAME)
}

fn expected_app_path(context: &Context) -> PathBuf {
	context
		.home
		.join("Applications")
		.join(format!("{APP_PREFIX}{}.app", context.id))
}

fn executable_path(app_path: &Path) -> PathBuf {
	app_path
		.join("Contents")
		.join("MacOS")
		.join(EXECUTABLE_NAME)
}

fn expected_bundle_id(context: &Context) -> String {
	format!("{BUNDLE_PREFIX}{}", context.id)
}

const fn found_application(app_path: PathBuf, bundle_id: String) -> ApplicationState {
	ApplicationState::Found { app_path, bundle_id }
}

fn valid_scheme(value: &str) -> bool {
	let mut bytes = value.bytes();
	matches!(bytes.next(), Some(b'a'..=b'z'))
		&& bytes.all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'.' | b'-')
		})
}

fn valid_id(value: &str) -> bool {
	!value.is_empty()
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_bundle_id(value: &str) -> bool {
	let mut bytes = value.bytes();
	matches!(bytes.next(), Some(byte) if byte.is_ascii_alphanumeric())
		&& bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn is_safe_absolute_path(path: &Path) -> bool {
	path.is_absolute()
		&& path
			.components()
			.all(|component| !matches!(component, Component::ParentDir | Component::CurDir))
}

fn validate_context(context: &Context) -> Result<()> {
	if !valid_scheme(&context.scheme) {
		bail!("invalid macOS OAuth callback scheme");
	}
	if !valid_id(&context.id) {
		bail!("invalid macOS OAuth callback transaction identifier");
	}
	if !is_safe_absolute_path(&context.directory)
		|| !is_safe_absolute_path(&context.callback_path)
		|| context.callback_path.parent() != Some(context.directory.as_path())
	{
		bail!("macOS OAuth callback output must be in its private transaction directory");
	}
	Ok(())
}

fn validate_snapshot(context: &Context, snapshot: &Snapshot) -> Result<()> {
	validate_context(context)?;
	if snapshot.version != SNAPSHOT_VERSION
		|| snapshot.id != context.id
		|| snapshot.scheme != context.scheme
		|| snapshot.app_path != expected_app_path(context)
		|| snapshot.bundle_id != expected_bundle_id(context)
		|| snapshot.callback_path != context.callback_path
		|| !snapshot.previous.is_valid_snapshot_value()
	{
		bail!("invalid macOS OAuth callback snapshot; refusing recovery");
	}
	if let Some((previous_path, _)) = snapshot.previous.found()
		&& previous_path == snapshot.app_path
	{
		bail!("invalid macOS OAuth callback snapshot application path");
	}
	Ok(())
}

fn xml(value: &str) -> String {
	let mut escaped = String::with_capacity(value.len());
	for character in value.chars() {
		match character {
			'&' => escaped.push_str("&amp;"),
			'<' => escaped.push_str("&lt;"),
			'>' => escaped.push_str("&gt;"),
			'"' => escaped.push_str("&quot;"),
			'\'' => escaped.push_str("&apos;"),
			_ => escaped.push(character),
		}
	}
	escaped
}

fn info_plist(context: &Context) -> String {
	format!(
		r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>{EXECUTABLE_NAME}</string>
	<key>CFBundleIdentifier</key>
	<string>{}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>omp OAuth Callback</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>CFBundleURLName</key>
			<string>omp OAuth Callback</string>
			<key>CFBundleURLSchemes</key>
			<array><string>{}</string></array>
		</dict>
	</array>
	<key>LSUIElement</key>
	<true/>
	<key>OMPCallbackPath</key>
	<string>{}</string>
</dict>
</plist>
"#,
		xml(&expected_bundle_id(context)),
		xml(&context.scheme),
		xml(&context.callback_path.to_string_lossy()),
	)
}

fn assemble_application(context: &Context, app_path: &Path) -> Result<()> {
	let executable_path = executable_path(app_path);
	let macos_directory = executable_path
		.parent()
		.context("macOS callback executable has no parent directory")?;
	fs::create_dir_all(macos_directory).with_context(|| {
		format!("failed to create macOS callback application at {}", macos_directory.display())
	})?;
	set_directory_mode(app_path)?;
	set_directory_mode(&app_path.join("Contents"))?;
	set_directory_mode(macos_directory)?;

	let helper = fs::read(&context.helper_path).with_context(|| {
		format!("failed to read embedded macOS callback helper at {}", context.helper_path.display())
	})?;
	if helper.is_empty() {
		bail!("embedded macOS OAuth callback helper is empty");
	}
	atomic_write(&executable_path, &helper, 0o700)?;
	atomic_write(
		&app_path.join("Contents").join("Info.plist"),
		info_plist(context).as_bytes(),
		0o600,
	)?;
	Ok(())
}

#[cfg(unix)]
fn set_directory_mode(path: &Path) -> Result<()> {
	use std::os::unix::fs::PermissionsExt;

	fs::set_permissions(path, fs::Permissions::from_mode(0o700))
		.with_context(|| format!("failed to secure {}", path.display()))
}

#[cfg(not(unix))]
fn set_directory_mode(_path: &Path) -> Result<()> {
	Ok(())
}

fn path_exists(path: &Path) -> Result<bool> {
	match fs::symlink_metadata(path) {
		Ok(_) => Ok(true),
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
		Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
	}
}

fn remove_application(path: &Path) -> Result<()> {
	match fs::remove_dir_all(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error).with_context(|| {
			format!("failed to remove macOS callback application {}", path.display())
		}),
	}
}

fn remove_transaction_applications(context: &Context, snapshot: &Snapshot) -> Result<()> {
	remove_application(&snapshot.app_path)?;
	remove_application(&staging_app_path(context))
}

fn directory_is_real(path: &Path) -> Result<bool> {
	match fs::symlink_metadata(path) {
		Ok(metadata) => Ok(metadata.is_dir() && !metadata.file_type().is_symlink()),
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
		Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
	}
}

fn visible_bundle_files_are_ours(context: &Context, app_path: &Path) -> Result<bool> {
	if !directory_is_real(app_path)?
		|| !directory_is_real(&app_path.join("Contents"))?
		|| !directory_is_real(&app_path.join("Contents").join("MacOS"))?
	{
		return Ok(false);
	}
	let expected_helper = fs::read(&context.helper_path).with_context(|| {
		format!("failed to read embedded macOS callback helper at {}", context.helper_path.display())
	})?;
	let installed_helper = fs::read(executable_path(app_path))
		.with_context(|| format!("failed to inspect callback application {}", app_path.display()))?;
	let installed_plist = fs::read(app_path.join("Contents").join("Info.plist"))
		.with_context(|| format!("failed to inspect callback application {}", app_path.display()))?;
	Ok(installed_helper == expected_helper && installed_plist == info_plist(context).as_bytes())
}

fn move_staging_application(context: &Context, destination: &Path) -> Result<()> {
	use std::{ffi::CString, os::unix::ffi::OsStrExt};

	let parent = destination
		.parent()
		.context("macOS callback application has no parent directory")?;
	fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
	let source = staging_app_path(context);
	let source_c = CString::new(source.as_os_str().as_bytes())
		.context("macOS callback staging path contains a NUL byte")?;
	let destination_c = CString::new(destination.as_os_str().as_bytes())
		.context("macOS callback application path contains a NUL byte")?;
	// RENAME_EXCL makes publishing the prepared directory one atomic,
	// no-clobber operation. A cross-volume layout fails instead of falling
	// back to a visible partial copy.
	// SAFETY: both pointers are live, NUL-terminated path strings; flags contain
	// only the documented macOS no-replace operation.
	if unsafe { libc::renamex_np(source_c.as_ptr(), destination_c.as_ptr(), libc::RENAME_EXCL) } != 0
	{
		return Err(std::io::Error::last_os_error()).with_context(|| {
			format!(
				"failed to atomically publish macOS callback application at {}",
				destination.display()
			)
		});
	}
	Ok(())
}

fn parse_application_state(output: &str, operation: &str) -> Result<ApplicationState> {
	let state: ApplicationState = serde_json::from_str(output)
		.with_context(|| format!("macOS callback helper returned invalid JSON while {operation}"))?;
	match &state {
		ApplicationState::Unknown => {
			bail!("macOS could not identify the application while {operation}")
		},
		ApplicationState::Found { app_path, bundle_id }
			if !is_safe_absolute_path(app_path) || !valid_bundle_id(bundle_id) =>
		{
			bail!("macOS callback helper returned an invalid application while {operation}")
		},
		ApplicationState::Absent | ApplicationState::Found { .. } => Ok(state),
	}
}

fn query_scheme(context: &Context, scheme: &str) -> Result<ApplicationState> {
	let output = context.run(&context.helper_path, &["query".to_owned(), scheme.to_owned()])?;
	parse_application_state(&output, &format!("querying the {scheme} URL handler"))
}

fn resolve_bundle(context: &Context, bundle_id: &str) -> Result<ApplicationState> {
	if !valid_bundle_id(bundle_id) {
		bail!("invalid macOS application bundle identifier");
	}
	let output = context.run(&context.helper_path, &["resolve".to_owned(), bundle_id.to_owned()])?;
	let state =
		parse_application_state(&output, &format!("resolving macOS application {bundle_id}"))?;
	if let ApplicationState::Found { bundle_id: resolved, .. } = &state
		&& resolved != bundle_id
	{
		bail!("macOS resolved {bundle_id} to an application with a different bundle identifier");
	}
	Ok(state)
}

fn set_scheme_handler(context: &Context, scheme: &str, app_path: &Path) -> Result<()> {
	if !is_safe_absolute_path(app_path) {
		bail!("refusing to select an invalid macOS application path");
	}
	let output = context.run(&context.helper_path, &[
		"set".to_owned(),
		scheme.to_owned(),
		app_path.to_string_lossy().into_owned(),
	])?;
	let result: OperationResult = serde_json::from_str(&output)
		.context("macOS callback helper returned invalid JSON after selecting a URL handler")?;
	if result.status != "ok" {
		bail!("macOS callback helper did not confirm the URL-handler change");
	}
	Ok(())
}

fn unregister_application(context: &Context, app_path: &Path) -> Result<()> {
	context
		.run(Path::new(LSREGISTER), &["-u".to_owned(), app_path.to_string_lossy().into_owned()])?;
	Ok(())
}

fn same_application(left: &ApplicationState, right: &ApplicationState) -> bool {
	left == right
}

fn remove_own_registration(
	context: &Context,
	snapshot: &Snapshot,
	expected_handler: &ApplicationState,
) -> Result<()> {
	unregister_application(context, &snapshot.app_path)?;
	let after = query_scheme(context, &context.scheme)?;
	if matches!(
		 &after,
		 ApplicationState::Found { bundle_id, .. } if bundle_id == &snapshot.bundle_id
	) {
		bail!("macOS still resolves {} URLs to the temporary omp application", context.scheme);
	}
	if !same_application(&after, expected_handler) {
		bail!(
			"the external {} URL handler changed while removing the omp application",
			context.scheme
		);
	}
	remove_transaction_applications(context, snapshot)
}

fn legacy_recovery_path(context: &Context) -> PathBuf {
	let config_directory = context
		.env
		.get("PI_CONFIG_DIR")
		.map(|value| value.trim())
		.filter(|value| !value.is_empty())
		.unwrap_or(".omp");
	context
		.home
		.join(config_directory)
		.join("oauth")
		.join(LEGACY_RECOVERY_FILE)
}

fn valid_legacy_record(context: &Context, record: &LegacyRecoveryRecord) -> bool {
	let applications = context.home.join("Applications");
	let Ok(relative) = record.app_path.strip_prefix(&applications) else {
		return false;
	};
	let Some(file_name) = record.app_path.file_name().and_then(|value| value.to_str()) else {
		return false;
	};
	is_safe_absolute_path(&record.app_path)
		&& !relative.as_os_str().is_empty()
		&& relative
			.components()
			.all(|component| matches!(component, Component::Normal(_)))
		&& file_name.starts_with(APP_PREFIX)
		&& file_name.len() > APP_PREFIX.len() + ".app".len()
		&& record.app_path.extension().and_then(|value| value.to_str()) == Some("app")
		&& record.bundle_id.starts_with(BUNDLE_PREFIX)
		&& record.bundle_id.len() > BUNDLE_PREFIX.len()
		&& valid_bundle_id(&record.bundle_id)
		&& record.pid > 0
		&& valid_scheme(&record.scheme)
		&& (record.previous_handler.is_empty()
			|| (valid_bundle_id(&record.previous_handler)
				&& !record.previous_handler.starts_with(BUNDLE_PREFIX)))
}

fn read_legacy_recovery(context: &Context) -> Result<Option<LegacyRecoveryRecord>> {
	let path = legacy_recovery_path(context);
	let bytes = match fs::read(&path) {
		Ok(bytes) => bytes,
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
		Err(error) => {
			return Err(error)
				.with_context(|| format!("failed to read legacy recovery record {}", path.display()));
		},
	};
	let record: LegacyRecoveryRecord = serde_json::from_slice(&bytes).with_context(|| {
		format!(
			"invalid legacy macOS OAuth recovery record at {}; recovery was not attempted",
			path.display()
		)
	})?;
	if !valid_legacy_record(context, &record) {
		bail!(
			"invalid legacy macOS OAuth recovery record at {}; recovery was not attempted",
			path.display()
		);
	}
	Ok(Some(record))
}

#[cfg(unix)]
fn process_is_alive(pid: i32) -> bool {
	// A zero signal only probes process ownership/existence and does not alter it.
	// SAFETY: `kill` accepts every integer PID and a zero signal has no side
	// effect.
	let result = unsafe { libc::kill(pid, 0) };
	result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_is_alive(_pid: i32) -> bool {
	false
}

fn remove_path_if_present(path: &Path) -> Result<()> {
	match fs::remove_file(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
	}
}

fn recover_legacy_registration(context: &Context) -> Result<()> {
	let Some(record) = read_legacy_recovery(context)? else {
		return Ok(());
	};
	if process_is_alive(record.pid) {
		bail!("another OAuth login is already waiting for a custom-scheme callback");
	}
	let owned_app = resolve_bundle(context, &record.bundle_id)?;
	if owned_app != found_application(record.app_path.clone(), record.bundle_id.clone()) {
		bail!("legacy recovery record does not identify the registered owned application");
	}

	let before = query_scheme(context, &record.scheme)?;
	let expected_after = match &before {
		ApplicationState::Found { app_path, bundle_id } if bundle_id == &record.bundle_id => {
			if app_path != &record.app_path {
				bail!("legacy omp callback bundle resolves to an unexpected application path");
			}
			if record.previous_handler.is_empty() {
				unregister_application(context, &record.app_path)?;
				let after = query_scheme(context, &record.scheme)?;
				if matches!(
					 &after,
					 ApplicationState::Found { bundle_id, .. } if bundle_id == &record.bundle_id
				) {
					bail!("macOS still uses the legacy omp callback application");
				}
				after
			} else {
				let previous = resolve_bundle(context, &record.previous_handler)?;
				if !matches!(&previous, ApplicationState::Found { .. }) {
					bail!(
						"cannot safely restore legacy handler {}; its application is unavailable",
						record.previous_handler
					);
				}
				let (previous_path, _) = previous
					.found()
					.context("resolved legacy handler has no application path")?;
				set_scheme_handler(context, &record.scheme, previous_path)?;
				let restored = query_scheme(context, &record.scheme)?;
				if !same_application(&restored, &previous) {
					bail!("macOS did not restore the legacy URL handler");
				}
				unregister_application(context, &record.app_path)?;
				let after = query_scheme(context, &record.scheme)?;
				if !same_application(&after, &restored) {
					bail!("legacy URL handler changed while unregistering the omp application");
				}
				after
			}
		},
		ApplicationState::Found { bundle_id, .. } if bundle_id.starts_with(BUNDLE_PREFIX) => {
			bail!("an unrelated omp callback application owns the legacy URL scheme")
		},
		ApplicationState::Absent | ApplicationState::Found { .. } => {
			unregister_application(context, &record.app_path)?;
			let after = query_scheme(context, &record.scheme)?;
			if !same_application(&after, &before) {
				bail!("external URL handler changed during legacy recovery");
			}
			after
		},
		ApplicationState::Unknown => unreachable!("query_scheme rejects unknown state"),
	};

	if matches!(
		 &expected_after,
		 ApplicationState::Found { bundle_id, .. } if bundle_id == &record.bundle_id
	) {
		bail!("macOS still resolves the legacy omp callback application");
	}
	match fs::remove_dir_all(&record.app_path) {
		Ok(()) => {},
		Err(error) if error.kind() == ErrorKind::NotFound => {},
		Err(error) => {
			return Err(error).with_context(|| {
				format!("failed to remove legacy callback application {}", record.app_path.display())
			});
		},
	}
	remove_path_if_present(&legacy_recovery_path(context))
}

/// Builds a private, unregistered staging bundle and captures the current
/// handler.
pub(super) fn prepare(context: &Context) -> Result<Snapshot> {
	validate_context(context)?;
	let app_path = expected_app_path(context);
	let staging_path = staging_app_path(context);
	if path_exists(&app_path)? {
		bail!("macOS callback application path already exists at {}", app_path.display());
	}
	if path_exists(&staging_path)? {
		bail!("macOS callback staging path already exists at {}", staging_path.display());
	}
	assemble_application(context, &staging_path)?;
	let result = (|| {
		recover_legacy_registration(context)?;
		let previous = query_scheme(context, &context.scheme)?;
		if let ApplicationState::Found { bundle_id, .. } = &previous
			&& bundle_id.starts_with(BUNDLE_PREFIX)
		{
			bail!(
				"stale omp callback handler {bundle_id} has no recovery journal; remove it and retry"
			);
		}
		Ok(Snapshot {
			version: SNAPSHOT_VERSION,
			id: context.id.clone(),
			scheme: context.scheme.clone(),
			app_path,
			bundle_id: expected_bundle_id(context),
			callback_path: context.callback_path.clone(),
			previous,
		})
	})();
	if result.is_err() {
		let _ = fs::remove_dir_all(staging_path);
	}
	result
}

/// Publishes the staged bundle, then selects it as the scheme handler.
pub(super) fn activate(context: &Context, snapshot: &Snapshot) -> Result<()> {
	validate_snapshot(context, snapshot)?;
	move_staging_application(context, &snapshot.app_path)?;
	set_scheme_handler(context, &context.scheme, &snapshot.app_path)?;
	let active = query_scheme(context, &context.scheme)?;
	match active {
		ApplicationState::Found { app_path, bundle_id }
			if app_path == snapshot.app_path && bundle_id == snapshot.bundle_id =>
		{
			Ok(())
		},
		ApplicationState::Absent | ApplicationState::Found { .. } | ApplicationState::Unknown => {
			bail!("macOS did not activate the temporary {} callback application", context.scheme)
		},
	}
}

/// Restores only a handler still owned by this transaction, then unregisters
/// its app.
pub(super) fn restore(context: &Context, snapshot: &Snapshot) -> Result<()> {
	validate_snapshot(context, snapshot)?;
	let active = query_scheme(context, &context.scheme)?;
	let staging_path = staging_app_path(context);
	let staging_exists = path_exists(&staging_path)?;
	let visible_exists = path_exists(&snapshot.app_path)?;
	if staging_exists && visible_exists {
		bail!("both staged and visible macOS callback applications exist; recovery is uncertain");
	}

	let own_active = match &active {
		ApplicationState::Found { app_path, bundle_id } if bundle_id == &snapshot.bundle_id => {
			if app_path != &snapshot.app_path {
				bail!("active omp callback bundle has an unexpected application path");
			}
			true
		},
		ApplicationState::Absent | ApplicationState::Found { .. } => false,
		ApplicationState::Unknown => unreachable!("query_scheme rejects unknown state"),
	};

	if !own_active && staging_exists {
		// The atomic publish did not happen, so activation could not have
		// selected the visible application. No OS value belongs to us.
		remove_application(&staging_path)?;
		return Ok(());
	}

	if !visible_exists {
		if staging_exists {
			move_staging_application(context, &snapshot.app_path)?;
		} else if own_active {
			// Activation completed before the visible bundle was externally
			// removed. Reconstruct its exact URL so Launch Services can remove it.
			assemble_application(context, &snapshot.app_path)?;
		} else {
			return Ok(());
		}
	} else if !own_active && !visible_bundle_files_are_ours(context, &snapshot.app_path)? {
		bail!("visible macOS callback application is not owned by this transaction");
	}

	if own_active {
		match &snapshot.previous {
			ApplicationState::Found { bundle_id, .. } => {
				let previous = resolve_bundle(context, bundle_id)?;
				let (previous_path, _) = previous.found().with_context(|| {
					format!("cannot safely restore {bundle_id}; its application is unavailable")
				})?;
				set_scheme_handler(context, &context.scheme, previous_path)?;
				let restored = query_scheme(context, &context.scheme)?;
				if !same_application(&restored, &previous) {
					bail!("macOS did not restore the previous URL handler");
				}
				remove_own_registration(context, snapshot, &restored)
			},
			ApplicationState::Absent => {
				unregister_application(context, &snapshot.app_path)?;
				let after = query_scheme(context, &context.scheme)?;
				if matches!(
					 &after,
					 ApplicationState::Found { bundle_id, .. } if bundle_id == &snapshot.bundle_id
				) {
					bail!("macOS still resolves URLs to the temporary omp application");
				}
				remove_transaction_applications(context, snapshot)
			},
			ApplicationState::Unknown => bail!("invalid macOS OAuth callback snapshot"),
		}
	} else {
		remove_own_registration(context, snapshot, &active)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, HashMap},
		sync::{
			Arc,
			atomic::{AtomicU64, Ordering},
		},
	};

	use parking_lot::Mutex;
	use serde_json::json;

	use super::*;
	use crate::task::CancelToken;

	static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir()
				.join(format!("pi-native-darwin-oauth-{}-{serial}", std::process::id()));
			let _ = fs::remove_dir_all(&path);
			fs::create_dir_all(&path).unwrap();
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[derive(Clone)]
	struct FakeLaunchServices {
		current:             ApplicationState,
		apps:                HashMap<String, ApplicationState>,
		calls:               Vec<(PathBuf, Vec<String>)>,
		unregister_fallback: ApplicationState,
		fail_unregister:     bool,
		own:                 ApplicationState,
	}

	fn found(path: impl Into<PathBuf>, bundle_id: impl Into<String>) -> ApplicationState {
		ApplicationState::Found { app_path: path.into(), bundle_id: bundle_id.into() }
	}

	fn context(
		root: &TempDir,
		current: ApplicationState,
	) -> (Context, Arc<Mutex<FakeLaunchServices>>) {
		let home = root.0.join("home");
		let directory = root.0.join("transaction");
		fs::create_dir_all(&home).unwrap();
		fs::create_dir_all(&directory).unwrap();
		fs::write(directory.join("callback-helper"), b"precompiled helper").unwrap();
		let mut context = Context::new(
			home,
			directory,
			"omp-auth".to_owned(),
			"0123456789abcdef0123456789abcdef".to_owned(),
			BTreeMap::new(),
			CancelToken::default(),
		);
		let own = found(expected_app_path(&context), expected_bundle_id(&context));
		let state = Arc::new(Mutex::new(FakeLaunchServices {
			current,
			apps: HashMap::new(),
			calls: Vec::new(),
			unregister_fallback: ApplicationState::Absent,
			fail_unregister: false,
			own,
		}));
		let runner_state = Arc::clone(&state);
		context.runner = Some(Arc::new(move |program, args| {
			let mut state = runner_state.lock();
			state.calls.push((program.to_owned(), args.to_vec()));
			if program == Path::new(LSREGISTER) {
				if state.fail_unregister {
					bail!("injected unregister failure");
				}
				let removed = args.get(1).map(PathBuf::from);
				if state.current.found().map(|(path, _)| path) == removed.as_deref() {
					state.current = state.unregister_fallback.clone();
				}
				return Ok(String::new());
			}
			match args.first().map(String::as_str) {
				Some("query") => Ok(serde_json::to_string(&state.current)?),
				Some("resolve") => Ok(serde_json::to_string(
					&state
						.apps
						.get(args.get(1).context("missing resolve bundle")?)
						.cloned()
						.unwrap_or(ApplicationState::Absent),
				)?),
				Some("set") => {
					let path = PathBuf::from(args.get(2).context("missing set path")?);
					let selected = if state.own.found().map(|(own, _)| own) == Some(path.as_path()) {
						state.own.clone()
					} else {
						state
							.apps
							.values()
							.find(|app| {
								app.found().map(|(candidate, _)| candidate) == Some(path.as_path())
							})
							.cloned()
							.context("set selected an unknown application")?
					};
					state.current = selected;
					Ok(r#"{"status":"ok"}"#.to_owned())
				},
				operation => bail!("unexpected fake helper operation: {operation:?}"),
			}
		}));
		(context, state)
	}

	#[test]
	fn prepare_builds_private_application_and_captures_handler() {
		let root = TempDir::new();
		let previous = found(root.0.join("Editor.app"), "com.example.editor");
		let (context, _) = context(&root, previous.clone());

		let snapshot = prepare(&context).unwrap();

		assert_eq!(snapshot.previous, previous);
		let staging_path = staging_app_path(&context);
		let staging_executable = executable_path(&staging_path);
		assert_eq!(fs::read(&staging_executable).unwrap(), b"precompiled helper");
		let plist = fs::read_to_string(staging_path.join("Contents/Info.plist")).unwrap();
		assert!(plist.contains(&snapshot.bundle_id));
		assert!(plist.contains("<string>omp-auth</string>"));
		assert!(plist.contains(&context.callback_path.to_string_lossy().into_owned()));
		assert!(!snapshot.app_path.exists());
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			assert_eq!(
				fs::metadata(staging_executable)
					.unwrap()
					.permissions()
					.mode() & 0o777,
				0o700
			);
		}
	}

	#[test]
	fn activation_never_replaces_an_existing_visible_application() {
		let root = TempDir::new();
		let (context, state) = context(&root, ApplicationState::Absent);
		let snapshot = prepare(&context).unwrap();
		fs::create_dir_all(&snapshot.app_path).unwrap();
		fs::write(snapshot.app_path.join("foreign"), b"keep").unwrap();

		assert!(activate(&context, &snapshot).is_err());

		assert_eq!(fs::read(snapshot.app_path.join("foreign")).unwrap(), b"keep");
		assert!(staging_app_path(&context).exists());
		assert!(
			!state
				.lock()
				.calls
				.iter()
				.any(|(_, args)| args.first().map(String::as_str) == Some("set"))
		);
	}

	#[test]
	fn activation_and_restore_return_to_resolved_previous_application() {
		let root = TempDir::new();
		let captured_path = root.0.join("Previous.app");
		let moved_path = root.0.join("Moved Previous.app");
		let previous = found(&captured_path, "com.example.previous");
		let (context, state) = context(&root, previous.clone());
		let snapshot = prepare(&context).unwrap();
		state
			.lock()
			.apps
			.insert("com.example.previous".to_owned(), found(&moved_path, "com.example.previous"));

		activate(&context, &snapshot).unwrap();
		assert!(snapshot.app_path.exists());
		assert!(!staging_app_path(&context).exists());
		restore(&context, &snapshot).unwrap();

		assert_eq!(state.lock().current, found(&moved_path, "com.example.previous"));
		assert!(!snapshot.app_path.exists());
	}

	#[test]
	fn recovery_rebuilds_a_vanished_application_before_unregistering() {
		let root = TempDir::new();
		let (context, state) = context(&root, ApplicationState::Absent);
		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();
		fs::remove_dir_all(&snapshot.app_path).unwrap();

		restore(&context, &snapshot).unwrap();

		assert_eq!(state.lock().current, ApplicationState::Absent);
		assert!(!snapshot.app_path.exists());
	}

	#[test]
	fn restore_preserves_an_external_concurrent_handler() {
		let root = TempDir::new();
		let (context, state) = context(&root, ApplicationState::Absent);
		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();
		let external = found(root.0.join("External.app"), "com.example.external");
		state.lock().current = external.clone();

		restore(&context, &snapshot).unwrap();

		assert_eq!(state.lock().current, external);
		assert!(!snapshot.app_path.exists());
	}

	#[test]
	fn absent_handler_uses_checked_unregister_and_verifies_ownership_is_gone() {
		let root = TempDir::new();
		let (context, state) = context(&root, ApplicationState::Absent);
		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();

		restore(&context, &snapshot).unwrap();

		let state = state.lock();
		assert_eq!(state.current, ApplicationState::Absent);
		assert!(state.calls.iter().any(|(program, args)| {
			program == Path::new(LSREGISTER)
				&& args == &["-u".to_owned(), snapshot.app_path.to_string_lossy().into_owned()]
		}));
		assert!(!snapshot.app_path.exists());
	}

	#[test]
	fn uncertain_owned_bundle_path_preserves_application_for_recovery() {
		let root = TempDir::new();
		let (context, state) = context(&root, ApplicationState::Absent);
		let snapshot = prepare(&context).unwrap();
		state.lock().current = found(root.0.join("Impostor.app"), &snapshot.bundle_id);

		assert!(restore(&context, &snapshot).is_err());
		assert!(!snapshot.app_path.exists());
		assert!(staging_app_path(&context).exists());
		assert!(
			!state
				.lock()
				.calls
				.iter()
				.any(|(program, _)| program == Path::new(LSREGISTER))
		);
	}

	#[test]
	fn snapshot_validation_rejects_unrelated_paths() {
		let root = TempDir::new();
		let (context, _) = context(&root, ApplicationState::Absent);
		let mut snapshot = prepare(&context).unwrap();
		snapshot.app_path = context.home.join("unrelated.app");

		assert!(activate(&context, &snapshot).is_err());
	}

	#[test]
	fn legacy_recovery_restores_bundle_and_removes_owned_artifacts() {
		let root = TempDir::new();
		let legacy_app = root
			.0
			.join("home/Applications/omp OAuth Callback abandoned.app");
		fs::create_dir_all(&legacy_app).unwrap();
		let legacy_bundle = "dev.omp.oauth-callback.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		let (context, state) = context(&root, found(&legacy_app, legacy_bundle));
		let previous = found(root.0.join("Browser.app"), "com.example.browser");
		let mut state_guard = state.lock();
		state_guard
			.apps
			.insert(legacy_bundle.to_owned(), found(&legacy_app, legacy_bundle));
		state_guard
			.apps
			.insert("com.example.browser".to_owned(), previous.clone());
		drop(state_guard);
		let recovery_path = legacy_recovery_path(&context);
		fs::create_dir_all(recovery_path.parent().unwrap()).unwrap();
		fs::write(
			&recovery_path,
			serde_json::to_vec(&json!({
				 "appPath": legacy_app,
				 "bundleId": legacy_bundle,
				 "pid": i32::MAX,
				 "previousHandler": "com.example.browser",
				 "scheme": "omp-auth"
			}))
			.unwrap(),
		)
		.unwrap();

		let snapshot = prepare(&context).unwrap();

		assert_eq!(snapshot.previous, previous);
		assert!(!legacy_app.exists());
		assert!(!recovery_path.exists());
	}

	#[test]
	fn invalid_legacy_record_is_retained_and_generated_app_is_removed() {
		let root = TempDir::new();
		let (context, _) = context(&root, ApplicationState::Absent);
		let recovery_path = legacy_recovery_path(&context);
		fs::create_dir_all(recovery_path.parent().unwrap()).unwrap();
		fs::write(
            &recovery_path,
            br#"{"appPath":"/tmp/unowned.app","bundleId":"dev.omp.oauth-callback.bad","pid":999999,"previousHandler":"","scheme":"omp-auth"}"#,
        )
        .unwrap();

		assert!(prepare(&context).is_err());
		assert!(recovery_path.exists());
		assert!(!expected_app_path(&context).exists());
		assert!(!staging_app_path(&context).exists());
	}

	#[test]
	fn live_legacy_owner_is_not_recovered() {
		let root = TempDir::new();
		let legacy_app = root.0.join("home/Applications/omp OAuth Callback live.app");
		fs::create_dir_all(&legacy_app).unwrap();
		let (context, _) = context(&root, ApplicationState::Absent);
		let recovery_path = legacy_recovery_path(&context);
		fs::create_dir_all(recovery_path.parent().unwrap()).unwrap();
		fs::write(
			&recovery_path,
			serde_json::to_vec(&json!({
				 "appPath": legacy_app,
				 "bundleId": "dev.omp.oauth-callback.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				 "pid": std::process::id(),
				 "previousHandler": "",
				 "scheme": "omp-auth"
			}))
			.unwrap(),
		)
		.unwrap();

		assert!(prepare(&context).is_err());
		assert!(recovery_path.exists());
		assert!(legacy_app.exists());
	}
}
