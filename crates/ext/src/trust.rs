//! Local grant, publisher-key, and revocation state.

use std::{
	collections::BTreeSet,
	convert::Infallible,
	ffi::OsString,
	fs::{self, File, OpenOptions, TryLockError},
	io,
	path::{Path, PathBuf},
	str::FromStr as _,
	thread,
	time::{Duration, Instant},
};

use jiff::Timestamp;
use omp_core::{Hash32, Str, base64, encoding::hex, sf};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use strum::{Display, IntoStaticStr};
use thiserror::Error;

use super::{
	ExtensionCode, ExtensionError, Layer, TrustTier, WorkspaceUri,
	lock::atomic_toml,
	plugin_command::{
		CommandApprovals, PluginId, PluginLaunch, PluginLaunchKind, plugin_command_digest,
	},
	resolver::version_satisfies,
	workspace_trust::{
		CanonicalHome, TrustBinding, TrustChannel, TrustDecision, TrustSlot, WorkspaceTrustGrant,
		WorkspaceTrustRefusal,
	},
};

/// The local grant file under an omp data directory:
/// `<data>/ext/grants.toml`.
#[must_use]
pub fn grants_path(data_dir: &Path) -> PathBuf {
	data_dir.join("ext").join("grants.toml")
}

/// Directory containment covered by an operator grant.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
	/// Only the workspace recorded on the grant.
	#[default]
	Exact,
	/// The recorded workspace and every workspace below it.
	Subtree,
}

/// Lifetime of an interactive operator grant, ordered from shortest to
/// longest.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	Eq,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum GrantDuration {
	/// Admit only the current interactive attempt.
	Once,
	/// Admit for the remainder of the current process session.
	Session,
	/// Persist the grant for future sessions.
	#[default]
	Persistent,
}

/// An operator-originated capability grant.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Grant {
	/// Extension identity.
	pub id:                Str,
	/// TOFU-pinned publisher fingerprint.
	pub publisher:         Str,
	/// Layer where the grant applies.
	pub layer:             Layer,
	/// Workspace identity, omitted for client-layer grants.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub workspace:         Option<WorkspaceUri>,
	/// Workspace containment covered by this grant.
	#[serde(default)]
	pub scope:             GrantScope,
	/// Hash of the canonical declared capability set.
	pub capability_digest: Str,
	/// Tier approved by the operator.
	pub tier:              TrustTier,
	/// Approved code-shipping level.
	pub ship:              Str,
	/// RFC 3339 timestamp.
	pub granted_at:        Str,
	/// Operator channel: interactive, flag, or env.
	pub granted_by:        Str,
	/// Lifetime selected by the operator.
	#[serde(default)]
	pub duration:          GrantDuration,
}

/// An operator's approval for one command a plugin launches
/// ([`crate::plugin_command`]).
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PluginCommandGrant {
	/// Plugin identity ([`PluginId`]): a marketplace install's
	/// `name@marketplace`, or a local Agent Plugins package's manifest name.
	pub plugin:     PluginId,
	/// Plugin version the launch was approved for.
	pub version:    Str,
	/// Component that declared the launch when it was approved.
	pub kind:       PluginLaunchKind,
	/// Server or adapter name, or a hook's event and matcher, when it was
	/// approved.
	pub server:     Str,
	/// Approved executable.
	pub command:    Str,
	/// Approved arguments.
	#[serde(default)]
	pub args:       Vec<Str>,
	/// [`crate::plugin_command::plugin_command_digest`] of the approved launch;
	/// the only field the gate compares besides the plugin id.
	pub digest:     Hash32,
	/// RFC 3339 timestamp.
	pub granted_at: Str,
	/// Operator channel: interactive or cli.
	pub granted_by: Str,
}

impl PluginCommandGrant {
	/// The operator's approval of `launch` for `plugin` at `version`,
	/// stamped now, through the channel `granted_by` names.
	#[must_use]
	pub fn approve(
		plugin: &PluginId,
		version: &Str,
		launch: &PluginLaunch,
		granted_by: Str,
	) -> Self {
		Self {
			plugin: plugin.clone(),
			version: version.clone(),
			kind: launch.kind,
			server: launch.server.clone(),
			command: launch.command.clone(),
			args: launch.args.to_vec(),
			digest: plugin_command_digest(plugin, version, launch),
			granted_at: Str::new(Timestamp::now().to_string()),
			granted_by,
		}
	}
}

/// Local grant file, never committed with a workspace.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct GrantsFile {
	/// File format version.
	#[serde(default = "one")]
	pub version:         u32,
	/// Durable grants.
	#[serde(rename = "grant", default)]
	pub grants:          Vec<Grant>,
	/// Approved plugin-launched commands.
	#[serde(rename = "plugin_command", default, skip_serializing_if = "Vec::is_empty")]
	pub plugin_commands: Vec<PluginCommandGrant>,
	/// Operator trust in workspaces' project-sourced inputs
	/// ([`crate::workspace_trust`]).
	#[serde(rename = "workspace_trust", default, skip_serializing_if = "Vec::is_empty")]
	pub workspace_trust: Vec<WorkspaceTrustGrant>,
}

/// Failure reading the local grant file.
#[derive(Debug, Error)]
pub enum GrantsFileError {
	/// The grant file exists but could not be read.
	#[error("grant file {} could not be read", path.display())]
	Io {
		/// Grant file path.
		path:   PathBuf,
		/// Read failure.
		#[source]
		source: io::Error,
	},
	/// The grant file is not valid grant TOML.
	#[error("grant file {} is malformed", path.display())]
	Toml {
		/// Grant file path.
		path:   PathBuf,
		/// Decoding failure.
		#[source]
		source: toml::de::Error,
	},
}

impl GrantsFileError {
	/// The extension diagnostic class: local trust state is unreadable or
	/// corrupt.
	#[inline]
	pub const fn code(&self) -> ExtensionCode {
		ExtensionCode::EIntegrity
	}
}

/// Failure while committing an operator grant through the canonical grant
/// file writer.
#[derive(Debug, Error)]
pub enum GrantPersistenceError {
	/// Existing grant state could not be decoded.
	#[error("existing extension grants could not be read")]
	Read(#[from] GrantsFileError),
	/// The atomically replaced grant file could not be written.
	#[error("extension grants could not be persisted")]
	Write(#[source] io::Error),
	/// A process-local grant was passed to the durable grant writer.
	#[error("session-only extension grants cannot be persisted")]
	SessionOnly,
	/// The grant file lock could not be opened or taken.
	#[error("grant file lock {} could not be acquired", path.display())]
	Lock {
		/// Lock file path.
		path:   PathBuf,
		/// Open or lock failure.
		#[source]
		source: io::Error,
	},
	/// Another writer held the grant file lock for the whole bounded wait.
	#[error("grant file lock {} is still held after {waited:?}", path.display())]
	LockTimeout {
		/// Lock file path.
		path:   PathBuf,
		/// How long the writer waited.
		waited: Duration,
	},
}

/// How long a grant file writer waits for another writer's lock. Writers hold
/// it only across one read-modify-write, and one runs on an interactive
/// approval path, so a longer hold means a stuck process.
const GRANTS_LOCK_WAIT: Duration = Duration::from_secs(10);

/// Pause between attempts to take a contended grant file lock.
const GRANTS_LOCK_POLL: Duration = Duration::from_millis(10);

/// Exclusive hold on a grant file's sibling `<name>.lock`, released on drop.
///
/// The lock file is never renamed or removed, so every writer contends on the
/// same file even though the grant file itself is atomically replaced.
struct GrantsFileLock {
	_file: File,
}

impl GrantsFileLock {
	fn path(grants: &Path) -> PathBuf {
		let mut name = grants
			.file_name()
			.map_or_else(|| OsString::from("grants.toml"), ToOwned::to_owned);
		name.push(".lock");
		grants.with_file_name(name)
	}

	fn acquire(grants: &Path, wait: Duration) -> Result<Self, GrantPersistenceError> {
		let path = Self::path(grants);
		let file = grants
			.parent()
			.map_or(Ok(()), fs::create_dir_all)
			.and_then(|()| {
				OpenOptions::new()
					.create(true)
					.read(true)
					.write(true)
					.truncate(false)
					.open(&path)
			});
		let file = match file {
			Ok(file) => file,
			Err(source) => return Err(GrantPersistenceError::Lock { path, source }),
		};
		let started = Instant::now();
		loop {
			match file.try_lock() {
				Ok(()) => return Ok(Self { _file: file }),
				Err(TryLockError::WouldBlock) => {
					let waited = started.elapsed();
					if waited >= wait {
						return Err(GrantPersistenceError::LockTimeout { path, waited });
					}
					thread::sleep(GRANTS_LOCK_POLL.min(wait.saturating_sub(waited)));
				},
				Err(TryLockError::Error(source)) => {
					return Err(GrantPersistenceError::Lock { path, source });
				},
			}
		}
	}
}

/// The spelling a workspace trust revoke applies to: the first of the
/// workspace's `canonical` path and its `given` spelling that names a row (a
/// row's workspace, or a pin's subtree root), else `canonical`. `None` for a
/// missing workspace that names no row.
fn revoked_spelling<'p>(
	rows: &[WorkspaceTrustGrant],
	canonical: Option<&'p Path>,
	given: &'p Path,
) -> Option<&'p Path> {
	let names = |spelling: &Path| {
		rows.iter().any(|row| {
			row.workspace == spelling
				|| matches!(&row.binding, TrustBinding::Pin { under, .. } if under == spelling)
		})
	};
	canonical
		.into_iter()
		.chain([given])
		.find(|&spelling| names(spelling))
		.or(canonical)
}

