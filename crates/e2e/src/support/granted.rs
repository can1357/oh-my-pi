#![cfg(unix)]

//! Operator-granted control capabilities, end to end.
//!
//! One scratch operator home holds the grant store and the user extension
//! root. The shipped `omp ext grant` writes the grant, the production driver
//! admission turns that grant and the extension's manifest into a host spec,
//! and [`InProcessEnvHarness`](super::InProcessEnvHarness) registers the spec
//! behind its CONTROL extension host. Nothing here builds `control_grants`.
//!
//! Admission withholds CONTROL when the grant store or the user extension root
//! lies inside an exec-writable root, and `TMPDIR` and `/tmp` are exec-writable
//! roots, so [`Scratch`](super::Scratch) cannot hold them. [`OperatorHome`]
//! lives under `$HOME` instead, as the driver's own admission tests do.

use std::{
	env, fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use async_trait::async_trait;
use omp_core::Str;
use omp_driver::discovery::native::{
	AdmittedNativeExtension, NativeAdmissionOptions, NativeControlGrantOptions, NativeLoadMode,
	admit_native_extensions_contained_with_control, user_extension_root,
};
use omp_envd::{
	EnvServer, ExtensionDataBinding,
	admission::{SandboxState, probe_sandbox},
	exec_settings::{SV_SANDBOX_MODE, SV_SANDBOX_WRITABLE_ROOTS},
	exthost::{
		FixedControlAuthorityFactory,
		control::{ControlAuthority, ControlEffect, ControlProtocolError, ControlRequestContext},
	},
	worker::{ExternalControlAuthorityBinding, ExternalDomainControlFactories},
};
use serde_json::{Map, Value};
use tempfile::TempDir;
use tokio::process::Command;

use super::{OwnedProcess, omp_binary, pyext::ExtensionInstall};
use crate::{Context as _, Result, error};

const GRANT_TIMEOUT: Duration = Duration::from_secs(60);

/// Scratch operator state for one proof: the operator's `HOME`, the data
/// directory that holds the grant store, and the user extension root, all
/// outside every exec-writable root.
#[derive(Debug)]
pub struct OperatorHome {
	home:           PathBuf,
	data_dir:       PathBuf,
	extension_root: PathBuf,
	// Declared last: the tree is removed only after every path above is dead.
	_tree:          TempDir,
}

/// The outcome of one production native-admission pass over an
/// [`OperatorHome`].
#[derive(Debug)]
pub struct Admission {
	/// The extension the driver admitted, exactly as `compose_kernel` hands it
	/// to the environment.
	pub extension: AdmittedNativeExtension,
	/// The sandbox the host probed while admitting. Admission grants CONTROL
	/// only when it confines.
	pub sandbox:   SandboxState,
}

impl OperatorHome {
	/// Creates the operator home below the real `$HOME`.
	///
	/// Fails, naming the constraint, when `$HOME` itself lies inside `TMPDIR`
	/// or `/tmp`: no such location can hold a protected grant store.
	pub fn new() -> Result<Self> {
		let base = omp_core::dirs::home_dir().context("HOME is unset")?;
		let tree = tempfile::Builder::new()
			.prefix("omp-e2e-operator-")
			.tempdir_in(&base)
			.with_context(|| format!("creating the operator home under {}", base.display()))?;
		let root = tree
			.path()
			.canonicalize()
			.context("canonical operator home")?;
		for writable in [env::temp_dir(), PathBuf::from("/tmp")] {
			let writable = writable.canonicalize().unwrap_or(writable);
			if root.starts_with(&writable) {
				return Err(error(format!(
					"the operator home {} is inside the exec-writable root {}; run with HOME outside \
					 TMPDIR and /tmp",
					root.display(),
					writable.display()
				)));
			}
		}
		let home = root.join("home");
		let data_dir = root.join("data");
		fs::create_dir_all(&home).context("creating the operator HOME")?;
		fs::create_dir_all(&data_dir).context("creating the operator data directory")?;
		let extension_root =
			user_extension_root(&home).context("resolving the user extension root")?;
		if !extension_root.starts_with(&root) {
			return Err(error(format!(
				"the user extension root {} lies outside the operator home; unset OMP_CONFIG_DIR and \
				 OMP_PROFILE",
				extension_root.display()
			)));
		}
		Ok(Self { home, data_dir, extension_root, _tree: tree })
	}

	/// Returns the operator's `HOME`.
	pub fn home(&self) -> &Path {
		&self.home
	}

	/// Returns the data directory whose `ext/grants.toml` is the grant store.
	pub fn data_dir(&self) -> &Path {
		&self.data_dir
	}

	/// Returns the user extension root (`<config>/agent/extensions`).
	pub fn extension_root(&self) -> &Path {
		&self.extension_root
	}

	/// Returns the grant store file `omp ext grant` writes.
	pub fn grants_file(&self) -> PathBuf {
		omp_ext::trust::grants_path(&self.data_dir)
	}

	/// Installs one single-module user extension under the user extension root
	/// and returns its distribution root.
	///
	/// The module is `src/<id>/__init__.py`, so the manifest's `entry` must be
	/// `id`.
	pub fn install_extension(&self, id: &str, manifest: &str, source: &str) -> Result<PathBuf> {
		let root = self.extension_root.join(id);
		let module = root.join("src").join(id);
		fs::create_dir_all(&module).context("creating the extension module directory")?;
		fs::write(root.join("omp.toml"), manifest).context("writing the extension manifest")?;
		fs::write(module.join("__init__.py"), source).context("writing the extension module")?;
		Ok(root)
	}

	/// Runs the shipped `omp ext grant <id> --yes` against this home.
	///
	/// The child is the worker-capable `omp` executable, so the writer is the
	/// real command line, not a re-implementation. `project` is the session's
	/// workspace, which the grant's location checks must keep clear of the
	/// store.
	pub async fn grant(&self, project: &Path, id: &str) -> Result<()> {
		let mut command = Command::new(omp_binary().context("resolving the omp executable")?);
		command
			.arg("ext")
			.arg("--data-dir")
			.arg(&self.data_dir)
			.arg("--project")
			.arg(project)
			.args(["grant", id, "--yes"])
			.current_dir(project)
			.env("HOME", &self.home)
			.env("NO_COLOR", "1");
		let output = OwnedProcess::output(command, GRANT_TIMEOUT)
			.await
			.context("running omp ext grant")?;
		if !output.status.success() {
			return Err(error(format!(
				"omp ext grant {id} failed with {}: {}{}",
				output.status,
				String::from_utf8_lossy(&output.stdout),
				String::from_utf8_lossy(&output.stderr)
			)));
		}
		Ok(())
	}

	/// Runs the production driver's native admission over this home, with the
	/// host facts `compose_kernel` derives from a default console, and returns
	/// the admitted extension `id`.
	pub fn admit(&self, project: &Path, id: &str) -> Result<Admission> {
		let ctx = omp_con::Ctx::new();
		let writable_roots = SV_SANDBOX_WRITABLE_ROOTS
			.get(&ctx)
			.into_iter()
			.map(|path| PathBuf::from(path.as_str()))
			.collect::<Vec<_>>();
		let sandbox = probe_sandbox(&ctx, project);
		let control = NativeControlGrantOptions {
			data_dir:          &self.data_dir,
			sandbox_mode:      SV_SANDBOX_MODE.get(&ctx),
			writable_roots:    &writable_roots,
			sandbox_available: sandbox.confines(),
		};
		let report = admit_native_extensions_contained_with_control(
			project,
			&self.home,
			NativeAdmissionOptions {
				explicit_roots:    &[],
				mode:              NativeLoadMode::Merge,
				include_workspace: false,
				setting_overrides: &[],
				disabled:          &[],
			},
			&control,
		);
		if !report.errors.is_empty() {
			return Err(error(format!("native admission failed: {:?}", report.errors)));
		}
		let extension = report
			.extensions
			.into_iter()
			.find(|extension| extension.spec.key.extension().as_str() == id)
			.with_context(|| format!("native admission did not admit `{id}`"))?;
		Ok(Admission { extension, sandbox })
	}
}

/// Builds the host spec for an admitted extension and binds its scoped DATA
/// endpoint to `session_id` and `generation`, as `PythonExtension::install`
/// does for a hand-built fixture.
pub(super) fn install_admitted(
	extension: &AdmittedNativeExtension,
	state: &Path,
	session_id: &str,
	generation: u64,
) -> Result<ExtensionInstall> {
	let mut spec = extension.spec.clone();
	let mut binding = ExtensionDataBinding::scoped(
		state,
		spec.key.clone(),
		session_id,
		generation,
		spec.data_grants.clone(),
	);
	binding
		.prepare_endpoint()
		.context("prepare scoped extension DATA socket")?;
	spec.data_socket = Some(binding.path().to_owned());
	Ok(ExtensionInstall { spec, binding })
}

struct NoAgentsOwner;

fn no_agents_owner(operation: &str) -> ControlProtocolError {
	ControlProtocolError::new(
		"AgentsOwnerUnavailable",
		format!("the e2e Agents owner serves no `{operation}`"),
	)
}

#[async_trait]
impl ControlAuthority for NoAgentsOwner {
	fn handles(&self, _operation: &str) -> bool {
		false
	}

	fn authorize(
		&self,
		_context: &ControlRequestContext,
		operation: &str,
		_arguments: &Map<String, Value>,
	) -> std::result::Result<(), ControlProtocolError> {
		Err(no_agents_owner(operation))
	}

	async fn request(
		&self,
		_context: ControlRequestContext,
		operation: Str,
		_arguments: Map<String, Value>,
	) -> std::result::Result<Value, ControlProtocolError> {
		Err(no_agents_owner(operation.as_str()))
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> std::result::Result<(), ControlProtocolError> {
		Err(no_agents_owner("effect"))
	}
}

/// Keeps the e2e Agents owner installed on an authority while it lives.
pub struct AgentsLease {
	_binding: ExternalControlAuthorityBinding,
}

/// Installs a minimal Agents owner, standing in for a chat parent's lease.
///
/// Continuation operations are served before the Agents owner is consulted, so
/// this owner serves nothing and only lets the continuation gate bind to the
/// extension's CONTROL connection.
pub fn install_agents_owner(server: &EnvServer) -> AgentsLease {
	let agents = Arc::new(FixedControlAuthorityFactory::new(Arc::new(NoAgentsOwner)));
	AgentsLease {
		_binding: server
			.bind_external_control_authorities(agents, ExternalDomainControlFactories::default()),
	}
}
