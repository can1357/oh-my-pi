//! `omp ext` command parsing and extension-backend dispatch.
pub(crate) mod config;
pub(crate) mod service;

use std::{
	fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use clap::{Args, Subcommand, ValueEnum};
use futures::StreamExt as _;
use miette::{Diagnostic, IntoDiagnostic as _, miette};
use omp_core::{Hash32, Str, base64, encoding::hex, sf};
use omp_env::{BundleFile, pack_bundle, unpack_bundle};
use omp_ext::{
	Layer as BackendLayer,
	config::{
		DeploymentManifest, ExtensionEnvironment, FeatureSelection, MissingSourceOutcome,
		MissingSourcePolicy, OfflineMode, SourceSpec, effective_missing_source,
	},
	doctor::{CredentialHealth, DoctorRequest, DoctorSeverity, RuntimeHealth, diagnose},
	index::SignedIndex,
	lock::{
		InstalledExtension, InstalledRecord, LockFile, LockedExtension, LockedPackage, Wheel,
		index_source,
	},
	resolver::{ResolvePlan, ResolveRequirement, SystemUv, compare_versions, minimal_unsat_core},
	trust::{
		Grant, GrantsFile, KeysFile, RevocationFreshness, RevocationsFile, grant_covers,
		parse_grant_requests, validate_grant_request, verify_artifact_signature,
	},
	upgrade::{
		Generation, PinsFile, apply_uninstall, concrete_features, gc_generations, plan_uninstall,
		set_enabled,
	},
};
use omp_journal::blob::BlobStore;
use omp_proto::env::v1::{MaterializeSite, SiteFile};
use sha2::{Digest as _, Sha256};
use toml::map;
const MAX_WHEEL_BYTES: usize = 256 * 1024 * 1024;

/// Typed application-boundary wrapper preserving the extension diagnostic and
/// its command-specific process status.
#[derive(Debug, thiserror::Error, Diagnostic)]
#[error("extension operation failed")]
pub struct ExtensionCliFailure {
	#[source]
	source: omp_ext::ExtensionError,
}

impl ExtensionCliFailure {
	fn new(source: omp_ext::ExtensionError) -> Self {
		Self { source }
	}

	/// Uniform `omp ext` exit status for the stable diagnostic code.
	pub const fn exit_code(&self) -> u8 {
		self.source.exit_code()
	}
}

fn extension_failure(error: omp_ext::ExtensionError) -> miette::Report {
	miette::Report::new(ExtensionCliFailure::new(error))
}

/// Ctrl+C observed while an extension installer-owned child or network stream
/// was active.
#[derive(Clone, Copy, Debug, thiserror::Error, Diagnostic)]
#[error("extension operation interrupted")]
pub struct ExtensionInterrupt;

impl ExtensionInterrupt {
	/// Conventional shell status for SIGINT.
	pub const fn exit_code(&self) -> u8 {
		130
	}
}

fn extension_interrupt() -> miette::Report {
	miette::Report::new(ExtensionInterrupt)
}

/// Shared options accepted by every `omp ext` operation.
#[derive(Clone, Debug, Args)]
pub struct ExtArgs {
	/// Workspace root whose extension layer and lock are selected.
	#[arg(long, global = true, value_name = "PATH", default_value = ".")]
	pub project:       PathBuf,
	/// Client-scope extension state root.
	#[arg(long, global = true, value_name = "PATH")]
	pub data_dir:      Option<PathBuf>,
	/// Extension store root, equivalent to `OMP_EXT_STORE`.
	#[arg(long, global = true, value_name = "PATH")]
	pub store:         Option<PathBuf>,
	/// Download cache root, equivalent to `OMP_EXT_CACHE`.
	#[arg(long, global = true, value_name = "PATH")]
	pub cache:         Option<PathBuf>,
	/// Resolution index URL, equivalent to `OMP_EXT_INDEX`.
	#[arg(long, global = true, value_name = "URL")]
	pub index:         Vec<Str>,
	/// Index public-key file, equivalent to `OMP_EXT_INDEX_KEYS`.
	#[arg(long, global = true, value_name = "PATH")]
	pub index_keys:    Option<PathBuf>,
	/// Forbid network access, equivalent to `OMP_EXT_OFFLINE`.
	#[arg(long, global = true)]
	pub offline:       bool,
	/// Refuse to modify a lock, equivalent to `OMP_EXT_LOCKED`.
	#[arg(long, global = true)]
	pub locked:        bool,
	/// Default reproducibility cutoff, equivalent to `OMP_EXT_EXCLUDE_NEWER`.
	#[arg(long, global = true, value_name = "DATE")]
	pub exclude_newer: Option<Str>,
	/// Disable extension identities, equivalent to `OMP_EXT_DISABLE`.
	#[arg(long, global = true, value_delimiter = ',', value_name = "ID")]
	pub disable:       Vec<Str>,
	/// Non-interactive capability grants, equivalent to `OMP_EXT_GRANT`.
	#[arg(long, global = true, value_name = "GRANT")]
	pub grant:         Option<Str>,
	/// Permit local source builds, equivalent to `OMP_EXT_ALLOW_BUILD`.
	#[arg(long, global = true)]
	pub allow_build:   bool,
	/// Publisher signing key, equivalent to `OMP_EXT_SIGN_KEY`.
	#[arg(long, global = true, value_name = "PATH")]
	pub sign_key:      Option<PathBuf>,
	/// `uv` executable path, equivalent to `OMP_EXT_UV`.
	#[arg(long, global = true, value_name = "PATH")]
	pub uv:            Option<PathBuf>,
	/// Default target triples, equivalent to `OMP_EXT_TARGETS`.
	#[arg(long, global = true, value_delimiter = ',', value_name = "TRIPLE")]
	pub targets:       Vec<Str>,
	/// Trace resolution and verification, equivalent to `OMP_EXT_TRACE`.
	#[arg(long, global = true)]
	pub trace:         bool,
	/// Environment socket passed to host children, equivalent to
	/// `OMP_EXT_ENV_SOCKET`.
	#[arg(long, global = true, value_name = "PATH")]
	pub env_socket:    Option<PathBuf>,
	/// Which extension layer to inspect or change.
	#[arg(long, global = true, value_enum)]
	pub layer:         Option<Layer>,
	/// Install-record scope for mutations.
	#[arg(long, global = true, value_enum, default_value_t = Scope::User)]
	pub scope:         Scope,
	/// Emit machine-readable output on stdout.
	#[arg(long, global = true)]
	pub json:          bool,
	/// Include resolver and verification detail.
	#[arg(long, global = true)]
	pub verbose:       bool,
	/// Extension operation.
	#[command(subcommand)]
	pub command:       ExtCommand,
}

/// The layer selected by an extension operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum Layer {
	/// Select the client layer.
	Client,
	/// Select the workspace layer.
	Workspace,
	/// Select both layers.
	All,
}

/// The scope containing an extension installation record.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum, serde::Serialize, strum::Display)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum Scope {
	/// Select the user-level install record.
	User,
	/// Select the project-level install record.
	Project,
}

/// The containment tier granted to an extension.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
	/// Permit trusted in-process-adjacent code shipping.
	Trusted,
	/// Require sandboxed execution.
	Sandboxed,
}

/// Code shipping level for a trusted extension.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum, serde::Serialize, strum::IntoStaticStr)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum Ship {
	/// Ship the installed artifact.
	Installed,
	/// Ship source code.
	Source,
	/// Ship serialized code; requires the trusted tier.
	Pickle,
}

/// `omp ext` operations.
#[derive(Clone, Debug, Subcommand)]
pub enum ExtCommand {
	/// List installed and admitted extensions with provenance and signature
	/// state.
	List(ExtListArgs),
	/// Display an extension record and declared-versus-registered capabilities.
	Info(ExtInfoArgs),
	/// Resolve, verify, consent to, and install extension specifications.
	Install(ExtInstallArgs),
	/// Scaffold a minimal manifest-first Python extension.
	New(ExtNewArgs),
	/// Remove extension installation records.
	Uninstall(ExtUninstallArgs),
	/// Register a local extension directory.
	Link(ExtLinkArgs),
	/// Remove a local extension link.
	Unlink {
		/// Extension identity to unlink.
		id: Str,
	},
	/// Admit an installed extension and notify resident host digests.
	Enable {
		/// Extension identity to enable.
		id: Str,
	},
	/// Withdraw declarations from an extension and notify resident host digests.
	Disable {
		/// Extension identity to disable.
		id: Str,
	},
	/// Inspect or modify enabled extension features.
	Features(ExtFeaturesArgs),
	/// Interactively configure per-extension resource admission.
	Config(config::ExtConfigArgs),
	/// Write or verify the extension lock.
	Lock(ExtLockArgs),
	/// Resolve extension specifications without writing state.
	Resolve(ExtResolveArgs),
	/// Materialize managed site trees from locks.
	Sync(ExtSyncArgs),
	/// Upgrade installed extension identities.
	Upgrade(ExtUpgradeArgs),
	/// Pin an extension version.
	Pin {
		/// Extension identity to pin.
		id:      Str,
		/// Version to pin.
		version: Str,
	},
	/// Remove an extension version pin.
	Unpin {
		/// Extension identity to unpin.
		id: Str,
	},
	/// Report or collect unreachable extension artifacts.
	Gc(ExtGcArgs),
	/// Check extension lock, site tree, integrity, environment, and API health.
	Doctor(ExtDoctorArgs),
	/// Inspect or change an extension trust grant.
	Trust(ExtTrustArgs),
	/// Recheck artifact integrity, signatures, and revocations.
	Verify(ExtVerifyArgs),
	/// Build an air-gap extension bundle.
	Bundle(ExtBundleArgs),
	/// Validate or upload an extension distribution.
	Publish(ExtPublishArgs),
	/// Query the extension catalog.
	#[command(visible_alias = "discover")]
	Search(ExtSearchArgs),
	/// Manage the ordered extension index list.
	Index(ExtIndexArgs),
	/// Print resolved extension paths.
	Where(ExtWhereArgs),
}

/// Filters for `omp ext list`.
#[derive(Clone, Debug, Args)]
pub struct ExtListArgs {
	/// Show only enabled extensions.
	#[arg(long, conflicts_with = "disabled")]
	pub enabled:  bool,
	/// Show only disabled extensions.
	#[arg(long, conflicts_with = "enabled")]
	pub disabled: bool,
	/// Filter by containment tier.
	#[arg(long, value_enum)]
	pub tier:     Option<Tier>,
	/// Filter by sharing group; an empty value selects isolated extensions.
	#[arg(long, value_name = "NAME")]
	pub pool:     Option<Str>,
	/// Show only extensions with a newer available version.
	#[arg(long)]
	pub outdated: bool,
	/// Show only unsigned extensions.
	#[arg(long)]
	pub unsigned: bool,
	/// Include dependency closure and extension edges.
	#[arg(long)]
	pub tree:     bool,
}

/// Selectors for `omp ext info`.
#[derive(Clone, Debug, Args)]
pub struct ExtInfoArgs {
	/// Extension identity.
	pub id:           Str,
	/// Print only declared and registered capabilities with their digest.
	#[arg(long)]
	pub capabilities: bool,
	/// Print only the lock entry.
	#[arg(long)]
	pub lock:         bool,
	/// Print only store, site-tree, and binary paths.
	#[arg(long)]
	pub paths:        bool,
}

/// Options for `omp ext install`.
#[derive(Clone, Debug, Args)]
pub struct ExtInstallArgs {
	/// Extension specifications to install.
	#[arg(required = true, value_name = "SPEC")]
	pub specs:          Vec<Str>,
	/// Requested containment tier.
	#[arg(long, value_enum, default_value_t = Tier::Sandboxed)]
	pub tier:           Tier,
	/// Sharing group; omitted means isolated.
	#[arg(long, value_name = "NAME")]
	pub pool:           Option<Str>,
	/// Replace manifest-default enabled features.
	#[arg(long, value_name = "FEATURES")]
	pub features:       Option<Str>,
	/// Grant exactly these declared capabilities.
	#[arg(long, value_name = "CAPS")]
	pub capabilities:   Option<Str>,
	/// Grant all manifest-declared capabilities after showing the diff.
	#[arg(long)]
	pub yes:            bool,
	/// Resolve and verify but do not write state.
	#[arg(long)]
	pub dry_run:        bool,
	/// Ignore index pre-resolved closures.
	#[arg(long)]
	pub no_preresolved: bool,
	/// Resolve for these targets.
	#[arg(long, value_delimiter = ',', value_name = "TRIPLE")]
	pub target:         Vec<Str>,
	/// Do not write a lock.
	#[arg(long)]
	pub no_lock:        bool,
	/// Reinstall and re-verify already satisfied specifications.
	#[arg(long)]
	pub force:          bool,
}

/// Options for `omp ext uninstall`.
#[derive(Clone, Debug, Args)]
pub struct ExtUninstallArgs {
	/// Extension identities to remove.
	#[arg(required = true, value_name = "ID")]
	pub ids:        Vec<Str>,
	/// Retain the grant record.
	#[arg(long)]
	pub keep_grant: bool,
	/// Retain the lock entry.
	#[arg(long)]
	pub keep_lock:  bool,
	/// Remove extension state and fetched binaries.
	#[arg(long)]
	pub purge:      bool,
	/// Print removals without changing state.
	#[arg(long)]
	pub dry_run:    bool,
}

/// Options for `omp ext new`.
#[derive(Clone, Debug, Args)]
pub struct ExtNewArgs {
	/// Stable extension identity and destination directory.
	pub id: Str,
}

/// Options for `omp ext link`.
#[derive(Clone, Debug, Args)]
pub struct ExtLinkArgs {
	/// Local extension directory.
	pub path:       PathBuf,
	/// Requested containment tier.
	#[arg(long, value_enum, default_value_t = Tier::Sandboxed)]
	pub tier:       Tier,
	/// Override the manifest identity.
	#[arg(long, value_name = "ID")]
	pub name:       Option<Str>,
	/// Replace manifest-default enabled features.
	#[arg(long, value_name = "FEATURES")]
	pub features:   Option<Str>,
	/// Record the link without resolving requirements.
	#[arg(long)]
	pub no_resolve: bool,
}