/// Returns whether the most-specific applicable operator grant admits an
/// extension.
///
/// Workspace grants resolve from the requested workspace toward its ancestors.
/// An exact grant takes precedence over a subtree grant rooted at the same
/// workspace. Once a more-specific decision exists, a broader grant cannot
/// silently override changed publisher, capability, tier, or shipping facts.
#[tracing::instrument(
	name = "extension_grant_verify",
	level = "debug",
	skip_all,
	fields(extension_id = %id, layer = ?layer)
)]
pub fn grant_covers(
	grants: &GrantsFile,
	id: &Str,
	publisher: &Str,
	layer: Layer,
	workspace: Option<&WorkspaceUri>,
	capability_digest: &Str,
	tier: TrustTier,
	ship: &Str,
) -> bool {
	let Some(specificity) = grants
		.grants
		.iter()
		.filter(|grant| grant.id == *id && grant.layer == layer)
		.filter_map(|grant| grant_specificity(grant, workspace))
		.max()
	else {
		return false;
	};
	grants.grants.iter().any(|grant| {
		grant.id == *id
			&& grant.layer == layer
			&& grant_specificity(grant, workspace) == Some(specificity)
			&& grant.publisher == *publisher
			&& grant.capability_digest == *capability_digest
			&& grant.tier == tier
			&& grant.ship == *ship
	})
}

fn grant_specificity(grant: &Grant, workspace: Option<&WorkspaceUri>) -> Option<(usize, bool)> {
	match (grant.workspace.as_ref(), workspace, grant.scope) {
		(None, None, GrantScope::Exact) => Some((0, true)),
		(Some(granted), Some(requested), GrantScope::Exact) if granted == requested => {
			Some((granted.uri.len(), true))
		},
		(Some(granted), Some(requested), GrantScope::Subtree)
			if uri_contains(&granted.uri, &requested.uri) =>
		{
			Some((granted.uri.len(), false))
		},
		_ => None,
	}
}

fn uri_contains(parent: &str, child: &str) -> bool {
	parent == child
		|| child
			.strip_prefix(parent)
			.is_some_and(|suffix| parent.ends_with('/') || suffix.starts_with('/'))
}

/// A non-interactive grant request parsed from `OMP_EXT_GRANT`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrantRequest {
	/// Extension id named by the operator.
	pub id:           Str,
	/// Explicit capabilities, or `*` for all declared capabilities.
	pub capabilities: BTreeSet<Str>,
	/// Explicit tier approval when supplied.
	pub tier:         Option<TrustTier>,
}

/// Parses the operator-only `OMP_EXT_GRANT` channel.
///
/// Each semicolon-separated entry is `id:cap,cap`, `id:*`, or
/// `id:tier=trusted`; malformed entries fail closed rather than silently
/// dropping an intended capability grant.
pub fn parse_grant_requests(value: &str) -> Result<Vec<GrantRequest>, ExtensionError> {
	value
		.split(';')
		.filter(|entry| !entry.is_empty())
		.map(|entry| {
			let (id, grants) = entry.split_once(':').ok_or_else(|| {
				ExtensionError::new(ExtensionCode::EGrantUnknown, "grant entry must be id:capability")
			})?;
			if id.is_empty() || grants.is_empty() {
				return Err(ExtensionError::new(
					ExtensionCode::EGrantUnknown,
					"grant entry has an empty id or capability",
				));
			}
			let mut capabilities = BTreeSet::new();
			let mut tier = None;
			for grant in grants.split(',') {
				if let Some(value) = grant.strip_prefix("tier=") {
					tier = Some(value.parse().map_err(|_| {
						ExtensionError::new(ExtensionCode::EGrantUnknown, "unknown grant tier")
					})?);
				} else if !grant.is_empty() {
					capabilities.insert(Str::new(grant));
				}
			}
			Ok(GrantRequest { id: Str::new(id), capabilities, tier })
		})
		.collect()
}

/// Returns whether a parsed environment request approves the declared
/// capability set. Unknown requested capabilities are an error, preserving the
/// `E-GRANT-UNKNOWN` typo defense.
pub fn validate_grant_request(
	request: &GrantRequest,
	declared: impl IntoIterator<Item = Str>,
) -> Result<bool, ExtensionError> {
	let declared: BTreeSet<Str> = declared.into_iter().collect();
	if request.capabilities.contains(&sf!("*")) {
		return Ok(true);
	}
	if !request.capabilities.is_subset(&declared) {
		return Err(ExtensionError::new(
			ExtensionCode::EGrantUnknown,
			"grant names an undeclared capability",
		));
	}
	Ok(request.capabilities == declared)
}

impl GrantsFile {
	/// Reads an absent local grant file as an empty durable grant set.
	///
	/// Process-local entries are ignored even if a hand-edited file contains
	/// one, so a session decision cannot become durable by serialization.
	///
	/// # Errors
	///
	/// [`GrantsFileError`] when the file exists but cannot be read or decoded.
	pub fn read(path: &Path) -> Result<Self, GrantsFileError> {
		let text = match fs::read_to_string(path) {
			Ok(text) => text,
			Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
			Err(source) => return Err(GrantsFileError::Io { path: path.to_path_buf(), source }),
		};
		let mut grants: Self = toml::from_str(&text)
			.map_err(|source| GrantsFileError::Toml { path: path.to_path_buf(), source })?;
		grants
			.grants
			.retain(|grant| grant.duration == GrantDuration::Persistent);
		grants
			.workspace_trust
			.retain(|row| row.duration == GrantDuration::Persistent);
		Ok(grants)
	}

	/// Atomically writes only durable grants to the local grant file.
	///
	/// Unlocked: only a holder of the grant file lock calls it, through
	/// [`Self::update`] and the persisting writers built on it.
	pub(crate) fn write(&self, path: &Path) -> io::Result<()> {
		let durable = Self {
			version:         self.version,
			grants:          self
				.grants
				.iter()
				.filter(|grant| grant.duration == GrantDuration::Persistent)
				.cloned()
				.collect(),
			plugin_commands: self.plugin_commands.clone(),
			workspace_trust: self
				.workspace_trust
				.iter()
				.filter(|row| row.duration == GrantDuration::Persistent)
				.cloned()
				.collect(),
		};
		atomic_toml(path, &durable)
	}

	/// Locked read-modify-write of the grant file at `path`: takes the
	/// sibling `<name>.lock`, reads the durable state, applies `mutate`, and
	/// atomically writes the result before releasing the lock.
	///
	/// The only writer of the grant file: a concurrent writer's change is
	/// never lost to a stale read, so a revoked row cannot come back.
	///
	/// # Errors
	///
	/// [`GrantPersistenceError`] when the lock cannot be taken within its
	/// bounded wait, or the file cannot be read or written.
	pub fn update<T>(
		path: &Path,
		mutate: impl FnOnce(&mut Self) -> T,
	) -> Result<T, GrantPersistenceError> {
		match Self::locked(path, GRANTS_LOCK_WAIT, |grants| Ok::<_, Infallible>(mutate(grants)))? {
			Ok((_, value)) => Ok(value),
			Err(never) => match never {},
		}
	}

	/// [`Self::update`] whose `mutate` may refuse: an `Err` leaves the file
	/// untouched and is returned as the inner result.
	///
	/// # Errors
	///
	/// [`GrantPersistenceError`] as [`Self::update`].
	pub fn try_update<T, E>(
		path: &Path,
		mutate: impl FnOnce(&mut Self) -> Result<T, E>,
	) -> Result<Result<T, E>, GrantPersistenceError> {
		Ok(Self::locked(path, GRANTS_LOCK_WAIT, mutate)?.map(|(_, value)| value))
	}

	/// The locked read-modify-write behind every writer, waiting at most
	/// `wait` for the lock; yields the written state beside `mutate`'s value.
	fn locked<T, E>(
		path: &Path,
		wait: Duration,
		mutate: impl FnOnce(&mut Self) -> Result<T, E>,
	) -> Result<Result<(Self, T), E>, GrantPersistenceError> {
		let _lock = GrantsFileLock::acquire(path, wait)?;
		let mut grants = Self::read(path)?;
		let value = match mutate(&mut grants) {
			Ok(value) => value,
			Err(error) => return Ok(Err(error)),
		};
		grants.write(path).map_err(GrantPersistenceError::Write)?;
		Ok(Ok((grants, value)))
	}

	/// Every approved plugin launch, as the gate checks them.
	#[must_use]
	pub fn command_approvals(&self) -> CommandApprovals {
		CommandApprovals::new(
			self
				.plugin_commands
				.iter()
				.map(|grant| (grant.plugin.clone(), grant.digest)),
		)
	}

	/// Atomically records the operator's approval of one plugin launch,
	/// replacing an earlier approval of the same plugin and digest.
	///
	/// # Errors
	///
	/// [`GrantPersistenceError`] as [`Self::update`].
	pub fn persist_plugin_command(
		path: &Path,
		grant: PluginCommandGrant,
	) -> Result<Self, GrantPersistenceError> {
		Self::persisted(path, |grants| {
			grants
				.plugin_commands
				.retain(|existing| existing.plugin != grant.plugin || existing.digest != grant.digest);
			grants.plugin_commands.push(grant);
		})
	}

	/// [`Self::locked`] with an infallible `mutate`, yielding the written
	/// state.
	fn persisted(
		path: &Path,
		mutate: impl FnOnce(&mut Self),
	) -> Result<Self, GrantPersistenceError> {
		let mutate = |grants: &mut Self| {
			mutate(grants);
			Ok::<_, Infallible>(())
		};
		match Self::locked(path, GRANTS_LOCK_WAIT, mutate)? {
			Ok((grants, ())) => Ok(grants),
			Err(never) => match never {},
		}
	}

	/// Atomically records the operator's trust in one workspace, an
	/// [`TrustBinding::Exact`] or [`TrustBinding::Pin`] row answering
	/// `answered`, and returns the written state. The row replaces the
	/// workspace's decision ([`WorkspaceTrustGrant::same_slot`]).
	///
	/// `answered` is what [`evaluate`](crate::workspace_trust::evaluate)
	/// returned over the durable rows when the operator was asked. Under the
	/// lock the rows are evaluated again, and the answer is refused unless the
	/// decision is still `answered` ([`WorkspaceTrustRefusal::Stale`]): a
	/// revoke or subtree change made after the ask is never undone by it. A
	/// pin is also refused unless the subtree row at exactly `under` is live
	/// and covers the workspace ([`WorkspaceTrustRefusal::NoLiveSubtree`]), and
	/// never replaces a deny ([`WorkspaceTrustRefusal::Denied`]).
	///
	/// # Errors
	///
	/// [`GrantPersistenceError::SessionOnly`] for a row that is not
	/// persistent; otherwise as [`Self::update`]. A refusal leaves the file
	/// untouched and is the inner `Err`.
	pub fn persist_workspace_trust(
		path: &Path,
		grant: WorkspaceTrustGrant,
		answered: &TrustDecision,
		home: &CanonicalHome,
	) -> Result<Result<Self, WorkspaceTrustRefusal>, GrantPersistenceError> {
		if grant.duration != GrantDuration::Persistent {
			return Err(GrantPersistenceError::SessionOnly);
		}
		if !matches!(grant.binding, TrustBinding::Exact { .. } | TrustBinding::Pin { .. }) {
			return Ok(Err(WorkspaceTrustRefusal::Scope { scope: grant.binding.scope() }));
		}
		let written = Self::locked(path, GRANTS_LOCK_WAIT, |grants| {
			grant.check_answer(&grants.workspace_trust, answered, home)?;
			grants
				.workspace_trust
				.retain(|existing| !existing.same_slot(&grant));
			grants.workspace_trust.push(grant);
			Ok(())
		})?;
		Ok(written.map(|(grants, ())| grants))
	}

	/// Atomically records an explicit operator grant over the subtree rooted
	/// at `grant`'s workspace, replacing the subtree row at that root, and
	/// returns the written state.
	///
	/// A subtree granted anew, with no row at its root yet, drops every pin
	/// naming that root: such pins outlived an earlier grant, and the new one
	/// asks once per workspace ([`TrustDecision::PinUnderSubtree`]) instead of
	/// reviving them.
	///
	/// # Errors
	///
	/// [`GrantPersistenceError::SessionOnly`] for a row that is not
	/// persistent; otherwise as [`Self::update`]. A row that is not a
	/// [`TrustBinding::Subtree`] is refused
	/// ([`WorkspaceTrustRefusal::Scope`]) without touching the file.
	pub fn persist_workspace_subtree(
		path: &Path,
		grant: WorkspaceTrustGrant,
	) -> Result<Result<Self, WorkspaceTrustRefusal>, GrantPersistenceError> {
		if grant.duration != GrantDuration::Persistent {
			return Err(GrantPersistenceError::SessionOnly);
		}
		if grant.binding != TrustBinding::Subtree {
			return Ok(Err(WorkspaceTrustRefusal::Scope { scope: grant.binding.scope() }));
		}
		Self::persisted(path, |grants| {
			let rows = &mut grants.workspace_trust;
			let anew = !rows.iter().any(|existing| existing.same_slot(&grant));
			rows.retain(|existing| match &existing.binding {
				TrustBinding::Pin { under, .. } => !anew || *under != grant.workspace,
				TrustBinding::Exact { .. } | TrustBinding::Subtree | TrustBinding::Deny => {
					!existing.same_slot(&grant)
				},
			});
			rows.push(grant);
		})
		.map(Ok)
	}

	/// Atomically records the operator's revocation of `grant`'s workspace, a
	/// [`TrustBinding::Deny`] row replacing the workspace's decision, and
	/// returns the written state. The deny outranks every covering subtree
	/// ([`TrustDecision::Denied`]) until an exact grant answering it replaces
	/// it.
	///
	/// # Errors
	///
	/// [`GrantPersistenceError::SessionOnly`] for a row that is not
	/// persistent; otherwise as [`Self::update`]. A row that is not a
	/// [`TrustBinding::Deny`] is refused ([`WorkspaceTrustRefusal::Scope`])
	/// without touching the file.
	pub fn persist_workspace_deny(
		path: &Path,
		grant: WorkspaceTrustGrant,
	) -> Result<Result<Self, WorkspaceTrustRefusal>, GrantPersistenceError> {
		if grant.duration != GrantDuration::Persistent {
			return Err(GrantPersistenceError::SessionOnly);
		}
		if grant.binding != TrustBinding::Deny {
			return Ok(Err(WorkspaceTrustRefusal::Scope { scope: grant.binding.scope() }));
		}
		Self::persisted(path, |grants| {
			grants
				.workspace_trust
				.retain(|existing| !existing.same_slot(&grant));
			grants.workspace_trust.push(grant);
		})
		.map(Ok)
	}

	/// Atomically revokes the operator's trust in `workspace` and returns how
	/// many trusting rows were removed.
	///
	/// Rows hold canonical paths, so `workspace` is revoked under the first of
	/// its canonical path and the path as given that names a row: a workspace
	/// deleted since is still revoked by the spelling it was recorded under.
	/// When neither names a row, an existing workspace is revoked under its
	/// canonical path; a missing one revokes and records nothing, since no
	/// spelling of it is known to be the one rows are keyed by.
	///
	/// - [`GrantScope::Exact`] removes the workspace's exact or pinned row. When
	///   a subtree row covers the workspace, a [`TrustBinding::Deny`] row
	///   recorded through `revoked_by` takes its place, so the subtree neither
	///   trusts nor asks about it again ([`TrustDecision::Denied`]).
	/// - [`GrantScope::Subtree`] removes the subtree row rooted at `workspace`
	///   and every pin it admitted.
	///
	/// A revoke is unconditional, and an answer recorded after it through
	/// [`Self::persist_workspace_trust`] to an ask made before it is refused
	/// as stale.
	///
	/// # Errors
	///
	/// [`GrantPersistenceError`] as [`Self::update`].
	pub fn revoke_workspace_trust(
		path: &Path,
		workspace: &Path,
		scope: GrantScope,
		revoked_by: TrustChannel,
	) -> Result<usize, GrantPersistenceError> {
		let canonical = fs::canonicalize(workspace).ok();
		Self::update(path, |grants| {
			let Some(workspace) =
				revoked_spelling(&grants.workspace_trust, canonical.as_deref(), workspace)
			else {
				return 0;
			};
			let before = grants.workspace_trust.len();
			match scope {
				GrantScope::Exact => {
					grants.workspace_trust.retain(|row| {
						row.workspace != workspace
							|| !matches!(
								row.binding,
								TrustBinding::Exact { .. } | TrustBinding::Pin { .. }
							)
					});
					let removed = before - grants.workspace_trust.len();
					let covered = grants.workspace_trust.iter().any(|row| {
						row.binding.slot() == TrustSlot::Subtree && workspace.starts_with(&row.workspace)
					});
					let denied = grants
						.workspace_trust
						.iter()
						.any(|row| row.workspace == workspace && row.binding == TrustBinding::Deny);
					if covered && !denied {
						grants.workspace_trust.push(WorkspaceTrustGrant::stamped(
							workspace.to_path_buf(),
							TrustBinding::Deny,
							revoked_by,
							GrantDuration::Persistent,
						));
					}
					removed
				},
				GrantScope::Subtree => {
					grants.workspace_trust.retain(|row| match &row.binding {
						TrustBinding::Subtree => row.workspace != workspace,
						TrustBinding::Pin { under, .. } => under != workspace,
						TrustBinding::Exact { .. } | TrustBinding::Deny => true,
					});
					before - grants.workspace_trust.len()
				},
			}
		})
	}

	/// Drops every approved launch of `plugin`, or only the one with
	/// `digest`; returns how many approvals were removed. The caller commits
	/// the change inside [`Self::update`].
	pub fn revoke_plugin_commands(
		&mut self,
		plugin: &PluginId<str>,
		digest: Option<&Hash32>,
	) -> usize {
		let before = self.plugin_commands.len();
		self.plugin_commands.retain(|grant| {
			grant.plugin != *plugin || digest.is_some_and(|digest| grant.digest != *digest)
		});
		before - self.plugin_commands.len()
	}

	/// Replaces the prior decision for one extension and atomically persists the
	/// operator's new durable grant.
	///
	/// This is the sole read-modify-write entry point for interactive consent;
	/// callers cannot accidentally update an in-memory copy without committing
	/// it through the trust domain's locked atomic writer.
	///
	/// # Errors
	///
	/// [`GrantPersistenceError::SessionOnly`] for a grant that is not
	/// persistent; otherwise as [`Self::update`].
	pub fn persist(path: &Path, grant: Grant) -> Result<Self, GrantPersistenceError> {
		if grant.duration != GrantDuration::Persistent {
			return Err(GrantPersistenceError::SessionOnly);
		}
		Self::persisted(path, |grants| {
			grants.grants.retain(|existing| {
				existing.id != grant.id
					|| existing.layer != grant.layer
					|| existing.workspace != grant.workspace
			});
			grants.grants.push(grant);
		})
	}
}

/// A TOFU-pinned publisher key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct KeyPin {
	/// Extension identity protected by this pin.
	pub id:                 Str,
	/// Base64 Ed25519 public key.
	pub key:                Str,
	/// Exact version first seen under this key.
	pub introduced_version: Str,
	/// RFC 3339 pin timestamp.
	pub introduced_at:      Str,
}

/// Local TOFU key pins.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct KeysFile {
	/// File format version.
	#[serde(default = "one")]
	pub version: u32,
	/// One pin per extension identity.
	#[serde(rename = "key", default)]
	pub keys:    Vec<KeyPin>,
}

/// A publisher rotation signed by the currently pinned key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct KeyRotation {
	/// Extension identity whose key rotates.
	pub id:        Str,
	/// New base64 Ed25519 public key.
	pub new_key:   Str,
	/// Detached base64 signature from the old key over `id\nnew_key`.
	pub signature: Str,
}