/// Options for `omp ext features`.
#[derive(Clone, Debug, Args)]
pub struct ExtFeaturesArgs {
	/// Extension identity.
	pub id:      Str,
	/// Add enabled features.
	#[arg(long, value_name = "FEATURES", conflicts_with = "set")]
	pub enable:  Option<Str>,
	/// Remove enabled features.
	#[arg(long, value_name = "FEATURES", conflicts_with = "set")]
	pub disable: Option<Str>,
	/// Replace enabled features.
	#[arg(long, value_name = "FEATURES", conflicts_with_all = ["enable", "disable"])]
	pub set:     Option<Str>,
	/// List available features and requirements.
	#[arg(long)]
	pub list:    bool,
}

/// Options for `omp ext lock`.
#[derive(Clone, Debug, Args)]
pub struct ExtLockArgs {
	/// Target triples to write into the lock.
	#[arg(long, value_delimiter = ',', value_name = "TRIPLE")]
	pub targets:         Vec<Str>,
	/// Resolve all packages to their newest permitted versions.
	#[arg(long)]
	pub upgrade:         bool,
	/// Resolve only these distributions anew.
	#[arg(long, value_name = "NAME")]
	pub upgrade_package: Vec<Str>,
	/// Verify whether the lock would change without writing it.
	#[arg(long)]
	pub check:           bool,
	/// Also write a PEP 751 lock.
	#[arg(long, value_name = "PATH")]
	pub export_pylock:   Option<PathBuf>,
}

/// Options for `omp ext resolve`.
#[derive(Clone, Debug, Args)]
pub struct ExtResolveArgs {
	/// Extension specifications to resolve.
	#[arg(required = true, value_name = "SPEC")]
	pub specs:        Vec<Str>,
	/// Print the resolution graph, rules, and equivalent uv invocation.
	#[arg(long)]
	pub explain:      bool,
	/// Resolve layers as one local host.
	#[arg(long)]
	pub as_if_local:  bool,
	/// Resolve for these targets.
	#[arg(long, value_delimiter = ',', value_name = "TRIPLE")]
	pub target:       Vec<Str>,
	/// Print only the minimal unsatisfiable core on failure.
	#[arg(long)]
	pub minimal_core: bool,
}

/// Options for `omp ext sync`.
#[derive(Clone, Debug, Args)]
pub struct ExtSyncArgs {
	/// Remove site entries absent from the lock.
	#[arg(long)]
	pub prune:  bool,
	/// Provision this worker through the Rust supervisor.
	#[arg(long, value_name = "NAME")]
	pub worker: Option<Str>,
	/// Re-verify every locked artifact.
	#[arg(long)]
	pub verify: bool,
	/// Materialize from an air-gap bundle.
	#[arg(long, value_name = "BUNDLE")]
	pub from:   Option<PathBuf>,
}

/// Options for `omp ext upgrade`.
#[derive(Clone, Debug, Args)]
pub struct ExtUpgradeArgs {
	/// Extension identities to upgrade.
	pub ids: Vec<Str>,
	/// Exact target version for one identity.
	#[arg(long, value_name = "VERSION")]
	pub to: Option<Str>,
	/// Print the plan and capability diff only.
	#[arg(long)]
	pub dry_run: bool,
	/// Allow widened capabilities non-interactively.
	#[arg(long)]
	pub allow_capability_widening: bool,
	/// Restore this identity's previous resolution.
	#[arg(long, value_name = "ID")]
	pub rollback: Option<Str>,
}

/// Options for `omp ext gc`.
#[derive(Clone, Debug, Args)]
pub struct ExtGcArgs {
	/// Actually delete unreachable artifacts; omitted is a dry run.
	#[arg(long)]
	pub apply:            bool,
	/// Retain this many resolution generations per host key.
	#[arg(long, value_name = "N", default_value_t = 2)]
	pub keep_generations: usize,
	/// Retain the downloaded-artifact cache.
	#[arg(long)]
	pub keep_cache:       bool,
	/// Consider locks for every known workspace.
	#[arg(long)]
	pub all_projects:     bool,
}

/// Options for `omp ext doctor`.
#[derive(Clone, Debug, Args)]
pub struct ExtDoctorArgs {
	/// Repair mechanically repairable integrity and site-tree failures.
	#[arg(long)]
	pub fix: bool,
}

/// Options for `omp ext trust`.
#[derive(Clone, Debug, Args)]
pub struct ExtTrustArgs {
	/// Extension identity.
	pub id:     Str,
	/// Print the current trust grant only.
	#[arg(long)]
	pub show:   bool,
	/// Change containment tier after consent.
	#[arg(long, value_enum)]
	pub tier:   Option<Tier>,
	/// Change code-shipping level.
	#[arg(long, value_enum)]
	pub ship:   Option<Ship>,
	/// Accept this publisher-key fingerprint.
	#[arg(long, value_name = "FINGERPRINT")]
	pub key:    Option<Str>,
	/// Drop the grant without uninstalling.
	#[arg(long)]
	pub revoke: bool,
}

/// Options for `omp ext verify`.
#[derive(Clone, Debug, Args)]
pub struct ExtVerifyArgs {
	/// Extension identities to inspect; omitted means all.
	pub ids:         Vec<Str>,
	/// Hash every file against `RECORD`.
	#[arg(long)]
	pub deep:        bool,
	/// Recheck signatures and attestations.
	#[arg(long)]
	pub signatures:  bool,
	/// Refresh the revocation list first.
	#[arg(long)]
	pub revocations: bool,
}

/// Options for `omp ext bundle`.
#[derive(Clone, Debug, Args)]
pub struct ExtBundleArgs {
	/// Destination bundle path.
	pub output:          PathBuf,
	/// Target triples to include.
	#[arg(long, value_delimiter = ',', value_name = "TRIPLE")]
	pub targets:         Vec<Str>,
	/// Layer to bundle.
	#[arg(long, value_enum)]
	pub layer:           Option<Layer>,
	/// Embed catalog metadata for offline search.
	#[arg(long)]
	pub include_catalog: bool,
	/// Include publisher keys.
	#[arg(long, default_value_t = true)]
	pub include_keys:    bool,
}

/// Options for `omp ext publish`.
#[derive(Clone, Debug, Args)]
pub struct ExtPublishArgs {
	/// Distribution wheel to publish.
	#[arg(value_name = "WHEEL")]
	pub wheel:   Option<PathBuf>,
	/// Request index attestation review.
	#[arg(long)]
	pub attest:  bool,
	/// Validate locally without uploading.
	#[arg(long)]
	pub dry_run: bool,
}

/// Options for `omp ext search`.
#[derive(Clone, Debug, Args)]
pub struct ExtSearchArgs {
	/// Catalog query.
	pub query:      Str,
	/// Maximum result count.
	#[arg(long, default_value_t = 20)]
	pub limit:      usize,
	/// Require a declared capability.
	#[arg(long, value_name = "CAPABILITY")]
	pub capability: Option<Str>,
	/// Show reviewed extensions only.
	#[arg(long)]
	pub attested:   bool,
}

/// Index-management command tree.
#[derive(Clone, Debug, Args)]
pub struct ExtIndexArgs {
	/// Index operation.
	#[command(subcommand)]
	pub command: ExtIndexCommand,
}

/// Index-management operations.
#[derive(Clone, Debug, Subcommand)]
pub enum ExtIndexCommand {
	/// Add a named index URL.
	Add {
		/// Index name.
		name:  Str,
		/// Index URL.
		url:   Str,
		/// Put the index first.
		#[arg(long)]
		first: bool,
	},
	/// Remove a named index URL.
	Remove {
		/// Index name.
		name: Str,
	},
	/// List configured index URLs.
	List,
}

/// Options for `omp ext where`.
#[derive(Clone, Debug, Args)]
pub struct ExtWhereArgs {
	/// Optional extension identity.
	pub id: Option<Str>,
}

/// Dispatches a parsed extension command to its dedicated backend seam.
pub async fn run(args: ExtArgs) -> miette::Result<()> {
	let ExtArgs {
		data_dir,
		project,
		scope,
		layer,
		uv,
		store,
		cache,
		index: resolution_indexes,
		index_keys,
		exclude_newer,
		targets: resolution_targets,
		locked,
		offline,
		disable,
		grant,
		allow_build,
		sign_key,
		trace,
		env_socket,
		json,
		command,
		..
	} = args;
	let data_dir = omp_core::dirs::data_dir(data_dir).into_diagnostic()?;
	let mut environment = ExtensionEnvironment::from_environment();
	if let Some(store) = store {
		environment.store = Some(store);
	}
	if let Some(cache) = cache {
		environment.cache = Some(cache);
	}
	if let Some(index_keys) = index_keys {
		environment.index_keys = Some(index_keys);
	}
	if !resolution_indexes.is_empty() {
		environment.indexes = resolution_indexes
			.into_iter()
			.map(|value| value.to_string())
			.collect();
	}
	if let Some(exclude_newer) = exclude_newer {
		environment.exclude_newer = Some(exclude_newer);
	}
	if !resolution_targets.is_empty() {
		environment.targets = resolution_targets;
	}
	if let Some(uv) = uv {
		environment.uv = Some(uv);
	}
	if !disable.is_empty() {
		environment.disabled.extend(disable);
	}
	if let Some(grant) = grant {
		environment.grant = Some(grant.to_string());
	}
	environment.allow_build |= allow_build;
	if let Some(sign_key) = sign_key {
		environment.sign_key = Some(sign_key);
	}
	environment.trace |= trace;
	if let Some(env_socket) = env_socket {
		environment.env_socket = Some(env_socket);
	}
	environment.locked |= locked;
	if offline && environment.offline == OfflineMode::Online {
		environment.offline = OfflineMode::Offline;
	}
	let state = StatePaths::new(&data_dir, &project).with_environment(&environment);
	let scoped_state = state.scoped(scope);
	let settings = omp_driver::settings::current().map_err(|error| miette!("{error}"))?;
	let extension_scopes = settings
		.extension_scopes(
			omp_driver::settings::workspace_extension_overlay(&project)
				.map_err(|error| miette!("{error}"))?,
		)
		.map_err(|error| miette!("{error}"))?;
	let missing_source = effective_missing_source(&extension_scopes);
	match command {
		ExtCommand::List(args) => list(&state, args, json),
		ExtCommand::Info(args) => info(&state, args, json),
		ExtCommand::Install(mut args) => {
			if args.target.is_empty() {
				args.target.clone_from(&environment.targets);
			}
			install(&scoped_state, args, environment.uv.clone(), environment.grant.as_deref(), json)
				.await
		},
		ExtCommand::New(args) => new_extension(&project, args),
		ExtCommand::Uninstall(args) => uninstall(&scoped_state, args),
		ExtCommand::Link(args) => link(&scoped_state, args, json),
		ExtCommand::Unlink { id } => unlink(&scoped_state, &id, json),
		ExtCommand::Enable { id } => enable(&scoped_state, &id, true),
		ExtCommand::Disable { id } => enable(&scoped_state, &id, false),
		ExtCommand::Features(args) => features(&state, args),
		ExtCommand::Config(args) => config::run(&project, layer, args).await,
		ExtCommand::Lock(args) => lock(&state, args),
		ExtCommand::Resolve(args) => {
			resolve(
				&scoped_state,
				args,
				environment.uv.clone(),
				environment
					.indexes
					.clone()
					.into_iter()
					.map(Str::new)
					.collect(),
				environment.exclude_newer.clone(),
				environment.targets.clone(),
				environment.locked,
				missing_source,
			)
			.await
		},
		ExtCommand::Sync(args) => sync(&state, args, environment.uv.as_deref()).await,
		ExtCommand::Upgrade(args) => upgrade(&scoped_state, args, environment.uv.clone()).await,
		ExtCommand::Pin { id, version } => pin(&state, id, version),
		ExtCommand::Unpin { id } => unpin(&state, &id),
		ExtCommand::Gc(args) => gc(&state, args),
		ExtCommand::Doctor(args) => doctor(&scoped_state, args),
		ExtCommand::Trust(args) => trust(&state, args),
		ExtCommand::Verify(args) => {
			if environment.offline != OfflineMode::Online && args.revocations {
				Err(miette!("cannot refresh revocations while extension networking is offline"))
			} else {
				verify(&state, args).await
			}
		},
		ExtCommand::Bundle(args) => bundle(&state, args).await,
		ExtCommand::Publish(args) => publish(args),
		ExtCommand::Search(args) => search(&state, args),
		ExtCommand::Index(args) => index(&state, args),
		ExtCommand::Where(args) => where_paths(&state, args, json),
	}
}