impl KeysFile {
	/// Reads an absent key file as an empty pin set.
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		read_toml_or_default(path)
	}

	/// Atomically writes local key pins.
	pub fn write(&self, path: &Path) -> io::Result<()> {
		atomic_toml(path, self)
	}

	/// Records an operator-confirmed publisher key after validating its Ed25519
	/// shape. This is the only intentional bypass of TOFU continuity and is
	/// reserved for `omp ext trust --key`; ordinary installs must use
	/// [`Self::verify_or_pin`].
	pub fn accept_operator_key(
		&mut self,
		id: &Str,
		key: &Str,
		version: &Str,
		now: &Str,
	) -> Result<bool, ExtensionError> {
		validate_public_key(key.as_str())?;
		let replacement = KeyPin {
			id:                 id.clone(),
			key:                key.clone(),
			introduced_version: version.clone(),
			introduced_at:      now.clone(),
		};
		if let Some(pin) = self.keys.iter_mut().find(|pin| pin.id == *id) {
			let changed = pin != &replacement;
			*pin = replacement;
			Ok(changed)
		} else {
			self.keys.push(replacement);
			Ok(true)
		}
	}

	/// Pins a first-seen key, rejects a changed key, or accepts a rotation only
	/// when its signature verifies against the old pin.
	#[tracing::instrument(
		name = "extension_publisher_trust",
		level = "debug",
		skip_all,
		fields(extension_id = %id, rotation_provided = rotation.is_some())
	)]
	pub fn verify_or_pin(
		&mut self,
		id: &Str,
		key: &Str,
		version: &Str,
		now: &Str,
		rotation: Option<&KeyRotation>,
	) -> Result<Option<ExtensionCode>, ExtensionError> {
		let Some(pin) = self.keys.iter_mut().find(|pin| pin.id == *id) else {
			self.keys.push(KeyPin {
				id:                 id.clone(),
				key:                key.clone(),
				introduced_version: version.clone(),
				introduced_at:      now.clone(),
			});
			tracing::debug!("publisher key pinned");
			return Ok(None);
		};
		if pin.key == *key {
			tracing::debug!("publisher key matched existing pin");
			return Ok(None);
		}
		let Some(rotation) =
			rotation.filter(|rotation| rotation.id == *id && rotation.new_key == *key)
		else {
			return Err(ExtensionError::new(
				ExtensionCode::EKeyChanged,
				"publisher key changed without a signed rotation",
			));
		};
		verify_publisher_rotation(pin.key.as_str(), id, key.as_str(), rotation)?;
		pin.key.clone_from(key);
		tracing::info!("publisher key rotation verified");
		Ok(Some(ExtensionCode::WKeyRotated))
	}
}

/// Verifies publisher-key continuity against the exact previously pinned key.
#[tracing::instrument(
	name = "extension_publisher_rotation_verify",
	level = "debug",
	skip_all,
	fields(extension_id = %id)
)]
pub fn verify_publisher_rotation(
	current_key: &str,
	id: &Str,
	new_key: &str,
	rotation: &KeyRotation,
) -> Result<(), ExtensionError> {
	(|| {
		if rotation.id != *id || rotation.new_key != new_key {
			return Err(ExtensionError::new(
				ExtensionCode::EKeyChanged,
				"publisher key changed without a matching signed rotation",
			));
		}
		verify_signature(
			current_key,
			format!("{}\n{}", rotation.id, rotation.new_key).as_bytes(),
			rotation.signature.as_str(),
		)
	})()
}
/// A revoked extension version predicate. Version matching is deliberately
/// delegated to the resolver; materialization compares exact lock versions.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct RevokedVersion {
	/// Extension id.
	pub id:       Str,
	/// Revoked PEP 440 version expression.
	pub versions: Str,
	/// Security rationale.
	pub reason:   Str,
	/// Advisory URL.
	pub advisory: String,
}

/// Signed revocation snapshot.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct RevocationsFile {
	/// File format version.
	pub version:     u32,
	/// RFC 3339 issuance timestamp.
	pub issued_at:   Str,
	/// RFC 3339 expiry timestamp.
	pub valid_until: Str,
	/// Revoked extension versions.
	pub revoked:     Vec<RevokedVersion>,
	/// Index signature over the canonical unsigned JSON payload.
	pub signature:   Str,
}

/// Staleness decision for a locally cached revocation snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RevocationFreshness {
	/// Snapshot is still current.
	Fresh,
	/// Snapshot is stale but ordinary offline mode proceeds with warning.
	Warn(ExtensionCode),
	/// Strict offline mode refuses stale state.
	Reject(ExtensionCode),
}

impl RevocationsFile {
	/// Reads a signed JSON revocation snapshot.
	#[tracing::instrument(
		name = "extension_revocations_load",
		level = "debug",
		skip_all,
		fields(path = %path.display())
	)]
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		let result = fs::read(path)
			.map_err(|error| ExtensionError::caused(ExtensionCode::ERevoked, error))
			.and_then(|data| {
				serde_json::from_slice::<Self>(&data)
					.map_err(|error| ExtensionError::caused(ExtensionCode::ERevoked, error))
			});
		if let Ok(revocations) = &result {
			tracing::debug!(
				cache_hit = true,
				revocation_count = revocations.revoked.len(),
				"extension revocation cache loaded"
			);
		}
		result
	}

	/// Verifies the index signature over the canonical unsigned snapshot.
	#[tracing::instrument(
		name = "extension_revocations_verify",
		level = "debug",
		skip_all,
		fields(revocation_count = self.revoked.len())
	)]
	pub fn verify(&self, index_key: &str) -> Result<(), ExtensionError> {
		#[derive(Serialize)]
		struct Unsigned<'a> {
			version:     u32,
			issued_at:   &'a Str,
			valid_until: &'a Str,
			revoked:     &'a [RevokedVersion],
		}

		serde_json::to_vec(&Unsigned {
			version:     self.version,
			issued_at:   &self.issued_at,
			valid_until: &self.valid_until,
			revoked:     &self.revoked,
		})
		.map_err(|error| ExtensionError::caused(ExtensionCode::ESig, error))
		.and_then(|payload| verify_signature(index_key, &payload, self.signature.as_str()))
	}

	/// Returns the matching revocation predicate for an exact locked version.
	pub fn revocation_for(
		&self,
		id: &Str,
		version: &Str,
	) -> Result<Option<&RevokedVersion>, ExtensionError> {
		for entry in self.revoked.iter().filter(|entry| entry.id == *id) {
			if version_satisfies(version.as_str(), entry.versions.as_str())? {
				return Ok(Some(entry));
			}
		}
		Ok(None)
	}

	/// Atomically writes a revocation snapshot.
	pub fn write(&self, path: &Path) -> io::Result<()> {
		let parent = path.parent().unwrap_or_else(|| Path::new("."));
		fs::create_dir_all(parent)?;
		let temporary = path.with_extension("json.tmp");

		fs::write(&temporary, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
		fs::rename(temporary, path)
	}

	/// Returns the documented stale-list decision after parsing RFC 3339
	/// instants, including non-UTC offsets.
	pub fn freshness(&self, now: &str, strict_offline: bool) -> RevocationFreshness {
		let issued_at = Timestamp::from_str(self.issued_at.as_str());
		let valid_until = Timestamp::from_str(self.valid_until.as_str());
		let now = Timestamp::from_str(now);
		let freshness = if issued_at.is_ok_and(|issued_at| {
			valid_until.is_ok_and(|valid_until| {
				now.is_ok_and(|now| issued_at <= now && valid_until >= now && issued_at < valid_until)
			})
		}) {
			RevocationFreshness::Fresh
		} else if strict_offline {
			RevocationFreshness::Reject(ExtensionCode::ERevoked)
		} else {
			RevocationFreshness::Warn(ExtensionCode::WRevocationStale)
		};
		match freshness {
			RevocationFreshness::Fresh => {
				tracing::debug!(strict_offline, "extension revocation cache is fresh");
			},
			RevocationFreshness::Warn(code) => {
				tracing::warn!(?code, strict_offline, "extension revocation cache is stale");
			},
			RevocationFreshness::Reject(code) => {
				tracing::warn!(?code, strict_offline, "extension revocation cache rejected");
			},
		}
		freshness
	}
}

/// Produces the consent digest from normalized capabilities and hard-tool
/// claims. Sorting makes semantically equal manifests produce one grant key.
pub fn capability_digest(
	capabilities: impl IntoIterator<Item = Str>,
	hard_tools: impl IntoIterator<Item = Str>,
) -> Str {
	let mut entries: BTreeSet<Str> = capabilities.into_iter().collect();
	entries.extend(hard_tools.into_iter().map(|tool| sf!("tools.hard:{tool}")));
	let mut hasher = Hash32::hasher();
	for entry in entries {
		hasher.update(entry.as_str().as_bytes());
		hasher.update(b"\n");
	}
	sf!("b3:{}", hasher.finalize().to_hex())
}

/// Identity of an operator path grant for one exact manifest.
///
/// Covers the full declared capability set. Each entry is length-prefixed so
/// no name can stand in for two entries; the signed-install
/// `capability_digest` is unchanged.
pub fn path_grant_digest(
	capabilities: impl IntoIterator<Item = Str>,
	manifest_digest: &[u8; 32],
) -> Str {
	let entries: BTreeSet<Str> = capabilities.into_iter().collect();
	let mut hasher = blake3::Hasher::new();
	hasher.update(b"omp.path-grant.v1");
	for entry in &entries {
		hasher.update(&(entry.as_str().len() as u64).to_le_bytes());
		hasher.update(entry.as_str().as_bytes());
	}
	hasher.update(manifest_digest);
	sf!("b3:{}", hasher.finalize().to_hex())
}

/// Publisher recorded for an unsigned path-loaded native extension. The root
/// must already be canonical so admission and `omp ext grant` agree.
pub fn native_path_publisher(canonical_root: &Path) -> Str {
	sf!("unsigned:path:{}", Hash32::sum(canonical_root.to_string_lossy().as_bytes()).to_hex())
}

/// Verifies an Ed25519 signature over `blake3 || sha256 || capability_digest`.
#[tracing::instrument(name = "extension_artifact_signature_verify", level = "debug", skip_all)]
pub fn verify_artifact_signature(
	key: &str,
	blake3_digest: &str,
	sha256_digest: &str,
	capability_digest: &str,
	signature: &str,
) -> Result<(), ExtensionError> {
	(|| {
		let decode_digest = |digest: &str, prefix: &str| {
			hex::decode(digest.strip_prefix(prefix).unwrap_or(digest).as_bytes())
				.into_vec()
				.map_err(|_| {
					ExtensionError::new(ExtensionCode::ESig, format!("invalid {prefix} digest"))
				})
		};
		let blake3 = decode_digest(blake3_digest, "b3:")?;
		let sha256 = decode_digest(sha256_digest, "sha256:")?;
		let capability = decode_digest(capability_digest, "b3:")?;
		let mut message = Vec::with_capacity(blake3.len() + sha256.len() + capability.len());
		message.extend_from_slice(&blake3);
		message.extend_from_slice(&sha256);
		message.extend_from_slice(&capability);
		verify_signature(key, &message, signature)
	})()
}