fn list(state: &StatePaths, args: ExtListArgs, json: bool) -> miette::Result<()> {
	let client_lock = read_lock_or_empty(&state.client_lock, BackendLayer::Client)?;
	let workspace_lock = read_lock_or_empty(&state.workspace_lock, BackendLayer::Workspace)?;
	let catalog = args
		.outdated
		.then(|| read_catalog_for_verify(state))
		.transpose()?;
	let entries = service::installed_views(state)?
		.into_iter()
		.filter(|entry| !args.enabled || entry.enabled)
		.filter(|entry| !args.disabled || !entry.enabled)
		.filter(|entry| {
			args
				.tier
				.is_none_or(|selected| entry.tier == tier(selected))
		})
		.filter(|entry| {
			let lock = match entry.scope {
				Scope::User => &client_lock,
				Scope::Project => &workspace_lock,
			};
			let locked = lock.extensions.iter().find(|locked| locked.id == entry.id);
			let outdated = catalog.as_ref().is_none_or(|catalog| {
				locked.is_some_and(|locked| {
					catalog
						.extensions
						.iter()
						.find(|extension| extension.id == locked.id)
						.and_then(|extension| catalog.latest_release(extension, false))
						.is_some_and(|release| {
							compare_versions(release.version.as_str(), locked.version.as_str())
								.is_ok_and(|ordering| ordering.is_gt())
						})
				})
			});
			args
				.pool
				.as_ref()
				.is_none_or(|pool| locked.is_some_and(|locked| locked.pool.as_ref() == Some(pool)))
				&& (!args.unsigned || locked.is_none_or(|locked| locked.signature.trim().is_empty()))
				&& outdated
		})
		.collect::<Vec<_>>();
	if json {
		println!(
			"{}",
			serde_json::to_string_pretty(
				&serde_json::json!({"count": entries.len(), "extensions": entries})
			)
			.into_diagnostic()?
		);
		return Ok(());
	}
	println!("{} extensions", entries.len());
	for entry in entries {
		let lock = match entry.scope {
			Scope::User => &client_lock,
			Scope::Project => &workspace_lock,
		};
		let locked = lock.extensions.iter().find(|locked| locked.id == entry.id);
		let version = entry.version.as_ref().map_or("?", Str::as_str);
		let status = if entry.enabled { "enabled" } else { "disabled" };
		let shadowed = if entry.shadowed { " shadowed" } else { "" };
		let signature = locked.map_or("unsigned", |locked| {
			if locked.signature.trim().is_empty() {
				"unsigned"
			} else {
				"signed"
			}
		});
		println!(
			"{} {} {} {} {} {}{} publisher={} artifact={} generation=- source={}",
			entry.id,
			version,
			entry.scope,
			entry.tier,
			signature,
			status,
			shadowed,
			entry.publisher.as_deref().unwrap_or("-"),
			entry.artifact.as_deref().unwrap_or("-"),
			entry.source
		);
		if args.tree
			&& let Some(locked) = locked
		{
			for requirement in &locked.requires {
				println!("  requires {requirement}");
			}
		}
	}
	Ok(())
}

fn info(state: &StatePaths, args: ExtInfoArgs, json: bool) -> miette::Result<()> {
	let client = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	let workspace = InstalledRecord::read(&state.workspace_installed).map_err(extension_failure)?;
	let (installed, scope, lock) =
		if let Some(installed) = client.extensions.iter().find(|entry| entry.id == args.id) {
			(installed, Scope::User, read_lock_or_empty(&state.client_lock, BackendLayer::Client)?)
		} else if let Some(installed) = workspace
			.extensions
			.iter()
			.find(|entry| entry.id == args.id)
		{
			(
				installed,
				Scope::Project,
				read_lock_or_empty(&state.workspace_lock, BackendLayer::Workspace)?,
			)
		} else {
			return Err(miette!("extension {} is unknown", args.id));
		};
	let manifest = read_installed_manifest_value(installed)?;
	let locked = lock.extensions.iter().find(|entry| entry.id == args.id);
	let paths = serde_json::json!({
		"source": installed.source,
		"siteRoot": state.sites,
		"generationRoot": state.generations,
		"artifactRoot": state.artifacts,
	});
	let value = if args.capabilities {
		serde_json::json!({
			"id": installed.id,
			"capabilities": manifest.as_ref().and_then(|value| value.get("capabilities")),
			"declarations": manifest.as_ref().and_then(|value| value.get("declarations")),
			"capabilityDigest": locked.map(|entry| &entry.capability_digest),
			"declarationDigest": locked.map(|entry| &entry.declaration_digest),
		})
	} else if args.lock {
		serde_json::json!({"id": installed.id, "lock": locked})
	} else if args.paths {
		serde_json::json!({"id": installed.id, "paths": paths})
	} else {
		serde_json::json!({
			"id": installed.id,
			"scope": scope,
			"tier": installed.tier,
			"enabled": installed.enabled,
			"features": installed.features,
			"source": installed.source,
			"manifest": manifest,
			"lock": locked,
			"paths": paths,
			"signature": locked.map(|entry| &entry.signature),
			"publisher": locked.map(|entry| &entry.publisher),
			"artifactDigest": locked.map(|entry| &entry.wheel.blake3),
			"layer": lock.layer,
			"generation": serde_json::Value::Null,
		})
	};
	if !json {
		println!(
			"{} {} {}",
			installed.id,
			installed.tier,
			if installed.enabled {
				"enabled"
			} else {
				"disabled"
			}
		);
	}
	println!("{}", serde_json::to_string_pretty(&value).into_diagnostic()?);
	Ok(())
}
async fn install(
	state: &StatePaths,
	args: ExtInstallArgs,
	uv: Option<PathBuf>,
	grant_request: Option<&str>,
	json: bool,
) -> miette::Result<()> {
	validate_specs(&args.specs)?;
	let mut installed = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	let mut lock = read_lock_or_empty(&state.client_lock, state.layer)?;
	let mut signed_install = false;
	for spec in &args.specs {
		let (source, bracket_selection) =
			SourceSpec::parse_install(spec).map_err(extension_failure)?;
		let selection = requested_features(&args, bracket_selection)?;
		let existing_id = match &source {
			SourceSpec::Index { distribution, .. } => Some(
				distribution
					.rsplit_once('@')
					.map_or(distribution.as_str(), |(id, _)| id),
			),
			SourceSpec::Path(_) => None,
			_ => None,
		};
		if !args.force
			&& existing_id.is_some_and(|id| installed.extensions.iter().any(|entry| entry.id == id))
		{
			return Err(miette!(
				"extension {} is already installed; pass --force to reinstall",
				existing_id.unwrap_or_default()
			));
		}
		match source {
			SourceSpec::Path(path) => {
				let path = path.canonicalize().into_diagnostic()?;
				let manifest = read_development_manifest(&path)?;
				let id = manifest.id.clone();
				if !args.force && installed.extensions.iter().any(|entry| entry.id == id) {
					return Err(miette!(
						"extension {id} is already installed; pass --force to reinstall"
					));
				}
				let mut source = map::Map::new();
				source.insert("path".to_owned(), toml::Value::String(path.display().to_string()));
				let previous = installed
					.extensions
					.iter()
					.find(|entry| entry.id == id)
					.map(|entry| entry.features.as_slice());
				let features = concrete_features(&selection, &manifest.features, previous)
					.map_err(extension_failure)?;
				upsert_installed(&mut installed, InstalledExtension {
					id,
					features,
					source: toml::Value::Table(source),
					tier: tier(args.tier),
					enabled: true,
				});
			},
			source => {
				signed_install |= install_index_source(
					state,
					&args,
					&mut installed,
					&mut lock,
					source,
					selection,
					uv.as_deref(),
					grant_request,
					json,
				)
				.await?;
			},
		}
	}
	if args.dry_run {
		if json {
			println!(
				"{}",
				serde_json::json!({"action": "install", "count": args.specs.len(), "applied": false})
			);
		} else {
			println!("would install {} extension(s)", args.specs.len());
		}
		return Ok(());
	}
	if signed_install {
		let generation = Generation { lock, installed };
		omp_ext::upgrade::commit_generation(
			&state.client_lock,
			&state.client_installed,
			&state.generations,
			&format!("install-{}", omp_core::Ulid::generate()),
			&generation,
		)
		.map_err(extension_failure)?;
	} else {
		installed.write(&state.client_installed).into_diagnostic()?;
	}
	if json {
		println!(
			"{}",
			serde_json::json!({"action": "install", "count": args.specs.len(), "applied": true})
		);
	} else {
		println!("installed {} extension(s)", args.specs.len());
	}
	Ok(())
}

fn uninstall(state: &StatePaths, args: ExtUninstallArgs) -> miette::Result<()> {
	let mut installed = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	let mut lock = read_lock_or_empty(&state.client_lock, state.layer)?;
	let plan = plan_uninstall(&installed, &lock, args.ids, args.keep_lock);
	println!("remove {} installed and {} locked entries", plan.installed.len(), plan.locked.len());
	if args.dry_run {
		return Ok(());
	}
	apply_uninstall(&mut installed, &mut lock, &plan);
	installed.write(&state.client_installed).into_diagnostic()?;
	lock.write(&state.client_lock).into_diagnostic()?;
	if !args.keep_grant {
		let mut grants = GrantsFile::read(&state.grants).map_err(extension_failure)?;
		let removed = plan
			.installed
			.iter()
			.chain(&plan.locked)
			.collect::<std::collections::BTreeSet<_>>();
		grants.grants.retain(|grant| !removed.contains(&grant.id));
		grants.write(&state.grants).into_diagnostic()?;
	}
	Ok(())
}

fn package_name(id: &str) -> miette::Result<String> {
	if id.is_empty()
		|| id.len() > 128
		|| !id.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
		}) {
		return Err(miette!(
			"extension id must contain 1-128 lowercase letters, digits, dots, hyphens, or underscores"
		));
	}
	let mut package = id
		.chars()
		.map(|character| {
			if character.is_ascii_alphanumeric() {
				character
			} else {
				'_'
			}
		})
		.collect::<String>();
	if package.as_bytes().first().is_some_and(u8::is_ascii_digit) {
		package.insert(0, '_');
	}
	Ok(package)
}

fn new_extension(project: &Path, args: ExtNewArgs) -> miette::Result<()> {
	let package = package_name(&args.id)?;
	let root = project.join(args.id.as_str());
	if root.exists() {
		return Err(miette!("extension destination {} already exists", root.display()));
	}
	let manifest = format!(
		r#"id = "{id}"
version = "0.1.0"
omp_api = 1
entry = "{package}"

[[declarations]]
id = "hello"
kind = "hard"
module = "{package}"
key = "hello@{id}.1"
trigger = "lazy"
api = 1
failure = "fail-closed"

[[declarations]]
id = "activated"
kind = "hook"
module = "{package}"
key = "extension_activate/observe"
trigger = "lazy"
api = 1
failure = "fail-open"
"#,
		id = args.id,
	);
	let pyproject = format!(
		r#"[build-system]
requires = ["hatchling==1.27.0"]
build-backend = "hatchling.build"

[project]
name = "{id}"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []

[tool.hatch.build.targets.wheel]
packages = ["src/{package}"]
"#,
		id = args.id,
	);
	let parsed = DeploymentManifest::parse(&manifest).map_err(extension_failure)?;
	parsed.validate().map_err(extension_failure)?;
	let source = r#"import omp


@omp.tool(kind="hard")
async def hello(name: str = "world") -> str:
    """Return a greeting from the linked extension."""
    return f"Hello, {name}!"


@omp.hook("extension_activate")
async def activated(event, ctx: omp.Context) -> None:
    """Observe activation without changing core behavior."""
"#;
	fs::create_dir_all(root.join("src").join(&package)).into_diagnostic()?;
	fs::write(root.join("omp.toml"), manifest).into_diagnostic()?;
	fs::write(root.join("pyproject.toml"), pyproject).into_diagnostic()?;
	fs::write(root.join("src").join(&package).join("__init__.py"), source).into_diagnostic()?;
	println!("created {}; link it with `omp ext link {}`", root.display(), root.display());
	Ok(())
}

fn link(state: &StatePaths, args: ExtLinkArgs, json: bool) -> miette::Result<()> {
	let path = args.path.canonicalize().into_diagnostic()?;
	let manifest = read_development_manifest(&path)?;
	let id = args.name.unwrap_or_else(|| manifest.id.clone());
	let mut source = map::Map::new();
	source.insert("link".to_owned(), toml::Value::String(path.display().to_string()));
	let mut installed = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	let selection = match args.features.as_deref() {
		None => FeatureSelection::Absent,
		Some(features) if features.trim().is_empty() => FeatureSelection::None,
		Some("*") => FeatureSelection::All,
		Some(features) => FeatureSelection::Named(csv(features)),
	};
	let previous = installed
		.extensions
		.iter()
		.find(|entry| entry.id == id)
		.map(|entry| entry.features.as_slice());
	let features =
		concrete_features(&selection, &manifest.features, previous).map_err(extension_failure)?;
	let requirements = manifest
		.project(&features)
		.map_err(extension_failure)?
		.requires;
	upsert_installed(&mut installed, InstalledExtension {
		id: id.clone(),
		features,
		source: toml::Value::Table(source),
		tier: tier(args.tier),
		enabled: true,
	});
	installed.write(&state.client_installed).into_diagnostic()?;
	if json {
		println!(
			"{}",
			serde_json::json!({
				"action": "link",
				"id": id,
				"path": path,
				"tier": args.tier,
				"requires": requirements,
				"applied": true,
			})
		);
	} else {
		println!("linked {id}");
	}
	if !args.no_resolve && !requirements.is_empty() {
		eprintln!(
			"warning: linked extension {id} has unresolved requirements: {}; run `omp ext resolve \
			 {}` before launching it",
			requirements
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>()
				.join(", "),
			requirements
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>()
				.join(" ")
		);
	}
	Ok(())
}

fn unlink(state: &StatePaths, id: &str, json: bool) -> miette::Result<()> {
	let mut installed = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	let before = installed.extensions.len();
	installed.extensions.retain(|entry| {
		!(entry.id == id
			&& entry
				.source
				.as_table()
				.is_some_and(|source| source.contains_key("link")))
	});
	if before == installed.extensions.len() {
		return Err(miette!("extension {id} is not linked"));
	}
	installed.write(&state.client_installed).into_diagnostic()?;
	if json {
		println!("{}", serde_json::json!({"action": "unlink", "id": id, "applied": true}));
	} else {
		println!("unlinked {id}");
	}
	Ok(())
}

pub(crate) fn enable(state: &StatePaths, id: &str, enabled: bool) -> miette::Result<()> {
	let mut installed = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	if enabled && state.client_lock.exists() {
		let lock = LockFile::read(&state.client_lock, state.layer).map_err(extension_failure)?;
		if let Some(extension) = lock.extensions.iter().find(|extension| extension.id == id) {
			let grants = GrantsFile::read(&state.grants).map_err(extension_failure)?;
			let workspace = (state.layer == BackendLayer::Workspace).then_some(&state.workspace);
			if !grant_covers(
				&grants,
				&extension.id,
				&extension.publisher,
				state.layer,
				workspace,
				&extension.capability_digest,
				extension.tier,
				&extension.ship,
			) {
				return Err(miette!("no exact operator grant admits extension {id}"));
			}
		}
	}
	set_enabled(&mut installed, id, enabled).map_err(extension_failure)?;
	installed.write(&state.client_installed).into_diagnostic()?;
	Ok(())
}

fn features(_state: &StatePaths, args: ExtFeaturesArgs) -> miette::Result<()> {
	if args.list {
		println!("{}: manifest-defined features are resolved into omp.lock", args.id);
		return Ok(());
	}
	Err(miette!("feature mutations require a fresh explicit resolve for {}", args.id))
}
fn lock(state: &StatePaths, args: ExtLockArgs) -> miette::Result<()> {
	let mut lock = read_lock_or_empty(&state.client_lock, state.layer)?;
	if !args.targets.is_empty() {
		lock.targets = args.targets;
		lock.targets.sort();
		lock.targets.dedup();
	}
	lock
		.validate_for(state.layer)
		.map_err(|error| miette!("{error}"))?;
	if let Some(path) = args.export_pylock {
		lock.export_pylock(&path).into_diagnostic()?;
	}
	if args.check {
		println!("lock is valid");
		return Ok(());
	}
	lock.write(&state.client_lock).into_diagnostic()
}
async fn resolve(
	state: &StatePaths,
	args: ExtResolveArgs,
	uv: Option<PathBuf>,
	indexes: Vec<Str>,
	exclude_newer: Option<Str>,
	default_targets: Vec<Str>,
	locked: bool,
	missing_source: MissingSourcePolicy,
) -> miette::Result<()> {
	validate_specs(&args.specs)?;
	let targets = if !args.target.is_empty() {
		args.target
	} else if !default_targets.is_empty() {
		default_targets
	} else {
		vec![Str::new(default_resolution_target())]
	};
	let mut requirements = args
		.specs
		.iter()
		.enumerate()
		.map(|(ordinal, spec)| {
			let source = SourceSpec::parse(spec).map_err(extension_failure)?;
			Ok(source_requirement(source, missing_source)?.map(|requirement| ResolveRequirement {
				extension_id: Str::new(format!("root-{ordinal}")),
				requirement,
			}))
		})
		.collect::<miette::Result<Vec<_>>>()?
		.into_iter()
		.flatten()
		.collect::<Vec<_>>();
	if requirements.is_empty() {
		println!("all unavailable extension sources were skipped");
		return Ok(());
	}
	if args.as_if_local {
		for (path, layer) in [
			(&state.client_lock, BackendLayer::Client),
			(&state.workspace_lock, BackendLayer::Workspace),
		] {
			if !path.exists() {
				continue;
			}
			let lock = LockFile::read(path, layer).map_err(extension_failure)?;
			for extension in lock.extensions {
				for requirement in extension.requires {
					requirements
						.push(ResolveRequirement { extension_id: extension.id.clone(), requirement });
				}
			}
		}
		requirements.sort_by(|left, right| {
			left
				.extension_id
				.cmp(&right.extension_id)
				.then(left.requirement.cmp(&right.requirement))
		});
		requirements.dedup();
	}
	let requirements_root = state.generations.join(".resolve");
	fs::create_dir_all(&requirements_root).into_diagnostic()?;
	let requirements_file = requirements_root.join(format!("{}.txt", omp_core::Ulid::generate()));
	write_resolve_requirements(&requirements_file, &requirements)?;
	let index_urls: Vec<String> = if indexes.is_empty() {
		read_index_config(state)?
			.entries
			.into_iter()
			.map(|entry| entry.url)
			.collect()
	} else {
		indexes.into_iter().map(|value| value.to_string()).collect()
	};
	let plan = ResolvePlan::build(
		uv.clone().unwrap_or_else(|| PathBuf::from("uv")),
		&requirements,
		&targets,
		index_urls.clone(),
		exclude_newer.clone(),
		state.offline != OfflineMode::Online,
		requirements_file.clone(),
	)
	.map_err(extension_failure)?;
	if args.explain {
		for argv in plan.explain() {
			println!(
				"{}",
				argv
					.into_iter()
					.map(|argument| argument.to_string_lossy().into_owned())
					.collect::<Vec<_>>()
					.join(" ")
			);
		}
	}
	let existing = read_lock_or_empty(&state.client_lock, state.layer)?;
	let frozen = existing
		.frozen
		.iter()
		.map(|distribution| (distribution.name.as_str(), distribution.version.as_str()))
		.collect::<Vec<_>>();
	let resolution = tokio::select! {
		result = plan.run_system(&frozen) => result,
		_ = tokio::signal::ctrl_c() => {
			let _ = fs::remove_file(&requirements_file);
			for request in &plan.requests {
				let _ = fs::remove_file(&request.output_file);
			}
			return Err(extension_interrupt());
		},
	};
	let outcomes = match resolution {
		Ok(outcomes) => outcomes,
		Err(error) if args.minimal_core => {
			let core = minimal_unsat_core(&requirements, 32, |candidate| {
				write_resolve_requirements(&requirements_file, candidate).is_err()
					|| ResolvePlan::build(
						uv.clone().unwrap_or_else(|| PathBuf::from("uv")),
						candidate,
						&targets,
						index_urls.clone(),
						exclude_newer.clone(),
						state.offline != OfflineMode::Online,
						requirements_file.clone(),
					)
					.is_ok_and(|candidate_plan| candidate_plan.run(&SystemUv, &frozen).is_err())
			});
			let _ = fs::remove_file(&requirements_file);
			eprintln!(
				"minimal unsatisfiable roots: {}",
				core
					.iter()
					.map(|requirement| requirement.extension_id.as_str())
					.collect::<Vec<_>>()
					.join(", ")
			);
			return Err(extension_failure(error));
		},
		Err(error) => {
			let _ = fs::remove_file(&requirements_file);
			for request in &plan.requests {
				let _ = fs::remove_file(&request.output_file);
			}
			return Err(extension_failure(error));
		},
	};
	let _ = fs::remove_file(&requirements_file);
	let mut resolved = read_lock_or_empty(&state.client_lock, state.layer)?;
	resolved.generated_by = "omp ext resolve".to_owned();
	resolved.generated_at = jiff::Timestamp::now().to_string();
	resolved.targets.clear();
	resolved.packages.clear();
	resolved.indexes = index_urls;
	resolved.exclude_newer = exclude_newer;
	for (target, outcome) in targets.iter().zip(outcomes) {
		let mut target_lock = resolved.clone();
		target_lock.targets = vec![target.clone()];
		target_lock.packages = parse_uv_compile(&outcome.stdout)?;
		if resolved.targets.is_empty() {
			resolved = target_lock;
		} else {
			resolved
				.union_target(&target_lock)
				.map_err(extension_failure)?;
		}
	}
	resolved.targets.sort();
	resolved
		.packages
		.sort_by(|left, right| left.name.cmp(&right.name));
	if locked {
		let existing_digest = existing.resolution_digest().map_err(extension_failure)?;
		let resolved_digest = resolved.resolution_digest().map_err(extension_failure)?;
		if existing_digest != resolved_digest {
			return Err(extension_failure(omp_ext::ExtensionError::new(
				omp_ext::ExtensionCode::ELockDrift,
				"resolution would change the locked extension closure",
			)));
		}
		return Ok(());
	}
	println!(
		"resolved {} package(s) for {} target(s); no state written",
		resolved.packages.len(),
		targets.len()
	);
	Ok(())
}

fn source_requirement(
	source: SourceSpec,
	missing_source: MissingSourcePolicy,
) -> miette::Result<Option<Str>> {
	Ok(Some(match source {
		SourceSpec::Index { distribution, .. } | SourceSpec::Pypi { distribution } => distribution,
		SourceSpec::Git { repository, revision, subdirectory } => {
			let mut requirement = format!("git+{repository}@{revision}");
			if let Some(subdirectory) = subdirectory {
				requirement.push_str("#subdirectory=");
				requirement.push_str(&subdirectory.to_string_lossy());
			}
			Str::new(requirement)
		},
		SourceSpec::Path(path) => {
			if !path.exists() {
				return match missing_source.outcome() {
					MissingSourceOutcome::Skip => Ok(None),
					MissingSourceOutcome::Install => Err(miette!(
						"missing local extension source cannot be installed: {}",
						path.display()
					)),
					MissingSourceOutcome::Error => {
						Err(miette!("missing extension source: {}", path.display()))
					},
				};
			}
			Str::new(path.canonicalize().into_diagnostic()?.display().to_string())
		},
		SourceSpec::Url { url, sha256 } => Str::new(format!("{url}#sha256={sha256}")),
	}))
}

fn default_resolution_target() -> &'static str {
	if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
		"aarch64-apple-darwin"
	} else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
		"x86_64-apple-darwin"
	} else if cfg!(all(target_arch = "aarch64", target_os = "linux")) {
		"aarch64-unknown-linux-gnu"
	} else {
		"x86_64-unknown-linux-gnu"
	}
}

fn write_resolve_requirements(
	path: &Path,
	requirements: &[ResolveRequirement],
) -> miette::Result<()> {
	let mut input = String::new();
	for requirement in requirements {
		input.push_str(requirement.requirement.as_str());
		input.push('\n');
	}
	fs::write(path, input).into_diagnostic()
}

fn parse_uv_compile(bytes: &[u8]) -> miette::Result<Vec<LockedPackage>> {
	#[derive(serde::Deserialize)]
	struct PyLock {
		#[serde(default)]
		packages: Vec<Package>,
	}
	#[derive(serde::Deserialize)]
	struct Package {
		name:    Str,
		version: Str,
		#[serde(default)]
		wheels:  Vec<PyLockWheel>,
	}
	#[derive(serde::Deserialize)]
	struct PyLockWheel {
		url: String,
	}
	let lock: PyLock =
		toml::from_str(std::str::from_utf8(bytes).into_diagnostic()?).into_diagnostic()?;
	let mut packages = lock
		.packages
		.into_iter()
		.map(|package| LockedPackage {
			name:         Str::new(omp_ext::resolver::normalize_distribution_name(
				package.name.as_str(),
			)),
			version:      package.version,
			index:        package
				.wheels
				.first()
				.map_or_else(String::new, |wheel| wheel.url.clone()),
			requested_by: Vec::new(),
			marker:       String::new(),
			wheels:       Vec::new(),
		})
		.collect::<Vec<_>>();
	packages.sort_by(|left, right| left.name.cmp(&right.name));
	Ok(packages)
}

async fn upgrade(
	state: &StatePaths,
	args: ExtUpgradeArgs,
	uv: Option<PathBuf>,
) -> miette::Result<()> {
	if let Some(generation) = args.rollback {
		let previous =
			omp_ext::upgrade::load_generation(&state.generations, &generation, state.layer)
				.map_err(extension_failure)?;
		if args.dry_run {
			println!("would roll back to {generation}");
			return Ok(());
		}
		omp_ext::upgrade::commit_generation(
			&state.client_lock,
			&state.client_installed,
			&state.generations,
			"rollback",
			&previous,
		)
		.map_err(|error| miette!("{error}"))?;
		return Ok(());
	}
	let installed = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	let ids = if args.ids.is_empty() {
		installed
			.extensions
			.iter()
			.map(|entry| entry.id.clone())
			.collect::<Vec<_>>()
	} else {
		args.ids
	};
	let key = fs::read_to_string(&state.index_key).into_diagnostic()?;
	let catalog = SignedIndex::read(&state.index_snapshot, key.trim()).map_err(extension_failure)?;
	let lock = read_lock_or_empty(&state.client_lock, state.layer)?;
	for id in ids {
		let extension = catalog
			.extensions
			.iter()
			.find(|extension| extension.id == id)
			.ok_or_else(|| miette!("extension {id} is absent from the signed index"))?;
		let release = match args.to.as_ref() {
			Some(version) => extension
				.releases
				.iter()
				.find(|release| release.version == *version && !release.yanked),
			None => catalog.latest_release(extension, false),
		}
		.ok_or_else(|| miette!("no eligible release for {id}"))?;
		let previous = lock.extensions.iter().find(|locked| locked.id == id);
		if previous.is_some_and(|previous| previous.version == release.version) {
			continue;
		}
		let concrete = installed
			.extensions
			.iter()
			.find(|entry| entry.id == id)
			.map(|entry| entry.features.as_slice())
			.unwrap_or_default();
		let manifest = release.deployment_manifest();
		let projection = manifest.project(concrete).map_err(extension_failure)?;
		let next_capability_digest = if release.features.is_empty()
			&& release.capabilities.is_empty()
			&& release.declarations.is_empty()
		{
			release.capability_digest.clone()
		} else {
			projection.capability_digest
		};
		if let Some(previous) = previous
			&& previous.capability_digest != next_capability_digest
			&& !args.allow_capability_widening
		{
			return Err(miette!(
				"{} changes its capability digest; pass --allow-capability-widening after review",
				id
			));
		}
		install(
			state,
			ExtInstallArgs {
				specs:          vec![Str::new(format!(
					"index:{}/{}@{}",
					catalog.name, id, release.version
				))],
				tier:           Tier::Sandboxed,
				pool:           None,
				features:       None,
				capabilities:   None,
				yes:            args.allow_capability_widening,
				dry_run:        args.dry_run,
				no_preresolved: false,
				target:         lock.targets.clone(),
				no_lock:        false,
				force:          true,
			},
			uv.clone(),
			None,
			false,
		)
		.await?;
	}
	Ok(())
}

fn pin(state: &StatePaths, id: Str, version: Str) -> miette::Result<()> {
	let mut pins = PinsFile::read(&state.pins).map_err(extension_failure)?;
	pins.set(&state.pins, id, version).into_diagnostic()
}

fn unpin(state: &StatePaths, id: &str) -> miette::Result<()> {
	let mut pins = PinsFile::read(&state.pins).map_err(extension_failure)?;
	if !pins.remove(&state.pins, id).into_diagnostic()? {
		return Err(miette!("extension {id} is not pinned"));
	}
	Ok(())
}

fn gc(state: &StatePaths, args: ExtGcArgs) -> miette::Result<()> {
	let report = gc_generations(&state.generations, args.keep_generations, args.apply)
		.map_err(extension_failure)?;
	println!("{} generation(s), {} bytes", report.generations.len(), report.bytes);
	Ok(())
}