/// Verifies a detached Ed25519 signature over canonical authority-owned bytes.
pub fn verify_signed_payload(
	key: &str,
	message: &[u8],
	signature: &str,
) -> Result<(), ExtensionError> {
	verify_signature(key, message, signature)
}

fn validate_public_key(key: &str) -> Result<(), ExtensionError> {
	let key = key.strip_prefix("ed25519:").unwrap_or(key);
	let key = base64::decode(key.as_bytes())
		.into_vec()
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "publisher key is not base64"))?;
	if key.len() != 32 {
		return Err(ExtensionError::new(ExtensionCode::ESig, "publisher key is not 32 bytes"));
	}
	Ok(())
}

fn verify_signature(key: &str, message: &[u8], signature: &str) -> Result<(), ExtensionError> {
	let key = key.strip_prefix("ed25519:").unwrap_or(key);
	let signature = signature.strip_prefix("ed25519:sig:").unwrap_or(signature);
	let key = base64::decode(key.as_bytes())
		.into_vec()
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "publisher key is not base64"))?;
	let signature = base64::decode(signature.as_bytes())
		.into_vec()
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "signature is not base64"))?;
	if key.len() != 32 {
		return Err(ExtensionError::new(ExtensionCode::ESig, "publisher key is not 32 bytes"));
	}
	if signature.len() != 64 {
		return Err(ExtensionError::new(ExtensionCode::ESig, "invalid Ed25519 signature"));
	}
	UnparsedPublicKey::new(&ED25519, &key)
		.verify(message, &signature)
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "signature verification failed"))
}

const fn one() -> u32 {
	1
}