struct CliHealth;
impl RuntimeHealth for CliHealth {
	fn environment_ready(&self) -> bool {
		true
	}

	fn credential_health(&self, _extension_id: &str) -> CredentialHealth {
		CredentialHealth::NotRequired
	}
}

fn doctor(state: &StatePaths, args: ExtDoctorArgs) -> miette::Result<()> {
	let foreign_roots = [".claude", ".codex", ".gemini"]
		.into_iter()
		.map(|name| state.project.join(name))
		.collect::<Vec<_>>();
	let request = DoctorRequest {
		layer:                 state.layer,
		lock_path:             &state.client_lock,
		installed_path:        &state.client_installed,
		keys_path:             &state.keys,
		grants_path:           &state.grants,
		workspace:             (state.layer == BackendLayer::Workspace).then_some(&state.workspace),
		revocations_path:      state
			.revocations
			.exists()
			.then_some(state.revocations.as_path()),
		site_root:             &state.sites,
		artifact_store:        &state.store,
		ambient_site_override: state.site_override.as_deref(),
		foreign_roots:         &foreign_roots,
		fix:                   args.fix,
	};
	let findings = diagnose(&request, &CliHealth);
	for finding in &findings {
		match finding.code {
			Some(code) => println!("{:?} {code}: {}", finding.severity, finding.detail),
			None => println!("{:?}: {}", finding.severity, finding.detail),
		}
	}
	if findings
		.iter()
		.any(|finding| finding.severity == DoctorSeverity::Error)
	{
		return Err(miette!("extension doctor found integrity failures"));
	}
	Ok(())
}
async fn bundle(state: &StatePaths, args: ExtBundleArgs) -> miette::Result<()> {
	let lock = fs::read(&state.client_lock).into_diagnostic()?;
	let files = vec![BundleFile {
		path:     Str::new_static("locks/omp.lock"),
		contents: bytes::Bytes::from(lock),
	}];
	let encoded = pack_airgap_bundle(args.targets, files)?;
	if let Some(parent) = args.output.parent() {
		fs::create_dir_all(parent).into_diagnostic()?;
	}
	fs::write(args.output, encoded).into_diagnostic()
}
fn trust(state: &StatePaths, args: ExtTrustArgs) -> miette::Result<()> {
	let mut grants = GrantsFile::read(&state.grants).map_err(extension_failure)?;
	if args.show {
		let keys = KeysFile::read(&state.keys).map_err(extension_failure)?;
		let key = keys
			.keys
			.iter()
			.find(|pin| pin.id == args.id)
			.map(|pin| pin.key.as_str())
			.unwrap_or("-");
		let matching = grants
			.grants
			.iter()
			.filter(|grant| grant.id == args.id)
			.collect::<Vec<_>>();
		if matching.is_empty() {
			println!("{} ungranted key={key}", args.id);
		} else {
			for grant in matching {
				println!(
					"{} layer={} tier={} ship={} capability={} publisher={} key={}",
					grant.id,
					grant.layer,
					grant.tier,
					grant.ship,
					grant.capability_digest,
					grant.publisher,
					key,
				);
			}
		}
		return Ok(());
	}
	if args.revoke {
		grants.grants.retain(|grant| grant.id != args.id);
		grants.write(&state.grants).into_diagnostic()?;
		return Ok(());
	}
	if args.ship == Some(Ship::Pickle) {
		let tier_after = args.tier.map(tier);
		if !grants
			.grants
			.iter()
			.filter(|grant| grant.id == args.id)
			.all(|grant| tier_after.unwrap_or(grant.tier) == omp_ext::TrustTier::Trusted)
		{
			return Err(miette!("pickle shipping requires the trusted extension tier"));
		}
	}
	let mut changed = false;
	if let Some(selected_tier) = args.tier {
		for (installed_path, lock_path, layer) in [
			(&state.client_installed, &state.client_lock, BackendLayer::Client),
			(&state.workspace_installed, &state.workspace_lock, BackendLayer::Workspace),
		] {
			let mut installed = InstalledRecord::read(installed_path).map_err(extension_failure)?;
			let mut installed_changed = false;
			for entry in installed
				.extensions
				.iter_mut()
				.filter(|entry| entry.id == args.id)
			{
				entry.tier = tier(selected_tier);
				installed_changed = true;
			}
			if installed_changed {
				installed.write(installed_path).into_diagnostic()?;
				if lock_path.exists() {
					let mut lock = LockFile::read(lock_path, layer).map_err(extension_failure)?;
					if let Some(extension) = lock.extensions.iter_mut().find(|entry| entry.id == args.id)
					{
						extension.tier = tier(selected_tier);
						lock.write(lock_path).into_diagnostic()?;
					}
				}
				changed = true;
			}
		}
	}
	for grant in grants.grants.iter_mut().filter(|grant| grant.id == args.id) {
		if let Some(selected_tier) = args.tier {
			grant.tier = tier(selected_tier);
			changed = true;
		}
		if let Some(ship) = args.ship {
			grant.ship = Str::new(<&'static str>::from(ship));
			changed = true;
		}
	}
	if let Some(key) = args.key {
		let version = [&state.client_lock, &state.workspace_lock]
			.into_iter()
			.filter(|path| path.exists())
			.find_map(|path| {
				let layer = if path == &state.workspace_lock {
					BackendLayer::Workspace
				} else {
					BackendLayer::Client
				};
				LockFile::read(path, layer)
					.ok()
					.and_then(|lock| {
						lock
							.extensions
							.into_iter()
							.find(|extension| extension.id == args.id)
					})
					.map(|extension| extension.version)
			})
			.unwrap_or_else(|| Str::new_static("manual"));
		let mut keys = KeysFile::read(&state.keys).map_err(extension_failure)?;
		changed |= keys
			.accept_operator_key(
				&args.id,
				&key,
				&version,
				&Str::new(jiff::Timestamp::now().to_string()),
			)
			.map_err(extension_failure)?;
		keys.write(&state.keys).into_diagnostic()?;
	}
	if !changed {
		return Err(miette!("no trust mutation was requested for {}", args.id));
	}
	grants.write(&state.grants).into_diagnostic()
}

async fn verify(state: &StatePaths, args: ExtVerifyArgs) -> miette::Result<()> {
	let verify_all = !args.deep && !args.signatures && !args.revocations;
	let deep = args.deep || verify_all;
	let signatures = args.signatures || verify_all;
	let revocations = args.revocations || verify_all && state.revocations.exists();
	let lock = LockFile::read(&state.client_lock, state.layer).map_err(extension_failure)?;
	let selected = lock
		.extensions
		.iter()
		.filter(|extension| args.ids.is_empty() || args.ids.contains(&extension.id))
		.collect::<Vec<_>>();
	for id in &args.ids {
		if !selected.iter().any(|extension| extension.id == *id) {
			return Err(miette!("extension {id} is not locked"));
		}
	}
	if signatures && !selected.is_empty() {
		let catalog = read_catalog_for_verify(state)?;
		let keys = KeysFile::read(&state.keys).map_err(extension_failure)?;
		for extension in &selected {
			let (indexed, release) = catalog
				.release(extension.id.as_str(), extension.version.as_str())
				.ok_or_else(|| {
					miette!(
						"{} {} is absent or yanked in the current signed index",
						extension.id,
						extension.version
					)
				})?;
			let manifest = release.deployment_manifest();
			let projection = manifest
				.project(&extension.features)
				.map_err(extension_failure)?;
			let effective_capability_digest = if release.features.is_empty()
				&& release.capabilities.is_empty()
				&& release.declarations.is_empty()
			{
				release.capability_digest.clone()
			} else {
				projection.capability_digest.clone()
			};
			if indexed.publisher_key != extension.publisher
				|| release.signature_capability_digest() != &extension.manifest_capability_digest
				|| effective_capability_digest != extension.capability_digest
				|| projection.declaration_digest != extension.declaration_digest
			{
				return Err(miette!(
					"signed index authority differs from the lock for {}",
					extension.id
				));
			}
			if !keys
				.keys
				.iter()
				.any(|pin| pin.id == extension.id && pin.key == extension.publisher)
			{
				return Err(miette!("publisher key for {} does not match its local pin", extension.id));
			}
			verify_artifact_signature(
				extension.publisher.as_str(),
				extension.wheel.blake3.as_str(),
				extension.wheel.sha256.as_str(),
				extension.manifest_capability_digest.as_str(),
				extension.signature.as_str(),
			)
			.map_err(extension_failure)?;
		}
	}
	if deep && !selected.is_empty() {
		for extension in &selected {
			let path = state
				.store
				.join(extension.wheel.blake3.as_str().trim_start_matches("b3:"));
			let bytes = fs::read(&path).into_diagnostic()?;
			if bytes.len() as u64 != extension.wheel.size
				|| sf!("b3:{}", blake3::hash(&bytes).to_hex()) != extension.wheel.blake3
				|| sf!("sha256:{}", hex::encode(&Sha256::digest(&bytes))) != extension.wheel.sha256
			{
				return Err(miette!("artifact bytes for {} differ from the lock", extension.id));
			}
		}
		verify_site_records(&state.sites)?;
	}
	if args.revocations {
		refresh_revocations(state).await?;
	}
	if revocations {
		verify_revocations(state, &selected)?;
	}
	println!("verified {} locked extension(s)", selected.len());
	Ok(())
}

fn read_catalog_for_verify(state: &StatePaths) -> miette::Result<SignedIndex> {
	let key = fs::read_to_string(&state.index_key).into_diagnostic()?;
	SignedIndex::read(&state.index_snapshot, key.trim()).map_err(extension_failure)
}

fn verify_site_records(site_root: &Path) -> miette::Result<()> {
	if !site_root.exists() {
		return Err(miette!("materialized extension site root is unavailable"));
	}
	let mut pending = vec![site_root.to_path_buf()];
	let mut records = Vec::new();
	while let Some(directory) = pending.pop() {
		for entry in fs::read_dir(&directory).into_diagnostic()? {
			let entry = entry.into_diagnostic()?;
			let metadata = fs::symlink_metadata(entry.path()).into_diagnostic()?;
			if metadata.file_type().is_symlink() {
				return Err(miette!("materialized site contains a symbolic link"));
			}
			if metadata.is_dir() {
				pending.push(entry.path());
			} else if entry.file_name().to_string_lossy() == "RECORD"
				&& entry
					.path()
					.parent()
					.and_then(Path::file_name)
					.is_some_and(|parent| parent.to_string_lossy().ends_with(".dist-info"))
			{
				records.push(entry.path());
			}
		}
	}
	if records.is_empty() {
		return Err(miette!("materialized extension site contains no wheel RECORD"));
	}
	for record in records {
		let distribution_root = record
			.parent()
			.and_then(Path::parent)
			.ok_or_else(|| miette!("wheel RECORD has no distribution root"))?;
		for row in fs::read_to_string(&record).into_diagnostic()?.lines() {
			let fields = parse_record_row(row)?;
			let Some(hash) = fields.get(1).filter(|hash| !hash.is_empty()) else {
				continue;
			};
			let encoded = hash
				.strip_prefix("sha256=")
				.ok_or_else(|| miette!("wheel RECORD uses an unsupported hash"))?;
			let mut standard = encoded.replace('-', "+").replace('_', "/");
			while standard.len() % 4 != 0 {
				standard.push('=');
			}
			let expected = base64::decode(standard.as_bytes())
				.into_vec()
				.map_err(|_| miette!("wheel RECORD contains invalid base64"))?;
			let relative = fields
				.first()
				.ok_or_else(|| miette!("wheel RECORD row has no path"))?;
			let candidate = distribution_root.join(relative);
			let canonical_root = distribution_root.canonicalize().into_diagnostic()?;
			let candidate = candidate.canonicalize().into_diagnostic()?;
			if !candidate.starts_with(&canonical_root) {
				return Err(miette!("wheel RECORD path escapes the site tree"));
			}
			if Sha256::digest(fs::read(candidate).into_diagnostic()?).as_slice() != expected.as_slice()
			{
				return Err(miette!("materialized file differs from wheel RECORD"));
			}
		}
	}
	Ok(())
}

fn parse_record_row(row: &str) -> miette::Result<Vec<String>> {
	let mut fields = Vec::with_capacity(3);
	let mut field = String::new();
	let mut characters = row.chars().peekable();
	let mut quoted = false;
	while let Some(character) = characters.next() {
		match character {
			'"' if quoted && characters.peek() == Some(&'"') => {
				field.push('"');
				characters.next();
			},
			'"' => quoted = !quoted,
			',' if !quoted && fields.len() < 2 => {
				fields.push(std::mem::take(&mut field));
			},
			_ => field.push(character),
		}
	}
	if quoted {
		return Err(miette!("wheel RECORD contains an unterminated quote"));
	}
	fields.push(field);
	if fields.len() != 3 {
		return Err(miette!("wheel RECORD row does not have three columns"));
	}
	Ok(fields)
}

async fn refresh_revocations(state: &StatePaths) -> miette::Result<()> {
	let source = read_index_config(state)?
		.entries
		.into_iter()
		.next()
		.ok_or_else(|| miette!("no signed index is configured for revocation refresh"))?;
	let (prefix, _) = source
		.url
		.rsplit_once('/')
		.ok_or_else(|| miette!("signed index URL has no revocation metadata directory"))?;
	let url = format!("{prefix}/revocations.json");
	let bytes = service::fetch_index(&url).await?;
	let parent = state
		.revocations
		.parent()
		.ok_or_else(|| miette!("revocation path has no parent"))?;
	fs::create_dir_all(parent).into_diagnostic()?;
	let staged = state.revocations.with_extension("json.tmp");
	fs::write(&staged, bytes).into_diagnostic()?;
	let key = fs::read_to_string(&state.index_key).into_diagnostic()?;
	let revocations = RevocationsFile::read(&staged).map_err(|error| miette!("{error}"))?;
	if let Err(error) = revocations.verify(key.trim()) {
		let _ = fs::remove_file(staged);
		return Err(miette!("{error}"));
	}
	if !matches!(
		revocations.freshness(&jiff::Timestamp::now().to_string(), true),
		RevocationFreshness::Fresh
	) {
		let _ = fs::remove_file(staged);
		return Err(miette!("refreshed revocation snapshot is not current"));
	}
	fs::rename(staged, &state.revocations).into_diagnostic()
}

fn verify_revocations(state: &StatePaths, extensions: &[&LockedExtension]) -> miette::Result<()> {
	if !state.revocations.exists() {
		return Err(miette!("signed revocation snapshot is unavailable"));
	}
	let key = fs::read_to_string(&state.index_key).into_diagnostic()?;
	let revocations =
		RevocationsFile::read(&state.revocations).map_err(|error| miette!("{error}"))?;
	revocations
		.verify(key.trim())
		.map_err(|error| miette!("{error}"))?;
	match revocations.freshness(&jiff::Timestamp::now().to_string(), true) {
		RevocationFreshness::Fresh => {},
		RevocationFreshness::Warn(code) | RevocationFreshness::Reject(code) => {
			return Err(extension_failure(omp_ext::ExtensionError::new(
				code,
				"signed revocation snapshot is stale",
			)));
		},
	}
	for extension in extensions {
		if let Some(revocation) = revocations
			.revocation_for(&extension.id, &extension.version)
			.map_err(|error| miette!("{error}"))?
		{
			return Err(miette!(
				"{} {} is revoked: {} ({})",
				extension.id,
				extension.version,
				revocation.reason,
				revocation.advisory
			));
		}
	}
	Ok(())
}
fn publish(args: ExtPublishArgs) -> miette::Result<()> {
	let wheel = args
		.wheel
		.ok_or_else(|| miette!("publish validation requires a wheel path"))?;
	let metadata = fs::metadata(&wheel).into_diagnostic()?;
	if !metadata.is_file()
		|| wheel.extension().and_then(|extension| extension.to_str()) != Some("whl")
	{
		return Err(miette!("publish input must be a wheel"));
	}
	println!("validated {} ({} bytes)", wheel.display(), metadata.len());
	if !args.dry_run {
		return Err(miette!("publishing requires a configured signed index upload authority"));
	}
	Ok(())
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
struct IndexConfig {
	#[serde(default, rename = "index")]
	entries: Vec<IndexConfigEntry>,
}
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct IndexConfigEntry {
	name: Str,
	url:  String,
}

fn read_index_config(state: &StatePaths) -> miette::Result<IndexConfig> {
	if state.indexes.exists() {
		toml::from_str::<IndexConfig>(&fs::read_to_string(&state.indexes).into_diagnostic()?)
			.into_diagnostic()
	} else {
		Ok(IndexConfig::default())
	}
}

fn upsert_index(state: &StatePaths, entry: IndexConfigEntry, first: bool) -> miette::Result<()> {
	let mut config = read_index_config(state)?;
	config.entries.retain(|current| current.name != entry.name);
	if first {
		config.entries.insert(0, entry);
	} else {
		config.entries.push(entry);
	}
	write_toml(&state.indexes, &config)
}

fn remove_index(state: &StatePaths, name: &str) -> miette::Result<()> {
	let mut config = read_index_config(state)?;
	let before = config.entries.len();
	config.entries.retain(|entry| entry.name != name);
	if before == config.entries.len() {
		return Err(miette!("index {name} is unknown"));
	}
	write_toml(&state.indexes, &config)
}

fn index(state: &StatePaths, args: ExtIndexArgs) -> miette::Result<()> {
	match args.command {
		ExtIndexCommand::Add { name, url, first } => {
			upsert_index(state, IndexConfigEntry { name, url: url.to_string() }, first)?;
		},
		ExtIndexCommand::Remove { name } => remove_index(state, name.as_str())?,
		ExtIndexCommand::List => {
			for entry in read_index_config(state)?.entries {
				println!("{} {}", entry.name, entry.url);
			}
		},
	}
	Ok(())
}

fn search(state: &StatePaths, args: ExtSearchArgs) -> miette::Result<()> {
	for package in service::catalog_packages(
		state,
		args.query.as_str(),
		args.capability.as_deref(),
		args.attested,
		args.limit,
	)? {
		println!("{} {} {}", package.id, package.version, package.description);
	}
	Ok(())
}

fn where_paths(state: &StatePaths, args: ExtWhereArgs, json: bool) -> miette::Result<()> {
	let client = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	let workspace = InstalledRecord::read(&state.workspace_installed).map_err(extension_failure)?;
	let entries = client
		.extensions
		.into_iter()
		.map(|entry| (Scope::User, entry))
		.chain(
			workspace
				.extensions
				.into_iter()
				.map(|entry| (Scope::Project, entry)),
		)
		.filter(|(_, entry)| args.id.as_ref().is_none_or(|id| *id == entry.id))
		.collect::<Vec<_>>();
	let common = serde_json::json!({
		"store": state.store,
		"sites": state.sites,
		"artifacts": state.artifacts,
		"clientLock": state.client_lock,
		"workspaceLock": state.workspace_lock,
		"clientInstalled": state.client_installed,
		"workspaceInstalled": state.workspace_installed,
		"grants": state.grants,
		"keys": state.keys,
	});
	if json {
		println!(
			"{}",
			serde_json::to_string_pretty(&serde_json::json!({
				"paths": common,
				"extensions": entries
					.iter()
					.map(|(scope, entry)| {
						serde_json::json!({"id": entry.id, "scope": scope, "source": entry.source})
					})
					.collect::<Vec<_>>(),
			}))
			.into_diagnostic()?
		);
	} else {
		println!("store {}", state.store.display());
		println!("sites {}", state.sites.display());
		println!("artifacts {}", state.artifacts.display());
		println!("client-lock {}", state.client_lock.display());
		println!("workspace-lock {}", state.workspace_lock.display());
		println!("client-installed {}", state.client_installed.display());
		println!("workspace-installed {}", state.workspace_installed.display());
		println!("grants {}", state.grants.display());
		println!("keys {}", state.keys.display());
		for (scope, entry) in entries {
			println!("{} {} {}", entry.id, scope, entry.source);
		}
	}
	Ok(())
}

#[derive(Clone)]
pub(crate) struct StatePaths {
	project:             PathBuf,
	project_state:       PathBuf,
	client_installed:    PathBuf,
	workspace_installed: PathBuf,
	client_lock:         PathBuf,
	workspace_lock:      PathBuf,
	grants:              PathBuf,
	keys:                PathBuf,
	pins:                PathBuf,
	revocations:         PathBuf,
	generations:         PathBuf,
	sites:               PathBuf,
	artifacts:           PathBuf,
	indexes:             PathBuf,
	index_snapshot:      PathBuf,
	index_key:           PathBuf,
	marketplaces:        PathBuf,
	marketplace_cache:   PathBuf,
	user_plugins:        PathBuf,
	project_plugins:     PathBuf,
	store:               PathBuf,
	site_override:       Option<PathBuf>,
	offline:             OfflineMode,
	workspace:           omp_ext::WorkspaceUri,
	layer:               BackendLayer,
}

impl StatePaths {
	pub(crate) fn new(data_dir: &Path, project: &Path) -> Self {
		let project = project
			.canonicalize()
			.unwrap_or_else(|_| project.to_path_buf());
		let project_state =
			omp_env::project_state::directory(data_dir, &project).unwrap_or_else(|_| {
				data_dir.join("projects").join(
					Hash32::sum(project.as_os_str().as_encoded_bytes())
						.to_hex()
						.as_str(),
				)
			});
		let workspace_uri = url::Url::from_directory_path(&project)
			.map(|url| url.to_string())
			.unwrap_or_else(|()| sf!("file://{}", project.display()).to_string());
		let workspace_identity = omp_ext::WorkspaceUri {
			digest: sf!("b3:{}", blake3::hash(workspace_uri.as_bytes()).to_hex()),
			uri:    Str::new(workspace_uri),
		};
		let workspace = project.join(".omp");
		Self {
			project:             project.clone(),
			project_state:       project_state.clone(),
			client_installed:    data_dir.join("ext/installed.toml"),
			workspace_installed: workspace.join("installed.toml"),
			client_lock:         data_dir.join("ext/omp.lock"),
			workspace_lock:      workspace.join("omp.lock"),
			grants:              data_dir.join("ext/grants.toml"),
			keys:                data_dir.join("ext/keys.toml"),
			pins:                data_dir.join("ext/pins.toml"),
			revocations:         data_dir.join("ext/revocations.json"),
			generations:         data_dir.join("ext/generations"),
			sites:               project_state.join("ext/sites"),
			artifacts:           data_dir.join("ext/cache"),
			indexes:             data_dir.join("ext/indexes.toml"),
			index_snapshot:      data_dir.join("ext/index.json"),
			index_key:           data_dir.join("ext/index.key"),
			marketplaces:        data_dir.join("marketplaces.json"),
			marketplace_cache:   data_dir.join("plugins/cache/marketplaces"),
			user_plugins:        data_dir.join("plugins"),
			project_plugins:     workspace.join("plugins"),
			store:               data_dir.join("ext/store"),
			site_override:       None,
			offline:             OfflineMode::Online,
			workspace:           workspace_identity,
			layer:               BackendLayer::Client,
		}
	}

	fn with_environment(mut self, environment: &ExtensionEnvironment) -> Self {
		if let Some(store) = &environment.store {
			self.store.clone_from(store);
		}
		if let Some(cache) = &environment.cache {
			self.artifacts.clone_from(cache);
		}
		if let Some(index_keys) = &environment.index_keys {
			self.index_key.clone_from(index_keys);
		}
		self.site_override.clone_from(&environment.site_override);
		self.offline = environment.offline;
		self
	}

	fn plugin_root(&self, scope: Scope) -> PathBuf {
		match scope {
			Scope::User => self.user_plugins.clone(),
			Scope::Project => self.project_plugins.clone(),
		}
	}

	fn plugin_registry(&self, scope: Scope) -> PathBuf {
		self.plugin_root(scope).join("installed_plugins.json")
	}

	pub(crate) fn scoped(&self, scope: Scope) -> Self {
		match scope {
			Scope::User => self.clone(),
			Scope::Project => {
				let mut state = self.clone();
				state
					.client_installed
					.clone_from(&state.workspace_installed);
				state.client_lock.clone_from(&state.workspace_lock);
				state.generations = state
					.workspace_installed
					.parent()
					.unwrap_or_else(|| Path::new("."))
					.join("ext/generations");
				state.layer = BackendLayer::Workspace;
				state
			},
		}
	}
}
async fn sync(state: &StatePaths, args: ExtSyncArgs, uv: Option<&Path>) -> miette::Result<()> {
	if let Some(bundle) = args.from {
		let bytes = fs::read(bundle).into_diagnostic()?;
		let decoded = unpack_bundle(&bytes).map_err(|error| miette!("{error}"))?;
		println!(
			"verified {} air-gap payload(s) for {} target(s)",
			decoded.files.len(),
			decoded.manifest.targets.len()
		);
		return Ok(());
	}
	if args.verify {
		verify(state, ExtVerifyArgs {
			ids:         Vec::new(),
			deep:        args.verify,
			signatures:  args.verify,
			revocations: false,
		})
		.await?;
	}
	let lock = LockFile::read(&state.client_lock, state.layer).map_err(extension_failure)?;
	if state.revocations.exists() {
		let extensions = lock.extensions.iter().collect::<Vec<_>>();
		verify_revocations(state, &extensions)?;
	}
	let catalog = read_catalog_for_verify(state)?;
	let mut installed = InstalledRecord::read(&state.client_installed).map_err(extension_failure)?;
	for locked in &lock.extensions {
		let (_, release) = catalog
			.release(locked.id.as_str(), locked.version.as_str())
			.ok_or_else(|| {
				miette!("{} {} is absent from the signed index", locked.id, locked.version)
			})?;
		let artifact = release
			.artifacts
			.iter()
			.find(|artifact| {
				artifact.blake3 == locked.wheel.blake3
					&& artifact.sha256 == locked.wheel.sha256
					&& artifact.file == locked.wheel.file
			})
			.ok_or_else(|| {
				miette!("{} {} has no lock-matching artifact", locked.id, locked.version)
			})?;
		let site_key = generation_id(locked.id.as_str(), locked.version.as_str());
		let (environment, _, site_root) =
			materialize_signed_wheel(state, uv, artifact, &site_key).await?;
		drop(environment);
		let entry = installed
			.extensions
			.iter_mut()
			.find(|entry| entry.id == locked.id)
			.ok_or_else(|| miette!("{} is locked but not installed", locked.id))?;
		let mut source = locked.source.clone();
		source
			.as_table_mut()
			.ok_or_else(|| miette!("{} has a malformed lock source", locked.id))?
			.insert("root".to_owned(), toml::Value::String(site_root.display().to_string()));
		entry.source = source;
	}
	if !lock.extensions.is_empty() {
		let encoded = toml::to_string(&lock).into_diagnostic()?;
		let generation = Generation { lock: lock.clone(), installed };
		omp_ext::upgrade::commit_generation(
			&state.client_lock,
			&state.client_installed,
			&state.generations,
			&format!("sync-{}", &Hash32::sum(encoded.as_bytes()).to_hex().as_str()[..16]),
			&generation,
		)
		.map_err(|error| miette!("{error}"))?;
	}
	println!("materialized {} locked extension(s)", lock.extensions.len());
	Ok(())
}

/// Encodes a Resolver-provided deployment snapshot as an air-gap bundle.
fn pack_airgap_bundle(targets: Vec<Str>, files: Vec<BundleFile>) -> miette::Result<bytes::Bytes> {
	pack_bundle("omp ext", targets, files).map_err(|error| miette!("{error}"))
}

fn validate_specs(specs: &[Str]) -> miette::Result<()> {
	for spec in specs {
		SourceSpec::parse_install(spec).map_err(extension_failure)?;
	}
	Ok(())
}

fn requested_features(
	args: &ExtInstallArgs,
	bracket: FeatureSelection,
) -> miette::Result<FeatureSelection> {
	let Some(value) = args.features.as_deref() else {
		return Ok(bracket);
	};
	if !matches!(bracket, FeatureSelection::Absent) {
		return Err(miette!("feature brackets and --features cannot be combined"));
	}
	let value = value.trim();
	if value.is_empty() {
		Ok(FeatureSelection::None)
	} else if value == "*" {
		Ok(FeatureSelection::All)
	} else {
		let mut names = csv(value);
		names.sort();
		names.dedup();
		Ok(FeatureSelection::Named(names))
	}
}

fn read_development_manifest(root: &Path) -> miette::Result<DeploymentManifest> {
	let path = root.join("omp.toml");
	if !path.is_file() {
		return Ok(DeploymentManifest::default());
	}
	let text = fs::read_to_string(path).into_diagnostic()?;
	let manifest = DeploymentManifest::parse(&text).map_err(extension_failure)?;
	manifest.validate().map_err(extension_failure)?;
	Ok(manifest)
}

fn installed_manifest_path(installed: &InstalledExtension) -> Option<PathBuf> {
	let source = installed.source.as_table()?;
	let root = source
		.get("root")
		.or_else(|| source.get("path"))
		.or_else(|| source.get("link"))
		.and_then(toml::Value::as_str)
		.map(PathBuf::from)?;
	let direct = root.join("omp.toml");
	if direct.is_file() {
		return Some(direct);
	}
	fs::read_dir(&root)
		.into_iter()
		.flatten()
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.find(|path| {
			path
				.file_name()
				.and_then(|name| name.to_str())
				.is_some_and(|name| name.ends_with(".dist-info"))
				&& path.join("omp.toml").is_file()
		})
		.map(|path| path.join("omp.toml"))
}

fn read_installed_manifest_value(
	installed: &InstalledExtension,
) -> miette::Result<Option<toml::Value>> {
	let Some(path) = installed_manifest_path(installed) else {
		return Ok(None);
	};
	toml::from_str(&fs::read_to_string(path).into_diagnostic()?)
		.map(Some)
		.into_diagnostic()
}

async fn install_index_source(
	state: &StatePaths,
	args: &ExtInstallArgs,
	installed: &mut InstalledRecord,
	lock: &mut LockFile,
	source: SourceSpec,
	selection: FeatureSelection,
	uv: Option<&Path>,
	grant_request: Option<&str>,
	json: bool,
) -> miette::Result<bool> {
	let SourceSpec::Index { index, distribution } = source else {
		return Err(miette!(
			"signed native installation requires index: or a local path: source; use resolve for \
			 PyPI, Git, and URL closure inspection"
		));
	};
	let (id, requested_version) = distribution
		.rsplit_once('@')
		.map_or((distribution.as_str(), None), |(id, version)| (id, Some(version)));
	let index_key = fs::read_to_string(&state.index_key).into_diagnostic()?;
	let catalog =
		SignedIndex::read(&state.index_snapshot, index_key.trim()).map_err(extension_failure)?;
	let extension = catalog
		.extensions
		.iter()
		.find(|extension| extension.id == id)
		.ok_or_else(|| miette!("{id} is absent in the signed index"))?;
	let release = if let Some(version) = requested_version {
		extension
			.releases
			.iter()
			.find(|release| release.version == version && !release.yanked)
	} else {
		catalog.latest_release(extension, false)
	}
	.ok_or_else(|| miette!("{id} has no eligible release in the signed index"))?;
	let manifest = release.deployment_manifest();
	let previous = installed
		.extensions
		.iter()
		.find(|entry| entry.id == extension.id)
		.map(|entry| entry.features.as_slice());
	let features =
		concrete_features(&selection, &manifest.features, previous).map_err(extension_failure)?;
	let projection = manifest.project(&features).map_err(extension_failure)?;
	let legacy_manifest = release.features.is_empty()
		&& release.capabilities.is_empty()
		&& release.declarations.is_empty();
	let effective_capability_digest = if legacy_manifest {
		release.capability_digest.clone()
	} else {
		projection.capability_digest.clone()
	};
	ensure_not_revoked(state, &extension.id, &release.version)?;
	let target = if let Some(target) = args.target.first() {
		target.as_str()
	} else {
		default_resolution_target()
	};
	let artifact = release
		.artifacts
		.iter()
		.find(|artifact| artifact.target == target || artifact.target == "any")
		.ok_or_else(|| miette!("{} has no wheel for {target}", release.version))?;
	verify_artifact_signature(
		extension.publisher_key.as_str(),
		artifact.blake3.as_str(),
		artifact.sha256.as_str(),
		release.signature_capability_digest().as_str(),
		artifact.signature.as_str(),
	)
	.map_err(extension_failure)?;

	let grant_request = grant_request
		.map(parse_grant_requests)
		.transpose()
		.map_err(extension_failure)?
		.unwrap_or_default()
		.into_iter()
		.find(|request| request.id == extension.id);
	let environment_consent = grant_request
		.as_ref()
		.map(|request| {
			validate_grant_request(request, projection.capabilities.iter().cloned()).map(|exact| {
				exact
					&& request
						.tier
						.is_none_or(|approved| approved == tier(args.tier))
			})
		})
		.transpose()
		.map_err(extension_failure)?
		.unwrap_or(false);
	let trusted_tier_consent =
		grant_request.as_ref().and_then(|request| request.tier) == Some(omp_ext::TrustTier::Trusted);
	let interactive_consent = args.yes && (args.tier != Tier::Trusted || trusted_tier_consent);
	let consented = environment_consent || interactive_consent;
	if args.tier == Tier::Trusted && !trusted_tier_consent {
		return Err(extension_failure(omp_ext::ExtensionError::new(
			omp_ext::ExtensionCode::EConsent,
			"trusted extension installation requires OMP_EXT_GRANT with tier=trusted",
		)));
	}

	let mut keys = KeysFile::read(&state.keys).map_err(extension_failure)?;
	let first_seen = !keys.keys.iter().any(|pin| pin.id == extension.id);
	if first_seen && !consented {
		return Err(extension_failure(omp_ext::ExtensionError::new(
			omp_ext::ExtensionCode::EConsent,
			format!(
				"first-seen publisher key for {} requires explicit operator consent",
				extension.id
			),
		)));
	}
	keys
		.verify_or_pin(
			&extension.id,
			&extension.publisher_key,
			&release.version,
			&Str::new_static("explicit-install"),
			None,
		)
		.map_err(extension_failure)?;

	let requested_digest = if let Some(capabilities) = args.capabilities.as_deref() {
		omp_ext::trust::capability_digest(csv(capabilities), [])
	} else {
		effective_capability_digest.clone()
	};
	if requested_digest != effective_capability_digest {
		return Err(miette!(
			"requested capabilities do not exactly match the signed manifest capability digest"
		));
	}
	let ship = Str::new_static("installed");
	let workspace = (state.layer == BackendLayer::Workspace).then_some(&state.workspace);
	let mut grants = GrantsFile::read(&state.grants).map_err(extension_failure)?;
	if consented {
		grants.grants.retain(|grant| {
			grant.id != extension.id
				|| grant.layer != state.layer
				|| grant.workspace.as_ref() != workspace
		});
		grants.grants.push(Grant {
			id:                extension.id.clone(),
			publisher:         extension.publisher_key.clone(),
			layer:             state.layer,
			workspace:         workspace.cloned(),
			scope:             omp_ext::trust::GrantScope::Exact,
			capability_digest: effective_capability_digest.clone(),
			tier:              tier(args.tier),
			ship:              ship.clone(),
			granted_at:        Str::new(jiff::Timestamp::now().to_string()),
			granted_by:        if environment_consent {
				Str::new_static("environment")
			} else {
				Str::new_static("explicit-install")
			},
			duration:          omp_ext::trust::GrantDuration::Persistent,
		});
	}
	if !grant_covers(
		&grants,
		&extension.id,
		&extension.publisher_key,
		state.layer,
		workspace,
		&effective_capability_digest,
		tier(args.tier),
		&ship,
	) {
		return Err(extension_failure(omp_ext::ExtensionError::new(
			omp_ext::ExtensionCode::EConsent,
			format!(
				"no exact operator grant admits {} at {:?} tier with {} shipping",
				extension.id, args.tier, ship
			),
		)));
	}
	if !args.dry_run {
		grants.write(&state.grants).into_diagnostic()?;
	}

	lock.indexes = vec![if index.is_empty() {
		catalog.name.to_string()
	} else {
		index
	}];
	lock.targets = vec![artifact.target.clone()];
	lock.extensions.retain(|locked| locked.id != extension.id);
	lock.extensions.push(LockedExtension {
		id: extension.id.clone(),
		version: release.version.clone(),
		tier: tier(args.tier),
		pool: args.pool.clone(),
		features: features.clone(),
		source: index_source(
			lock.indexes.first().map_or("", String::as_str),
			&extension.distribution,
		),
		manifest_digest: release.manifest_digest.clone(),
		capability_digest: effective_capability_digest,
		declaration_digest: projection.declaration_digest,
		manifest_capability_digest: release.signature_capability_digest().clone(),
		publisher: extension.publisher_key.clone(),
		signature: artifact.signature.clone(),
		ship: Str::new_static("installed"),
		requires: projection.requires,
		wheel: Wheel {
			file:   artifact.file.clone(),
			tag:    artifact.tag.clone(),
			size:   artifact.size,
			blake3: artifact.blake3.clone(),
			sha256: artifact.sha256.clone(),
		},
	});
	lock
		.extensions
		.sort_by(|left, right| left.id.cmp(&right.id));
	if args.dry_run {
		if !json {
			println!("would install {} {}", extension.id, release.version);
		}
		return Ok(!args.no_lock);
	}
	let generation_id = generation_id(extension.id.as_str(), release.version.as_str());
	let (environment, request, site_root) =
		materialize_signed_wheel(state, uv, artifact, &generation_id).await?;
	let mut source =
		index_source(lock.indexes.first().map_or("", String::as_str), &extension.distribution);
	source
		.as_table_mut()
		.expect("index source is a table")
		.insert("root".to_owned(), toml::Value::String(site_root.display().to_string()));
	upsert_installed(installed, InstalledExtension {
		id: extension.id.clone(),
		features,
		source,
		tier: tier(args.tier),
		enabled: true,
	});
	keys.write(&state.keys).into_diagnostic()?;
	environment
		.client()
		.materialize_site(request)
		.await
		.into_diagnostic()?;
	if args.no_lock {
		eprintln!(
			"warning[{}]: {} is installed without a reproducible lock entry",
			omp_ext::ExtensionCode::WNoLock,
			extension.id
		);
	}
	println!("prepared {} {}", extension.id, release.version);
	Ok(!args.no_lock)
}

async fn materialize_signed_wheel(
	state: &StatePaths,
	uv: Option<&Path>,
	artifact: &omp_ext::index::IndexArtifact,
	site_key: &str,
) -> miette::Result<(omp_envd::ProjectEnvironment, MaterializeSite, PathBuf)> {
	if artifact.size > MAX_WHEEL_BYTES as u64 {
		return Err(miette!("signed extension wheel exceeds the 256 MiB safety ceiling"));
	}
	fs::create_dir_all(&state.artifacts).into_diagnostic()?;
	let artifact_path = state
		.artifacts
		.join(artifact.blake3.as_str().trim_start_matches("b3:"));
	let bytes = if artifact_path.is_file() {
		fs::read(&artifact_path).into_diagnostic()?
	} else {
		if state.offline != OfflineMode::Online {
			return Err(extension_failure(omp_ext::ExtensionError::new(
				omp_ext::ExtensionCode::EOffline,
				format!("extension artifact {} is absent from the local cache", artifact.blake3),
			)));
		}
		let bytes = fetch_signed_wheel(artifact).await?;
		let staged = artifact_path.with_extension("download.tmp");
		fs::write(&staged, &bytes).into_diagnostic()?;
		fs::rename(staged, &artifact_path).into_diagnostic()?;
		bytes
	};
	verify_signed_wheel_bytes(&bytes, artifact)?;
	fs::create_dir_all(&state.store).into_diagnostic()?;
	let stored_wheel = state
		.store
		.join(artifact.blake3.as_str().trim_start_matches("b3:"));
	let store_matches = stored_wheel
		.is_file()
		.then(|| fs::read(&stored_wheel))
		.transpose()
		.into_diagnostic()?
		.is_some_and(|stored| verify_signed_wheel_bytes(&stored, artifact).is_ok());
	if !store_matches {
		let staged = state.store.join(format!(
			".store-{}-{}.tmp",
			std::process::id(),
			omp_core::Ulid::generate()
		));
		fs::write(&staged, &bytes).into_diagnostic()?;
		fs::rename(staged, &stored_wheel).into_diagnostic()?;
	}
	let staging = state
		.artifacts
		.join(format!(".unpack-{site_key}-{}", std::process::id()));
	if staging.exists() {
		fs::remove_dir_all(&staging).into_diagnostic()?;
	}
	fs::create_dir_all(&staging).into_diagnostic()?;
	let wheel_input = state.artifacts.join(format!(".wheel-{site_key}.whl"));
	fs::copy(&stored_wheel, &wheel_input).into_diagnostic()?;
	let mut command = tokio::process::Command::new(uv.unwrap_or_else(|| Path::new("uv")));
	command
		.args(["pip", "install", "--no-deps", "--no-index", "--target"])
		.arg(&staging)
		.arg(&wheel_input)
		.kill_on_drop(true);
	let output = tokio::select! {
		output = command.output() => output.into_diagnostic(),
		_ = tokio::signal::ctrl_c() => Err(extension_interrupt()),
	};
	let _ = fs::remove_file(&wheel_input);
	let output = match output {
		Ok(output) => output,
		Err(error) => {
			let _ = fs::remove_dir_all(&staging);
			return Err(error);
		},
	};
	if !output.status.success() {
		let _ = fs::remove_dir_all(&staging);
		return Err(miette!(
			"uv could not unpack the verified extension wheel: {}",
			String::from_utf8_lossy(&output.stderr)
		));
	}
	let store = BlobStore::open(state.project_state.join("blobs")).into_diagnostic()?;
	let files = site_files(&store, &staging)?;
	let _ = fs::remove_dir_all(&staging);
	if files.is_empty() {
		return Err(miette!("verified extension wheel materialized no files"));
	}
	let request = MaterializeSite {
		site_key: site_key.to_owned(),
		files,
		idempotency_key: format!("ext-install-{site_key}"),
		..MaterializeSite::default()
	};
	let con = Arc::new(crate::process_ctx(&state.project)?);
	let environment = omp_envd::ProjectEnvironment::attach(
		&state.project,
		&state.project_state,
		omp_envd::AttachOptions {
			py_eval: false,
			approval_mode: None,
			trusted_extensions: Vec::new(),
			contributed_values: Vec::new(),
			con,
			bridges: omp_envd::RegistryBridges::default(),
			spawn_idle_timeout: None,
		},
	)
	.await
	.map_err(|error| miette!("{error}"))?;
	let site_root = state.sites.join(site_key);
	Ok((environment, request, site_root))
}

async fn fetch_signed_wheel(artifact: &omp_ext::index::IndexArtifact) -> miette::Result<Vec<u8>> {
	if let Some(path) = artifact.url.strip_prefix("file://") {
		return fs::read(path).into_diagnostic();
	}
	if !artifact.url.starts_with("https://") {
		return Err(miette!("signed extension wheel URL must use HTTPS or file://"));
	}
	let response = tokio::select! {
		response = omp_http::default_client().get(&artifact.url).send() => {
			response.into_diagnostic()?
		},
		_ = tokio::signal::ctrl_c() => {
			return Err(extension_interrupt());
		},
	};
	if !response.status().is_success() {
		return Err(miette!("extension wheel download returned HTTP {}", response.status()));
	}
	let mut bytes = Vec::with_capacity(usize::try_from(artifact.size).unwrap_or_default());
	let mut stream = response.bytes_stream();
	loop {
		let chunk = tokio::select! {
			chunk = stream.next() => chunk,
			_ = tokio::signal::ctrl_c() => {
				return Err(extension_interrupt());
			},
		};
		let Some(chunk) = chunk else {
			break;
		};
		let chunk = chunk.into_diagnostic()?;
		if bytes.len().saturating_add(chunk.len()) > MAX_WHEEL_BYTES {
			return Err(miette!("extension wheel download exceeded the 256 MiB safety ceiling"));
		}
		bytes.extend_from_slice(&chunk);
	}
	Ok(bytes)
}

fn verify_signed_wheel_bytes(
	bytes: &[u8],
	artifact: &omp_ext::index::IndexArtifact,
) -> miette::Result<()> {
	if bytes.len() as u64 != artifact.size
		|| sf!("b3:{}", blake3::hash(bytes).to_hex()) != artifact.blake3
		|| sf!("sha256:{}", hex::encode(&Sha256::digest(bytes))) != artifact.sha256
	{
		return Err(miette!("extension wheel bytes differ from signed index metadata"));
	}
	Ok(())
}

fn site_files(store: &BlobStore, root: &Path) -> miette::Result<Vec<SiteFile>> {
	let canonical_root = fs::canonicalize(root).into_diagnostic()?;
	let mut pending = vec![canonical_root.clone()];
	let mut files = Vec::new();
	while let Some(directory) = pending.pop() {
		for entry in fs::read_dir(&directory).into_diagnostic()? {
			let entry = entry.into_diagnostic()?;
			let metadata = fs::symlink_metadata(entry.path()).into_diagnostic()?;
			if metadata.file_type().is_symlink() {
				return Err(miette!("unpacked extension wheel contains a symbolic link"));
			}
			if metadata.is_dir() {
				pending.push(entry.path());
				continue;
			}
			if !metadata.is_file() {
				return Err(miette!("unpacked extension wheel contains a non-regular file"));
			}
			let path = fs::canonicalize(entry.path()).into_diagnostic()?;
			let relative = path
				.strip_prefix(&canonical_root)
				.map_err(|_| miette!("unpacked extension file escapes the staging root"))?;
			let relative = relative.to_string_lossy().replace('\\', "/");
			let bytes = fs::read(&path).into_diagnostic()?;
			let blob = store.put(&bytes).into_diagnostic()?;
			files.push(SiteFile {
				path:      relative,
				blob_hash: bytes::Bytes::copy_from_slice(blob.hash.as_bytes()),
				mode:      site_file_mode(&metadata),
			});
		}
	}
	files.sort_by(|left, right| left.path.cmp(&right.path));
	Ok(files)
}

#[cfg(unix)]
fn site_file_mode(metadata: &fs::Metadata) -> u32 {
	use std::os::unix::fs::PermissionsExt as _;
	metadata.permissions().mode()
}

#[cfg(not(unix))]
fn site_file_mode(_metadata: &fs::Metadata) -> u32 {
	0
}

fn ensure_not_revoked(state: &StatePaths, id: &Str, version: &Str) -> miette::Result<()> {
	if !state.revocations.exists() {
		return if state.offline == OfflineMode::Strict {
			Err(extension_failure(omp_ext::ExtensionError::new(
				omp_ext::ExtensionCode::ERevoked,
				"strict offline admission requires a signed revocation snapshot",
			)))
		} else {
			Ok(())
		};
	}
	let key = fs::read_to_string(&state.index_key).into_diagnostic()?;
	let revocations =
		RevocationsFile::read(&state.revocations).map_err(|error| miette!("{error}"))?;
	revocations
		.verify(key.trim())
		.map_err(|error| miette!("{error}"))?;
	match revocations
		.freshness(&jiff::Timestamp::now().to_string(), state.offline == OfflineMode::Strict)
	{
		RevocationFreshness::Fresh => {},
		RevocationFreshness::Warn(code) => {
			eprintln!("warning[{code}]: signed revocation snapshot is stale");
		},
		RevocationFreshness::Reject(code) => {
			return Err(extension_failure(omp_ext::ExtensionError::new(
				code,
				"signed revocation snapshot is stale",
			)));
		},
	}
	if let Some(revocation) = revocations
		.revocation_for(id, version)
		.map_err(|error| miette!("{error}"))?
	{
		return Err(miette!("{id} {version} is revoked: {}", revocation.reason));
	}
	Ok(())
}

fn generation_id(id: &str, version: &str) -> String {
	let source = format!("{id}-{version}");
	let mut safe = source
		.chars()
		.take(96)
		.map(|character| {
			if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
				character
			} else {
				'_'
			}
		})
		.collect::<String>();
	safe.push('-');
	safe.push_str(&Hash32::sum(source.as_bytes()).to_hex().as_str()[..16]);
	safe
}

fn read_lock_or_empty(path: &Path, layer: BackendLayer) -> miette::Result<LockFile> {
	if path.exists() {
		return LockFile::read(path, layer).map_err(extension_failure);
	}
	Ok(LockFile {
		version: omp_ext::lock::LOCK_VERSION,
		generated_by: "omp ext".to_owned(),
		generated_at: String::new(),
		layer,
		requires_python: Str::new_static("==3.14.*"),
		abi: Str::new_static("cp314t"),
		targets: Vec::new(),
		exclude_newer: None,
		indexes: Vec::new(),
		index_strategy: Str::new_static("first-index"),
		extensions: Vec::new(),
		packages: Vec::new(),
		frozen: Vec::new(),
	})
}

fn upsert_installed(installed: &mut InstalledRecord, replacement: InstalledExtension) {
	installed
		.extensions
		.retain(|entry| entry.id != replacement.id);
	installed.extensions.push(replacement);
	installed
		.extensions
		.sort_by(|left, right| left.id.cmp(&right.id));
}

const fn tier(value: Tier) -> omp_ext::TrustTier {
	match value {
		Tier::Trusted => omp_ext::TrustTier::Trusted,
		Tier::Sandboxed => omp_ext::TrustTier::Sandboxed,
	}
}

fn csv(value: &str) -> Vec<Str> {
	value
		.split(',')
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(Str::new)
		.collect()
}

fn write_toml(path: &Path, value: &impl serde::Serialize) -> miette::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).into_diagnostic()?;
	}
	let temporary = path.with_extension("toml.tmp");
	fs::write(&temporary, toml::to_string_pretty(value).into_diagnostic()?).into_diagnostic()?;
	fs::rename(temporary, path).into_diagnostic()
}
#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn missing_local_source_policy_can_skip_or_error() {
		let missing = SourceSpec::Path(PathBuf::from("definitely-missing-extension-source"));
		assert_eq!(
			source_requirement(missing.clone(), MissingSourcePolicy::Skip).expect("skip outcome"),
			None
		);
		assert!(source_requirement(missing, MissingSourcePolicy::Error).is_err());
	}

	#[tokio::test]
	async fn scaffold_manifest_admits_and_installs_and_links() {
		let tree = tempfile::tempdir().expect("extension workspace");
		new_extension(tree.path(), ExtNewArgs { id: Str::new_static("demo") }).expect("scaffold");
		let root = tree.path().join("demo");
		let manifest = read_development_manifest(&root).expect("admitted scaffold manifest");
		assert_eq!(manifest.id, "demo");
		assert_eq!(manifest.entry, "demo");
		assert_eq!(manifest.declarations.len(), 2);
		assert_eq!(manifest.declarations[0].key, "hello@demo.1");
		assert_eq!(manifest.declarations[0].kind, "hard");
		assert_eq!(manifest.declarations[0].trigger, "lazy");
		assert_eq!(manifest.declarations[0].failure, "fail-closed");
		assert_eq!(manifest.declarations[1].key, "extension_activate/observe");
		assert_eq!(manifest.declarations[1].trigger, "lazy");
		assert_eq!(manifest.declarations[1].failure, "fail-open");
		let pyproject =
			fs::read_to_string(root.join("pyproject.toml")).expect("scaffold package metadata");
		let pyproject: toml::Value = toml::from_str(&pyproject).expect("valid pyproject");
		assert_eq!(pyproject["project"]["name"].as_str(), Some("demo"));
		assert_eq!(
			pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
				.as_array()
				.and_then(|packages| packages.first())
				.and_then(toml::Value::as_str),
			Some("src/demo")
		);

		let install_data = tree.path().join("install-data");
		let install_state = StatePaths::new(&install_data, tree.path()).scoped(Scope::User);
		install(
			&install_state,
			ExtInstallArgs {
				specs:          vec![Str::new(root.display().to_string())],
				tier:           Tier::Sandboxed,
				pool:           None,
				features:       None,
				capabilities:   None,
				yes:            false,
				dry_run:        false,
				no_preresolved: false,
				target:         Vec::new(),
				no_lock:        false,
				force:          false,
			},
			None,
			None,
			false,
		)
		.await
		.expect("installed scaffold path");
		let path_installed =
			InstalledRecord::read(&install_state.client_installed).expect("path install record");
		assert_eq!(path_installed.extensions.len(), 1);
		assert_eq!(path_installed.extensions[0].id, "demo");
		assert_eq!(
			path_installed.extensions[0]
				.source
				.get("path")
				.and_then(toml::Value::as_str),
			Some(
				root
					.canonicalize()
					.expect("canonical root")
					.to_string_lossy()
					.as_ref()
			)
		);

		let data = tree.path().join("data");
		let state = StatePaths::new(&data, tree.path()).scoped(Scope::User);
		link(
			&state,
			ExtLinkArgs {
				path:       root.clone(),
				tier:       Tier::Sandboxed,
				name:       None,
				features:   None,
				no_resolve: false,
			},
			false,
		)
		.expect("linked scaffold");
		let installed =
			InstalledRecord::read(&state.client_installed).expect("linked install record");
		assert_eq!(installed.extensions.len(), 1);
		assert_eq!(installed.extensions[0].id, "demo");
		assert_eq!(installed.extensions[0].tier, omp_ext::TrustTier::Sandboxed);
		assert_eq!(
			installed.extensions[0]
				.source
				.get("link")
				.and_then(toml::Value::as_str),
			Some(
				root
					.canonicalize()
					.expect("canonical root")
					.to_string_lossy()
					.as_ref()
			)
		);

		trust(&state, ExtTrustArgs {
			id:     Str::new_static("demo"),
			show:   false,
			tier:   Some(Tier::Trusted),
			ship:   None,
			key:    None,
			revoke: false,
		})
		.expect("linked trust tier mutation");
		let trusted = InstalledRecord::read(&state.client_installed).expect("trusted install record");
		assert_eq!(trusted.extensions[0].tier, omp_ext::TrustTier::Trusted);
	}

	#[test]
	fn verified_wheel_bytes_and_site_files_are_content_addressed() {
		let bytes = b"wheel";
		let artifact = omp_ext::index::IndexArtifact {
			target:    Str::new_static("any"),
			url:       "file:///wheel.whl".to_owned(),
			file:      Str::new_static("review.whl"),
			tag:       Str::new_static("py3-none-any"),
			size:      bytes.len() as u64,
			blake3:    Str::from(format!("b3:{}", blake3::hash(bytes).to_hex())),
			sha256:    Str::from(format!("sha256:{}", hex::encode(&Sha256::digest(bytes)))),
			signature: Str::new_static("signature"),
		};
		verify_signed_wheel_bytes(bytes, &artifact).expect("verified wheel");
		assert!(verify_signed_wheel_bytes(b"changed", &artifact).is_err());

		let directory = tempfile::tempdir().expect("site");
		let root = directory.path().join("unpacked");
		fs::create_dir_all(root.join("review")).expect("package directory");
		fs::write(root.join("review/__init__.py"), b"value = 1\n").expect("module");
		fs::write(root.join("review.dist-info"), b"metadata").expect("metadata");
		let store = BlobStore::open(directory.path().join("blobs")).expect("blob store");
		let files = site_files(&store, &root).expect("site files");
		assert_eq!(
			files
				.iter()
				.map(|file| file.path.as_str())
				.collect::<Vec<_>>(),
			["review.dist-info", "review/__init__.py"]
		);
		assert!(files.iter().all(|file| file.blob_hash.len() == 32));
	}
}