fn read_toml_or_default<T: for<'de> Deserialize<'de> + Default>(
	path: &Path,
) -> Result<T, ExtensionError> {
	if !path.exists() {
		return Ok(T::default());
	}
	let text = fs::read_to_string(path)
		.map_err(|error| ExtensionError::caused(ExtensionCode::EIntegrity, error))?;
	toml::from_str(&text).map_err(|error| ExtensionError::caused(ExtensionCode::EIntegrity, error))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::workspace_trust::{InputsDigest, TrustScope, WorkspaceTrust, evaluate};

	#[test]
	fn path_grant_digest_separates_entries() {
		let manifest = [7_u8; 32];
		assert_ne!(
			path_grant_digest([sf!("a"), sf!("b\nc")], &manifest),
			path_grant_digest([sf!("a"), sf!("b"), sf!("c")], &manifest)
		);
		assert_ne!(
			path_grant_digest([sf!("ab"), sf!("c")], &manifest),
			path_grant_digest([sf!("a"), sf!("bc")], &manifest)
		);
		// Pinned: blake3 over "omp.path-grant.v1", then 1u64 LE "a", 2u64 LE "bc",
		// then the 32 manifest bytes. A change to the algorithm must fail here.
		assert_eq!(
			path_grant_digest([sf!("bc"), sf!("a")], &manifest).as_str(),
			"b3:fa6b07326ab655f64fa4990b6a8e3b8624871256d314b641842a1eb5d5f1ecf2"
		);
	}

	#[test]
	fn path_grant_digest_binds_manifest() {
		let capabilities = || [sf!("agents.continuation"), sf!("policy.write")];
		let first = path_grant_digest(capabilities(), &[1_u8; 32]);
		assert_eq!(first, path_grant_digest(capabilities(), &[1_u8; 32]));
		assert_ne!(first, path_grant_digest(capabilities(), &[2_u8; 32]));
		let mut edited = [1_u8; 32];
		edited[31] = 0;
		assert_ne!(first, path_grant_digest(capabilities(), &edited));
	}

	#[test]
	fn path_grant_digest_ignores_order_and_duplicates() {
		let manifest = [9_u8; 32];
		let canonical = path_grant_digest([sf!("approvals.decide"), sf!("policy.write")], &manifest);
		assert_eq!(
			canonical,
			path_grant_digest(
				[sf!("policy.write"), sf!("approvals.decide"), sf!("policy.write")],
				&manifest
			)
		);
		assert_ne!(canonical, path_grant_digest([sf!("policy.write")], &manifest));
		assert_ne!(canonical, capability_digest([sf!("approvals.decide"), sf!("policy.write")], []));
	}

	#[test]
	fn native_path_publisher_matches_admission_format() {
		let root = Path::new("/srv/ext/demo");
		assert_eq!(
			native_path_publisher(root).as_str(),
			"unsigned:path:ed29064cbb8fcc615896f41000cf9f5c0af0324a0dc388f6b5c3637a84d04faf"
		);
		assert_eq!(
			native_path_publisher(root).as_str(),
			format!("unsigned:path:{}", Hash32::sum(root.to_string_lossy().as_bytes()).to_hex())
		);
	}

	#[test]
	fn stale_revocation_fails_open_unless_strict() {
		let list = RevocationsFile {
			version:     1,
			issued_at:   sf!("2026-01-01T00:00:00Z"),
			valid_until: sf!("2026-01-02T00:00:00Z"),
			revoked:     vec![],
			signature:   sf!("ed25519:sig:"),
		};
		assert_eq!(
			list.freshness("2026-01-03T00:00:00Z", false),
			RevocationFreshness::Warn(ExtensionCode::WRevocationStale)
		);
		assert_eq!(
			list.freshness("2026-01-03T00:00:00Z", true),
			RevocationFreshness::Reject(ExtensionCode::ERevoked)
		);
	}

	#[test]
	fn operator_key_acceptance_replaces_tofu_pin_but_rejects_malformed_keys() {
		let id = sf!("acme.reviewer");
		let first = Str::new(base64::encode(&[1_u8; 32]).into_string());
		let second = Str::new(base64::encode(&[2_u8; 32]).into_string());
		let mut keys = KeysFile::default();
		assert!(
			keys
				.accept_operator_key(&id, &first, &sf!("1.0.0"), &sf!("first"))
				.expect("first key")
		);
		assert!(
			keys
				.accept_operator_key(&id, &second, &sf!("2.0.0"), &sf!("second"))
				.expect("replacement key")
		);
		assert_eq!(keys.keys.len(), 1);
		assert_eq!(keys.keys[0].key, second);
		assert_eq!(
			keys
				.accept_operator_key(&id, &sf!("invalid"), &sf!("3.0.0"), &sf!("third"))
				.unwrap_err()
				.code,
			ExtensionCode::ESig
		);
	}

	#[test]
	fn widened_capabilities_require_a_new_grant() {
		let id = sf!("acme.reviewer");
		let publisher = sf!("ed25519:key");
		let old = capability_digest([sf!("net")], []);
		let widened = capability_digest([sf!("net"), sf!("exec")], []);
		let grants = GrantsFile {
			version: 1,
			grants: vec![Grant {
				id:                id.clone(),
				publisher:         publisher.clone(),
				layer:             Layer::Client,
				workspace:         None,
				scope:             GrantScope::Exact,
				capability_digest: old,
				tier:              TrustTier::Sandboxed,
				ship:              sf!("installed"),
				granted_at:        sf!("now"),
				granted_by:        sf!("interactive"),
				duration:          GrantDuration::Persistent,
			}],
			..GrantsFile::default()
		};
		assert!(!grant_covers(
			&grants,
			&id,
			&publisher,
			Layer::Client,
			None,
			&widened,
			TrustTier::Sandboxed,
			&sf!("installed"),
		));
		assert!(!grant_covers(
			&grants,
			&id,
			&publisher,
			Layer::Client,
			None,
			&grants.grants[0].capability_digest,
			TrustTier::Trusted,
			&sf!("installed"),
		));
		assert!(!grant_covers(
			&grants,
			&id,
			&publisher,
			Layer::Client,
			None,
			&grants.grants[0].capability_digest,
			TrustTier::Sandboxed,
			&sf!("pickle"),
		));
	}
	#[test]
	fn interactive_persist_round_trips_through_the_canonical_writer() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = directory.path().join("grants.toml");
		let grant = Grant {
			id:                sf!("acme.reviewer"),
			publisher:         sf!("ed25519:publisher"),
			layer:             Layer::Client,
			workspace:         None,
			scope:             GrantScope::Exact,
			capability_digest: sf!("b3:capabilities"),
			tier:              TrustTier::Sandboxed,
			ship:              sf!("installed"),
			granted_at:        sf!("2026-08-27T00:00:00Z"),
			granted_by:        sf!("interactive"),
			duration:          GrantDuration::Persistent,
		};
		let persisted = GrantsFile::persist(&path, grant.clone()).expect("persist grant");
		assert_eq!(persisted.grants, [grant.clone()]);
		assert_eq!(GrantsFile::read(&path).expect("read grant").grants, [grant]);
	}

	fn plugin_command_grant(plugin: &'static str, args: &[&'static str]) -> PluginCommandGrant {
		use crate::plugin_command::{PluginLaunch, plugin_command_digest};

		let launch = PluginLaunch::new(
			PluginLaunchKind::LanguageServer,
			sf!("srv"),
			sf!("/plugins/p/bin/srv"),
			args.iter().map(|arg| Str::new_static(arg)),
			[],
		);
		PluginCommandGrant {
			plugin:     PluginId::new_static(plugin),
			version:    sf!("1.0.0"),
			kind:       launch.kind,
			server:     launch.server.clone(),
			command:    launch.command.clone(),
			args:       launch.args.to_vec(),
			digest:     plugin_command_digest(PluginId::from_ref(plugin), "1.0.0", &launch),
			granted_at: sf!("2026-09-27T00:00:00Z"),
			granted_by: sf!("cli"),
		}
	}

	#[test]
	fn plugin_command_approvals_round_trip_beside_extension_grants() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = grants_path(directory.path());
		assert_eq!(path, directory.path().join("ext/grants.toml"));
		let extension = workspace_grant(workspace("file:///w"), GrantScope::Exact, "b3:c");
		GrantsFile::persist(&path, extension.clone()).expect("persist extension grant");
		let stdio = plugin_command_grant("p@m", &["--stdio"]);
		let tcp = plugin_command_grant("p@m", &["--tcp"]);
		let other = plugin_command_grant("q@m", &["--stdio"]);
		for grant in [&stdio, &tcp, &other, &stdio] {
			GrantsFile::persist_plugin_command(&path, grant.clone()).expect("persist approval");
		}
		let read = GrantsFile::read(&path).expect("read grants");
		assert_eq!(read.grants, std::slice::from_ref(&extension), "extension grants survive");
		assert_eq!(
			read.plugin_commands,
			[tcp.clone(), other.clone(), stdio.clone()],
			"re-approving replaces rather than duplicates"
		);
		assert_eq!(
			read
				.command_approvals()
				.of(PluginId::from_ref("p@m"))
				.collect::<Vec<_>>(),
			[tcp.digest, stdio.digest]
		);
		// An extension grant persisted afterwards keeps the approvals.
		GrantsFile::persist(&path, extension).expect("re-persist extension grant");
		assert_eq!(
			GrantsFile::read(&path)
				.expect("read grants")
				.plugin_commands
				.len(),
			3
		);
		let removed = GrantsFile::update(&path, |grants| {
			[
				grants.revoke_plugin_commands(PluginId::from_ref("p@m"), Some(&tcp.digest)),
				grants.revoke_plugin_commands(PluginId::from_ref("p@m"), None),
			]
		})
		.expect("revoke approvals");
		assert_eq!(removed, [1, 1]);
		assert_eq!(
			GrantsFile::read(&path)
				.expect("read grants")
				.plugin_commands,
			[other]
		);
	}

	fn workspace(uri: &'static str) -> WorkspaceUri {
		WorkspaceUri { uri: Str::new_static(uri), digest: sf!("digest:{uri}") }
	}

	fn workspace_grant(workspace: WorkspaceUri, scope: GrantScope, digest: &'static str) -> Grant {
		Grant {
			id: sf!("acme.reviewer"),
			publisher: sf!("ed25519:publisher"),
			layer: Layer::Workspace,
			workspace: Some(workspace),
			scope,
			capability_digest: Str::new_static(digest),
			tier: TrustTier::Sandboxed,
			ship: sf!("installed"),
			granted_at: sf!("2026-08-28T00:00:00Z"),
			granted_by: sf!("interactive"),
			duration: GrantDuration::Persistent,
		}
	}

	#[test]
	fn subtree_grant_covers_a_child_workspace() {
		let child = workspace("file:///work/team/project/");
		let grant =
			workspace_grant(workspace("file:///work/team/"), GrantScope::Subtree, "b3:capabilities");
		let grants = GrantsFile { version: 1, grants: vec![grant.clone()], ..GrantsFile::default() };
		assert!(grant_covers(
			&grants,
			&grant.id,
			&grant.publisher,
			Layer::Workspace,
			Some(&child),
			&grant.capability_digest,
			grant.tier,
			&grant.ship,
		));
	}

	#[test]
	fn most_specific_workspace_grant_wins() {
		let child = workspace("file:///work/team/project/");
		let parent =
			workspace_grant(workspace("file:///work/team/"), GrantScope::Subtree, "b3:parent");
		let exact = workspace_grant(child.clone(), GrantScope::Exact, "b3:child");
		let grants = GrantsFile {
			version: 1,
			grants: vec![parent.clone(), exact.clone()],
			..GrantsFile::default()
		};
		assert!(!grant_covers(
			&grants,
			&parent.id,
			&parent.publisher,
			Layer::Workspace,
			Some(&child),
			&parent.capability_digest,
			parent.tier,
			&parent.ship,
		));
		assert!(grant_covers(
			&grants,
			&exact.id,
			&exact.publisher,
			Layer::Workspace,
			Some(&child),
			&exact.capability_digest,
			exact.tier,
			&exact.ship,
		));
	}

	#[test]
	fn session_only_grants_never_persist() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = directory.path().join("grants.toml");
		let grant = Grant {
			duration: GrantDuration::Session,
			..workspace_grant(
				workspace("file:///work/team/project/"),
				GrantScope::Exact,
				"b3:capabilities",
			)
		};
		GrantsFile { version: 1, grants: vec![grant.clone()], ..GrantsFile::default() }
			.write(&path)
			.expect("write durable subset");
		assert!(
			GrantsFile::read(&path)
				.expect("read grants")
				.grants
				.is_empty()
		);
		assert!(matches!(GrantsFile::persist(&path, grant), Err(GrantPersistenceError::SessionOnly)));
		assert!(
			GrantsFile::read(&path)
				.expect("read grants")
				.grants
				.is_empty()
		);
	}

	fn trust_row(workspace: &Path, binding: TrustBinding) -> WorkspaceTrustGrant {
		WorkspaceTrustGrant {
			workspace: workspace.to_path_buf(),
			binding,
			granted_at: sf!("2026-10-07T00:00:00Z"),
			granted_by: TrustChannel::Cli,
			duration: GrantDuration::Persistent,
		}
	}

	fn inputs(seed: &str) -> InputsDigest {
		InputsDigest::new(Hash32::sum(seed))
	}

	fn exact_trust(workspace: &Path, seed: &str) -> WorkspaceTrustGrant {
		trust_row(workspace, TrustBinding::Exact { inputs_digest: inputs(seed) })
	}

	#[test]
	fn grant_file_written_by_write_round_trips_byte_identically() {
		let directory = tempfile::tempdir().expect("grant directory");
		let first = directory.path().join("first.toml");
		let second = directory.path().join("second.toml");
		let team = Path::new("/work/team");
		let repo = Path::new("/work/team/repo");
		let grants = GrantsFile {
			version:         1,
			grants:          vec![workspace_grant(
				workspace("file:///work/"),
				GrantScope::Subtree,
				"b3:capabilities",
			)],
			plugin_commands: vec![plugin_command_grant("p@m", &["--stdio"])],
			workspace_trust: vec![
				exact_trust(Path::new("/work/solo"), "solo"),
				trust_row(team, TrustBinding::Subtree),
				trust_row(repo, TrustBinding::Pin {
					under:         team.to_path_buf(),
					inputs_digest: inputs("repo"),
				}),
				trust_row(Path::new("/work/team/hostile"), TrustBinding::Deny),
			],
		};
		grants.write(&first).expect("write grants");
		let text = fs::read_to_string(&first).expect("written grants");
		assert!(text.contains("[[workspace_trust]]"), "{text}");
		assert!(text.contains("scope = \"pin\""), "{text}");
		assert!(text.contains(&format!("inputs_digest = \"{}\"", inputs("repo"))), "{text}");
		let read = GrantsFile::read(&first).expect("read grants");
		assert_eq!(read, grants);
		read.write(&second).expect("rewrite grants");
		assert_eq!(fs::read(&second).expect("rewritten grants"), text.as_bytes());

		// A file without workspace trust has no table and round-trips too.
		let plain = GrantsFile { workspace_trust: Vec::new(), ..grants };
		plain.write(&first).expect("write plain grants");
		let text = fs::read_to_string(&first).expect("written plain grants");
		assert!(!text.contains("workspace_trust"), "{text}");
		GrantsFile::read(&first)
			.expect("read plain grants")
			.write(&second)
			.expect("rewrite plain grants");
		assert_eq!(fs::read(&second).expect("rewritten plain grants"), text.as_bytes());
	}

	/// Records `workspace`'s exact trust as the answer to an ask about a
	/// workspace that holds no row yet.
	fn persist_exact(path: &Path, workspace: &Path, seed: &str) -> GrantsFile {
		GrantsFile::persist_workspace_trust(
			path,
			exact_trust(workspace, seed),
			&TrustDecision::Untrusted,
			&CanonicalHome::Unresolved,
		)
		.expect("lock and read")
		.expect("an answer to an untrusted workspace")
	}

	/// A grant file beside a canonical home holding `src/team/repo`.
	struct TrustTree {
		_directory: tempfile::TempDir,
		path:       PathBuf,
		home:       CanonicalHome,
		team:       PathBuf,
		repo:       PathBuf,
	}

	fn trust_tree() -> TrustTree {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = grants_path(directory.path());
		let home = directory.path().join("home");
		let repo = home.join("src/team/repo");
		fs::create_dir_all(&repo).expect("repository");
		let home = CanonicalHome::resolve(Some(&home));
		let repo = fs::canonicalize(repo).expect("canonical repository");
		let team = repo.parent().expect("subtree root").to_path_buf();
		TrustTree { _directory: directory, path, home, team, repo }
	}

	impl TrustTree {
		/// Grants the `team` subtree.
		fn grant_subtree(&self) {
			let subtree = WorkspaceTrustGrant::subtree(
				&self.team,
				&self.home,
				TrustChannel::Cli,
				GrantDuration::Persistent,
			)
			.expect("subtree");
			GrantsFile::persist_workspace_subtree(&self.path, subtree)
				.expect("lock and read")
				.expect("a subtree row");
		}

		/// The repository's pin under `team`.
		fn pin(&self, seed: &str) -> WorkspaceTrustGrant {
			WorkspaceTrustGrant::pin(
				&self.repo,
				inputs(seed),
				&self.team,
				TrustChannel::Interactive,
				GrantDuration::Persistent,
			)
			.expect("pin")
		}

		/// The ask the `team` subtree makes about the repository.
		fn asked(&self) -> TrustDecision {
			TrustDecision::PinUnderSubtree {
				root:     self.team.clone(),
				duration: GrantDuration::Persistent,
			}
		}

		/// Records `grant` as the operator's answer to `answered`.
		fn answer(
			&self,
			grant: WorkspaceTrustGrant,
			answered: &TrustDecision,
		) -> Result<GrantsFile, WorkspaceTrustRefusal> {
			GrantsFile::persist_workspace_trust(&self.path, grant, answered, &self.home)
				.expect("lock and read")
		}

		/// The repository's decision over the durable rows.
		fn decide(&self, seed: &str) -> TrustDecision {
			evaluate(
				&GrantsFile::read(&self.path).expect("read").workspace_trust,
				&self.repo,
				&inputs(seed),
				&self.home,
			)
		}

		fn revoke(&self, workspace: &Path, scope: GrantScope) -> usize {
			GrantsFile::revoke_workspace_trust(&self.path, workspace, scope, TrustChannel::Cli)
				.expect("revoke")
		}

		fn bytes(&self) -> Vec<u8> {
			fs::read(&self.path).expect("grants")
		}

		fn rows(&self) -> Vec<WorkspaceTrustGrant> {
			GrantsFile::read(&self.path).expect("read").workspace_trust
		}

		/// `path` spelled through `team/../team`.
		fn respelled(&self, path: &Path) -> PathBuf {
			let team = self.team.file_name().expect("subtree root name");
			let respelled = self
				.team
				.join("..")
				.join(team)
				.join(path.strip_prefix(&self.team).expect("under the subtree"));
			assert_ne!(respelled, path, "a different spelling");
			respelled
		}
	}

	#[test]
	fn malformed_grant_file_is_a_typed_error() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = directory.path().join("grants.toml");
		assert_eq!(GrantsFile::read(&path).expect("absent grants"), GrantsFile::default());
		fs::write(&path, "workspace_trust = 3").expect("malformed grants");
		let error = GrantsFile::read(&path).expect_err("malformed grants");
		assert!(matches!(&error, GrantsFileError::Toml { path: failed, .. } if *failed == path));
		assert_eq!(error.code(), ExtensionCode::EIntegrity);
		assert!(matches!(
			GrantsFile::persist_workspace_trust(
				&path,
				exact_trust(Path::new("/w"), "w"),
				&TrustDecision::Untrusted,
				&CanonicalHome::Unresolved,
			),
			Err(GrantPersistenceError::Read(GrantsFileError::Toml { .. }))
		));
		assert_eq!(fs::read_to_string(&path).expect("untouched grants"), "workspace_trust = 3");
		let unreadable = directory.path().join("directory.toml");
		fs::create_dir(&unreadable).expect("directory in place of the grant file");
		assert!(matches!(GrantsFile::read(&unreadable), Err(GrantsFileError::Io { .. })));
	}

	#[test]
	fn session_workspace_trust_never_persists() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = directory.path().join("grants.toml");
		let session = WorkspaceTrustGrant {
			duration: GrantDuration::Session,
			..exact_trust(Path::new("/w"), "w")
		};
		GrantsFile { workspace_trust: vec![session.clone()], ..GrantsFile::default() }
			.write(&path)
			.expect("write durable subset");
		assert!(
			GrantsFile::read(&path)
				.expect("read grants")
				.workspace_trust
				.is_empty()
		);
		assert!(matches!(
			GrantsFile::persist_workspace_trust(
				&path,
				session,
				&TrustDecision::Untrusted,
				&CanonicalHome::Unresolved,
			),
			Err(GrantPersistenceError::SessionOnly)
		));
		let subtree = WorkspaceTrustGrant {
			duration: GrantDuration::Session,
			..trust_row(Path::new("/w"), TrustBinding::Subtree)
		};
		assert!(matches!(
			GrantsFile::persist_workspace_subtree(&path, subtree),
			Err(GrantPersistenceError::SessionOnly)
		));
	}

	#[test]
	fn persisted_workspace_trust_replaces_the_rows_slot() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = grants_path(directory.path());
		let home = CanonicalHome::Unresolved;
		let repo = Path::new("/work/repo");
		let subtree = trust_row(repo, TrustBinding::Subtree);
		persist_exact(&path, repo, "old");
		GrantsFile::persist_workspace_subtree(&path, subtree.clone())
			.expect("lock and read")
			.expect("subtree at the same root");
		let changed = TrustDecision::DigestChanged { granted: inputs("old"), current: inputs("new") };
		GrantsFile::persist_workspace_trust(&path, exact_trust(repo, "new"), &changed, &home)
			.expect("lock and read")
			.expect("retrust");
		assert_eq!(GrantsFile::read(&path).expect("read").workspace_trust, [
			subtree.clone(),
			exact_trust(repo, "new"),
		]);
		// A revoke under the subtree puts a deny in the decision slot, and an
		// exact grant answering the deny replaces it.
		assert_eq!(
			GrantsFile::revoke_workspace_trust(&path, repo, GrantScope::Exact, TrustChannel::Cli)
				.expect("revoke"),
			1
		);
		let rows = GrantsFile::read(&path).expect("read").workspace_trust;
		assert_eq!(
			rows
				.iter()
				.map(|row| (row.workspace.as_path(), row.binding.scope()))
				.collect::<Vec<_>>(),
			[(repo, TrustScope::Subtree), (repo, TrustScope::Deny)]
		);
		let persisted = GrantsFile::persist_workspace_trust(
			&path,
			exact_trust(repo, "new"),
			&TrustDecision::Denied,
			&home,
		)
		.expect("lock and read")
		.expect("retrust the revoked workspace");
		assert_eq!(persisted.workspace_trust, [subtree.clone(), exact_trust(repo, "new")]);

		// Each writer refuses the other's rows without touching the file.
		let before = fs::read(&path).expect("grants");
		for refused in [subtree, trust_row(repo, TrustBinding::Deny)] {
			let scope = refused.binding.scope();
			assert_eq!(
				GrantsFile::persist_workspace_trust(&path, refused, &TrustDecision::Untrusted, &home)
					.expect("no lock taken"),
				Err(WorkspaceTrustRefusal::Scope { scope })
			);
		}
		assert_eq!(
			GrantsFile::persist_workspace_subtree(&path, exact_trust(repo, "other"))
				.expect("no lock taken"),
			Err(WorkspaceTrustRefusal::Scope { scope: TrustScope::Exact })
		);
		assert_eq!(fs::read(&path).expect("grants"), before);
	}

	#[test]
	fn revoke_under_a_live_subtree_stays_untrusted() {
		let tree = trust_tree();
		tree.grant_subtree();
		assert_eq!(tree.decide("repo"), tree.asked());
		tree
			.answer(tree.pin("repo"), &tree.asked())
			.expect("a pin answering the ask");
		assert_eq!(tree.decide("repo"), TrustDecision::Trusted {
			duration: GrantDuration::Persistent,
		});

		assert_eq!(tree.revoke(&tree.repo, GrantScope::Exact), 1);
		let decision = tree.decide("repo");
		assert_eq!(decision, TrustDecision::Denied, "the subtree neither trusts nor asks");
		assert_eq!(decision.trust(), WorkspaceTrust::Untrusted);
		// Revoking again changes nothing.
		assert_eq!(tree.revoke(&tree.repo, GrantScope::Exact), 0);
		assert_eq!(
			GrantsFile::read(&tree.path)
				.expect("read")
				.workspace_trust
				.iter()
				.filter(|row| row.binding == TrustBinding::Deny)
				.count(),
			1
		);
	}

	#[test]
	fn a_stale_answer_never_undoes_a_concurrent_revoke() {
		let tree = trust_tree();
		tree.grant_subtree();
		// A host asks about the repository under the subtree, and another
		// process revokes it before the operator answers.
		let asked = tree.decide("repo");
		assert_eq!(asked, tree.asked());
		assert_eq!(tree.revoke(&tree.repo, GrantScope::Exact), 0);
		let before = tree.bytes();
		assert_eq!(
			tree.answer(tree.pin("repo"), &asked),
			Err(WorkspaceTrustRefusal::Denied { workspace: tree.repo.clone() })
		);
		assert_eq!(
			tree.answer(exact_trust(&tree.repo, "repo"), &asked),
			Err(WorkspaceTrustRefusal::Stale {
				workspace: tree.repo.clone(),
				current:   TrustDecision::Denied,
			})
		);
		assert_eq!(tree.bytes(), before, "a refused answer writes nothing");
		assert_eq!(tree.decide("repo"), TrustDecision::Denied);

		// The same for a digest re-ask: the pinned inputs changed, and the
		// revoke lands while the operator is asked about the new ones.
		let tree = trust_tree();
		tree.grant_subtree();
		tree.answer(tree.pin("old"), &tree.asked()).expect("pin");
		let asked = tree.decide("new");
		assert_eq!(asked, TrustDecision::DigestChanged {
			granted: inputs("old"),
			current: inputs("new"),
		});
		assert_eq!(tree.revoke(&tree.repo, GrantScope::Exact), 1);
		let before = tree.bytes();
		assert_eq!(
			tree.answer(tree.pin("new"), &asked),
			Err(WorkspaceTrustRefusal::Denied { workspace: tree.repo.clone() })
		);
		assert_eq!(
			tree.answer(exact_trust(&tree.repo, "new"), &asked),
			Err(WorkspaceTrustRefusal::Stale {
				workspace: tree.repo.clone(),
				current:   TrustDecision::Denied,
			})
		);
		assert_eq!(tree.bytes(), before, "a refused answer writes nothing");
		assert_eq!(tree.decide("new"), TrustDecision::Denied);
		// Only an exact grant answering the deny itself trusts it again.
		tree
			.answer(exact_trust(&tree.repo, "new"), &TrustDecision::Denied)
			.expect("explicit re-trust");
		assert_eq!(tree.decide("new"), TrustDecision::Trusted {
			duration: GrantDuration::Persistent,
		});
	}

	#[test]
	fn a_pin_answered_after_its_subtree_was_revoked_never_revives() {
		let tree = trust_tree();
		tree.grant_subtree();
		let asked = tree.decide("repo");
		assert_eq!(tree.revoke(&tree.team, GrantScope::Subtree), 1);
		let before = tree.bytes();
		assert_eq!(
			tree.answer(tree.pin("repo"), &asked),
			Err(WorkspaceTrustRefusal::NoLiveSubtree {
				workspace: tree.repo.clone(),
				under:     tree.team.clone(),
			})
		);
		assert_eq!(tree.bytes(), before, "a refused answer writes nothing");
		assert_eq!(tree.decide("repo"), TrustDecision::Untrusted);
		// Granting the subtree again asks about the repository again.
		tree.grant_subtree();
		assert_eq!(tree.decide("repo"), tree.asked());

		// A dormant pin (a hand edit) is dropped when its subtree is granted
		// anew, and a refreshed grant keeps the pins it admitted.
		let tree = trust_tree();
		GrantsFile::update(&tree.path, |grants| grants.workspace_trust.push(tree.pin("repo")))
			.expect("hand-edited pin");
		assert_eq!(tree.decide("repo"), TrustDecision::Untrusted);
		tree.grant_subtree();
		assert_eq!(tree.decide("repo"), tree.asked(), "the new grant asks");
		tree.answer(tree.pin("repo"), &tree.asked()).expect("pin");
		tree.grant_subtree();
		assert_eq!(
			tree.decide("repo"),
			TrustDecision::Trusted { duration: GrantDuration::Persistent },
			"a refreshed subtree keeps its pins"
		);
	}

	#[test]
	fn revoking_a_workspace_without_a_subtree_records_no_deny() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = grants_path(directory.path());
		let repo = Path::new("/work/repo");
		persist_exact(&path, repo, "repo");
		// `/work/re` is a string prefix of the workspace, not an ancestor.
		let prefix = trust_row(Path::new("/work/re"), TrustBinding::Subtree);
		GrantsFile::persist_workspace_subtree(&path, prefix.clone())
			.expect("lock and read")
			.expect("subtree row");
		assert_eq!(
			GrantsFile::revoke_workspace_trust(&path, repo, GrantScope::Exact, TrustChannel::Cli)
				.expect("revoke"),
			1
		);
		assert_eq!(GrantsFile::read(&path).expect("read").workspace_trust, [prefix]);
	}

	#[test]
	fn revoking_a_subtree_drops_the_pins_it_admitted() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = grants_path(directory.path());
		let team = Path::new("/work/team");
		let other = Path::new("/work/other");
		let pin = |workspace: &Path, under: &Path| {
			trust_row(workspace, TrustBinding::Pin {
				under:         under.to_path_buf(),
				inputs_digest: inputs("pin"),
			})
		};
		let rows = [
			trust_row(team, TrustBinding::Subtree),
			trust_row(other, TrustBinding::Subtree),
			pin(&team.join("a"), team),
			pin(&other.join("b"), other),
			exact_trust(&team.join("c"), "c"),
			trust_row(&team.join("d"), TrustBinding::Deny),
		];
		GrantsFile::update(&path, |grants| grants.workspace_trust.extend(rows)).expect("seed rows");
		assert_eq!(
			GrantsFile::revoke_workspace_trust(&path, team, GrantScope::Subtree, TrustChannel::Cli)
				.expect("revoke subtree"),
			2
		);
		assert_eq!(GrantsFile::read(&path).expect("read").workspace_trust, [
			trust_row(other, TrustBinding::Subtree),
			pin(&other.join("b"), other),
			exact_trust(&team.join("c"), "c"),
			trust_row(&team.join("d"), TrustBinding::Deny),
		]);
	}

	#[test]
	fn a_revoke_matches_the_canonical_workspace_then_the_recorded_spelling() {
		let tree = trust_tree();
		tree.grant_subtree();
		tree.answer(tree.pin("repo"), &tree.asked()).expect("pin");
		// Another spelling of an existing workspace revokes its canonical row,
		// and the deny lands where evaluation looks for it.
		assert_eq!(tree.revoke(&tree.respelled(&tree.repo), GrantScope::Exact), 1);
		assert_eq!(tree.decide("repo"), TrustDecision::Denied);
		assert_eq!(
			tree
				.rows()
				.iter()
				.map(|row| (row.workspace.as_path(), row.binding.scope()))
				.collect::<Vec<_>>(),
			[(tree.team.as_path(), TrustScope::Subtree), (tree.repo.as_path(), TrustScope::Deny)]
		);
		assert_eq!(tree.revoke(&tree.respelled(&tree.team), GrantScope::Subtree), 1);
		assert!(
			tree
				.rows()
				.iter()
				.all(|row| row.binding != TrustBinding::Subtree),
			"the subtree row is revoked"
		);

		// A deleted workspace cannot be canonicalized: its recorded spelling
		// still revokes it.
		let tree = trust_tree();
		tree.grant_subtree();
		tree.answer(tree.pin("repo"), &tree.asked()).expect("pin");
		fs::remove_dir(&tree.repo).expect("delete the repository");
		assert_eq!(tree.revoke(&tree.repo, GrantScope::Exact), 1);
		assert_eq!(tree.decide("repo"), TrustDecision::Denied);
		assert_eq!(tree.revoke(&tree.team, GrantScope::Subtree), 1);
	}

	#[test]
	fn a_revoke_naming_no_row_under_no_subtree_records_no_deny() {
		let tree = trust_tree();
		tree.grant_subtree();
		let rows = tree.rows();
		// A missing workspace spelled under the subtree: no row names it, and
		// it has no canonical path a deny could be keyed by.
		let missing = tree.team.join("gone").join("..").join("ghost");
		assert_eq!(tree.revoke(&missing, GrantScope::Exact), 0);
		assert_eq!(tree.rows(), rows, "no deny for a missing workspace no row names");
		assert_eq!(tree.revoke(&missing, GrantScope::Subtree), 0);
		assert_eq!(tree.rows(), rows);

		// A link under the subtree to a workspace outside it: its canonical
		// workspace is covered by no subtree.
		#[cfg(unix)]
		{
			let outside = tempfile::tempdir().expect("workspace outside the subtree");
			let link = tree.team.join("escape");
			std::os::unix::fs::symlink(outside.path(), &link).expect("link into the subtree");
			assert_eq!(tree.revoke(&link, GrantScope::Exact), 0);
			assert_eq!(tree.rows(), rows, "no deny for a workspace no subtree covers");
		}

		// An existing workspace under the subtree, by another spelling, is
		// denied at its canonical path.
		assert_eq!(tree.revoke(&tree.respelled(&tree.repo), GrantScope::Exact), 0);
		assert_eq!(tree.decide("repo"), TrustDecision::Denied);
	}

	#[test]
	fn concurrent_persist_and_revoke_never_resurrect_a_revoked_row() {
		use std::sync::{Arc, Barrier};

		const WRITERS: usize = 4;
		const ROUNDS: usize = 25;
		let directory = tempfile::tempdir().expect("grant directory");
		let path = Arc::new(grants_path(directory.path()));
		let target = Path::new("/work/target");
		persist_exact(&path, target, "target");
		let start = Arc::new(Barrier::new(WRITERS + 1));
		let writers = (0..WRITERS)
			.map(|writer| {
				let path = Arc::clone(&path);
				let start = Arc::clone(&start);
				thread::spawn(move || {
					start.wait();
					for round in 0..ROUNDS {
						let workspace = PathBuf::from(format!("/work/writer-{writer}/{round}"));
						persist_exact(&path, &workspace, "w");
					}
				})
			})
			.collect::<Vec<_>>();
		start.wait();
		thread::sleep(Duration::from_millis(5));
		let removed =
			GrantsFile::revoke_workspace_trust(&path, target, GrantScope::Exact, TrustChannel::Cli)
				.expect("revoke during writes");
		assert_eq!(removed, 1);
		for writer in writers {
			writer.join().expect("writer thread");
		}
		let rows = GrantsFile::read(&path).expect("read").workspace_trust;
		assert!(
			rows.iter().all(|row| row.workspace != target),
			"a stale writer resurrected the revoked row"
		);
		assert_eq!(rows.len(), WRITERS * ROUNDS, "no concurrent write was lost");
	}

	#[test]
	fn a_held_lock_times_out_with_a_typed_error_and_leaves_the_file() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = grants_path(directory.path());
		persist_exact(&path, Path::new("/w"), "w");
		let before = fs::read(&path).expect("grants");
		let held = GrantsFileLock::acquire(&path, GRANTS_LOCK_WAIT).expect("hold the lock");
		let wait = Duration::from_millis(30);
		let result = GrantsFile::locked(&path, wait, |grants| {
			grants.workspace_trust.clear();
			Ok::<_, Infallible>(())
		});
		match result {
			Err(GrantPersistenceError::LockTimeout { path: lock, waited }) => {
				assert_eq!(lock, directory.path().join("ext/grants.toml.lock"));
				assert!(waited >= wait, "{waited:?}");
			},
			other => panic!("expected a lock timeout, got {other:?}"),
		}
		drop(held);
		assert_eq!(fs::read(&path).expect("grants"), before);
		// Released, the lock admits the next writer at once.
		GrantsFile::update(&path, |grants| grants.workspace_trust.clear()).expect("update");
		assert!(
			GrantsFile::read(&path)
				.expect("read")
				.workspace_trust
				.is_empty()
		);
	}

	#[test]
	fn a_refused_try_update_leaves_the_file_untouched() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = grants_path(directory.path());
		persist_exact(&path, Path::new("/w"), "w");
		let before = fs::read(&path).expect("grants");
		let refused = GrantsFile::try_update(&path, |grants| {
			grants.workspace_trust.clear();
			Err::<(), _>("refused")
		})
		.expect("lock and read");
		assert_eq!(refused, Err("refused"));
		assert_eq!(fs::read(&path).expect("grants"), before);
	}

	#[test]
	fn revocations_apply_pep_440_predicates_to_exact_locked_versions() {
		let list = RevocationsFile {
			version:     1,
			issued_at:   sf!("2026-01-01T00:00:00Z"),
			valid_until: sf!("2027-01-01T00:00:00Z"),
			revoked:     vec![RevokedVersion {
				id:       sf!("sample"),
				versions: sf!(">=1.2,<2,!=1.5"),
				reason:   sf!("security"),
				advisory: "https://example.invalid/advisory".to_owned(),
			}],
			signature:   sf!("invalid"),
		};
		assert!(
			list
				.revocation_for(&sf!("sample"), &sf!("1.4"))
				.unwrap()
				.is_some()
		);
		assert!(
			list
				.revocation_for(&sf!("sample"), &sf!("1.5"))
				.unwrap()
				.is_none()
		);
		assert!(
			list
				.revocation_for(&sf!("sample"), &sf!("2.0"))
				.unwrap()
				.is_none()
		);
	}
}
