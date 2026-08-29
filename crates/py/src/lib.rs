//! Self-contained embedded `CPython` 3.14 runtime.
//!
//! [`Engine`] boots `CPython` inside the current process in isolated mode.
//! Desktop builds freeze the standard library in-memory; Android/Termux uses
//! the installed system standard library and `lib-dynload` directory. Both
//! variants include the repo-provided Python modules bundled from
//! `crates/py/python` (e.g. `omp_remote`, remote function execution) and the
//! pure-Python packages pinned in `crates/py/requirements.txt`.
//!
//! Native Rust modules registered with [`pyo3::append_to_inittab!`] before
//! [`Builder::init`] are importable from Python by name.
//!
//! ```no_run
//! use omp_py::pyo3::{ffi::c_str, prelude::*};
//!
//! let engine = omp_py::Engine::builder().init().expect("boot python");
//! let greet = c_str!("print('hello from embedded python')");
//! engine.attach(|py| py.run(greet, None, None)).unwrap();
//! ```
//!
//! Embedding contract: binaries that should support native wheels must link
//! with `-Wl,-export_dynamic` so extension modules can resolve the `CPython`
//! C-API from the executable at dlopen. This crate's build script applies it
//! to its own binaries; downstream crates need it in their own build script.

mod bindings;
mod env_types;
pub mod interrupt;

use std::{
	env,
	error::Error,
	ffi::CString,
	fmt::{self, Display},
	mem::MaybeUninit,
	os::unix::ffi::OsStrExt,
	path::{Path, PathBuf},
	ptr::{null, null_mut},
	sync::atomic::{AtomicBool, Ordering},
};

pub use bindings::{
	bind_duration, bind_principal, set_environment_root, set_resource_receipt, set_scheme_snapshot,
};
pub use pyo3;
use pyo3::{ffi, prelude::*};

/// Embedded desktop stdlib: `u32` entry count, then records of `u16` name
/// length (including a trailing NUL), `u8` is-package, `u32` code length,
/// NUL-terminated name, marshalled code object. Android uses the installed
/// Termux stdlib instead and supplies an empty blob.
#[cfg(not(target_os = "android"))]
static STDLIB_BLOB: &[u8] = include_bytes!(env!("OMP_STDLIB_BLOB"));

#[cfg(target_os = "android")]
static STDLIB_BLOB: &[u8] = b"\0\0\0\0";

/// Repo-provided Python modules (`crates/py/python`) plus the pure-Python
/// packages pinned in `crates/py/requirements.txt` (e.g. cloudpickle),
/// same format as [`STDLIB_BLOB`]. Packed by build.rs with the configured
/// interpreter.
static OMP_MODULES_BLOB: &[u8] = include_bytes!(env!("OMP_PY_MODULES_BLOB"));

include!(env!("OMP_PY_FROZEN_DISTRIBUTIONS"));

/// Returns the exact distributions frozen into this binary.
///
/// Resolver rule R7 reads this runtime metadata rather than duplicating a
/// requirements list in application code.
pub const fn frozen_distributions() -> &'static [(&'static str, &'static str)] {
	FROZEN_DISTRIBUTIONS
}

/// License notices for bundled third-party Python packages
/// (`crates/py/requirements.txt`).
///
/// BSD-style terms require reproducing them in shipped materials. This
/// unreferenced constant is not linked into consumer binaries, so
/// redistributors must surface it explicitly (for example, with a `--licenses`
/// flag) or ship `THIRD-PARTY-NOTICES.txt` beside the artifact.
pub const THIRD_PARTY_LICENSES: &str = include_str!("../THIRD-PARTY-NOTICES.txt");

/// One-shot guard: `CPython` supports a single runtime per process.
static INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Why [`Builder::init`] refused to boot.
///
/// CPython-side boot failures (corrupt frozen data, allocator failure) do
/// not surface here: the interpreter prints its diagnostic and exits the
/// process, per embedding convention.
#[derive(Debug)]
#[non_exhaustive]
pub enum InitError {
	/// The engine was already initialized in this process.
	AlreadyInitialized,
	/// A configured search path contains an interior NUL byte.
	InvalidPath(PathBuf),
}

impl Display for InitError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::AlreadyInitialized => f.write_str("python engine already initialized"),
			Self::InvalidPath(p) => write!(f, "search path contains NUL byte: {}", p.display()),
		}
	}
}

impl Error for InitError {}

/// Processing policy for the one host-authorized site-packages directory.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SitePolicy {
	/// Exposes the directory directly without executing installation metadata.
	Direct,
	/// Processes `.pth` files, including their standard executable import lines.
	PthFiles,
	/// Processes `.pth` files and imports `sitecustomize`, but never
	/// `usercustomize`.
	#[default]
	PthFilesAndSiteCustomize,
}

/// Configures the isolated embedded CPython runtime and its authorized-site
/// policy. Created by [`Engine::builder`].
#[derive(Debug, Default)]
pub struct Builder {
	site_packages: Option<PathBuf>,
	site_policy:   SitePolicy,
}

impl Builder {
	/// Overrides the user site-packages directory. Desktop runtimes use this
	/// as their sole filesystem module path; Android adds it after the Termux
	/// stdlib, `lib-dynload`, and bundled pure-Python site.
	pub fn site_packages(mut self, dir: impl Into<PathBuf>) -> Self {
		self.site_packages = Some(dir.into());
		self
	}

	/// Selects how the authorized site directory is initialized.
	///
	/// The default, [`SitePolicy::PthFilesAndSiteCustomize`], matches a normal
	/// installed site while retaining isolated mode: `.pth` files may extend
	/// the import path or execute their standard `import` lines, and only
	/// `sitecustomize` reachable from that resulting path is imported.
	/// `usercustomize` and ambient user/global site directories remain disabled.
	pub const fn site_policy(mut self, policy: SitePolicy) -> Self {
		self.site_policy = policy;
		self
	}

	/// Boots `CPython`: registers the frozen stdlib, then initializes the
	/// runtime in isolated mode. Android resolves its system stdlib and dynamic
	/// extension directory from the configured search paths. Callable once per
	/// process.
	///
	/// # Errors
	/// [`InitError::AlreadyInitialized`] on repeat calls;
	/// [`InitError::InvalidPath`] if a configured search path contains NUL.
	#[tracing::instrument(
		level = "debug",
		name = "python_engine_init",
		skip_all,
		fields(site_policy = ?self.site_policy)
	)]
	pub fn init(self) -> Result<Engine, InitError> {
		if INITIALIZED.swap(true, Ordering::SeqCst) {
			tracing::warn!(reason = "already_initialized", "Python engine initialization rejected");
			return Err(InitError::AlreadyInitialized);
		}
		let site_policy = self.site_policy;
		let site = match self.site_packages {
			Some(site) => {
				tracing::debug!(
					site.path = %site.display(),
					source = "builder",
					"resolved Python site-packages directory"
				);
				site
			},
			None => default_site_packages(),
		};
		let paths = module_search_paths(&site);
		let paths_c = paths
			.iter()
			.map(|path| {
				CString::new(path.as_os_str().as_bytes()).map_err(|_| {
					tracing::warn!(
						site.path = %path.display(),
						reason = "interior_nul",
						"Python engine initialization rejected"
					);
					InitError::InvalidPath(path.clone())
				})
			})
			.collect::<Result<Vec<_>, _>>()?;
		tracing::debug_span!("python_inittab").in_scope(bindings::register);
		tracing::debug_span!(
			"python_stdlib_install",
			stdlib_bytes = STDLIB_BLOB.len(),
			project_module_bytes = OMP_MODULES_BLOB.len()
		)
		.in_scope(install_frozen_modules);
		tracing::debug_span!("python_runtime_boot").in_scope(|| init_python(&paths_c));
		let engine = Engine { site_packages: site };
		initialize_authorized_site(&engine, site_policy);
		Ok(engine)
	}
}

/// Handle to the booted interpreter; proof that [`Builder::init`] ran.
#[derive(Debug)]
pub struct Engine {
	site_packages: PathBuf,
}

impl Engine {
	/// Starts configuring an engine.
	pub fn builder() -> Builder {
		Builder::default()
	}

	/// Attaches the current thread to the interpreter and runs `f`.
	/// Equivalent to [`pyo3::Python::attach`], gated on initialization.
	pub fn attach<F, R>(&self, f: F) -> R
	where
		F: for<'py> FnOnce(Python<'py>) -> R,
	{
		Python::attach(f)
	}

	/// Returns the configured user site-packages directory.
	///
	/// The returned path is read-only; changing the search paths after isolated
	/// initialization would violate the embedding contract.
	/// Android additionally resolves imports from the Termux stdlib,
	/// `lib-dynload`, and the build-time bundled pure-Python site.
	pub fn site_packages(&self) -> &Path {
		&self.site_packages
	}
}

/// Imports the inert extension package and explicitly attaches its inherited
/// CONTROL descriptor. Extension-host process startup calls this after
/// [`Engine`] initialization; ordinary package import never invokes it.
///
/// # Errors
/// Returns the Python bootstrap error when the CONTROL descriptor is
/// unavailable or malformed.
pub fn bootstrap_extension_host(engine: &Engine) -> PyResult<()> {
	engine.attach(|py| {
		let host = py.import("omp._host")?;
		host.getattr("bootstrap")?.call0()?;
		Ok(())
	})
}

/// Default wheel directory: `$OMP_PY_SITE` or a home-relative fallback.
///
/// The fallback is `~/.local/share/omp-py/site-packages`. Install wheels with
/// a CPython 3.14 interpreter, for example:
/// `uv pip install --python python3.14 --target <dir> numpy`.
pub fn default_site_packages() -> PathBuf {
	let (site, source) = env::var_os("OMP_PY_SITE").map_or_else(
		|| {
			(
				env::home_dir()
					.map_or_else(env::temp_dir, |home| home.join(".local/share/omp-py"))
					.join("site-packages"),
				"default",
			)
		},
		|configured| (PathBuf::from(configured), "environment"),
	);
	tracing::debug!(
		site.path = %site.display(),
		source,
		"resolved Python site-packages directory"
	);
	site
}

fn module_search_paths(site_packages: &Path) -> Vec<PathBuf> {
	#[cfg(target_os = "android")]
	{
		let stdlib = env::var_os("OMP_PY_STDLIB_PATH")
			.or_else(|| option_env!("OMP_PY_STDLIB_PATH").map(std::ffi::OsString::from))
			.expect("omp-py Android build did not emit OMP_PY_STDLIB_PATH");
		let dynload = env::var_os("OMP_PY_DYNLOAD_PATH")
			.or_else(|| option_env!("OMP_PY_DYNLOAD_PATH").map(std::ffi::OsString::from))
			.expect("omp-py Android build did not emit OMP_PY_DYNLOAD_PATH");
		let system_site = env::var_os("OMP_PY_SYSTEM_SITE")
			.or_else(|| option_env!("OMP_PY_SYSTEM_SITE").map(std::ffi::OsString::from))
			.expect("omp-py Android build did not emit OMP_PY_SYSTEM_SITE");
		let bundled = env::var_os("OMP_PY_BUNDLED_SITE")
			.or_else(|| option_env!("OMP_PY_BUNDLED_SITE").map(std::ffi::OsString::from))
			.expect("omp-py Android build did not emit OMP_PY_BUNDLED_SITE");
		let mut paths = Vec::with_capacity(5);
		paths.push(PathBuf::from(stdlib));
		paths.push(PathBuf::from(dynload));
		let system_site = PathBuf::from(system_site);
		if system_site != site_packages {
			paths.push(system_site);
		}
		let bundled = PathBuf::from(bundled);
		if bundled != site_packages {
			paths.push(bundled);
		}
		paths.push(site_packages.to_owned());
		paths
	}
	#[cfg(not(target_os = "android"))]
	{
		vec![site_packages.to_owned()]
	}
}

/// Registers every embedded module (stdlib + repo-provided) as a frozen
/// module. Must run before the interpreter initializes; the table and
/// everything it points at live in the binary's static data.
fn install_frozen_modules() {
	let mut table = Vec::new();
	for blob in [STDLIB_BLOB, OMP_MODULES_BLOB] {
		let count = u32::from_le_bytes(blob[..4].try_into().unwrap()) as usize;
		table.reserve(count + 1);
		let mut rest = &blob[4..];
		for _ in 0..count {
			let name_len = u16::from_le_bytes(rest[..2].try_into().unwrap()) as usize;
			let is_pkg = rest[2];
			let code_len = u32::from_le_bytes(rest[3..7].try_into().unwrap()) as usize;
			let (name, code) = (&rest[7..7 + name_len], &rest[7 + name_len..7 + name_len + code_len]);
			assert_eq!(name[name_len - 1], 0, "blob names must be NUL-terminated");
			table.push(ffi::_frozen {
				name:       name.as_ptr().cast(),
				code:       code.as_ptr(),
				size:       i32::try_from(code_len).unwrap(),
				is_package: i32::from(is_pkg),
			});
			rest = &rest[7 + name_len + code_len..];
		}
	}
	table.push(ffi::_frozen {
		name:       null(),
		code:       null(),
		size:       0,
		is_package: 0,
	});
	// SAFETY: called once, before Py_InitializeFromConfig; the leaked table
	// and the blobs it points into are 'static.
	unsafe {
		ffi::PyImport_FrozenModules = Vec::leak(table).as_ptr();
	}
}

/// Aborts with `CPython`'s diagnostic if `status` signals an init failure.
fn check(status: ffi::PyStatus) {
	// SAFETY: PyStatus is a plain value; both calls are safe on any status
	// and Py_ExitStatusException never returns for failure statuses.
	unsafe {
		if ffi::PyStatus_Exception(status) != 0 {
			tracing::error!("embedded Python runtime initialization failed");
			ffi::Py_ExitStatusException(status);
		}
	}
}

/// Applies the selected policy only to the configured site directory.
///
/// Initialization failures follow CPython's embedding convention and abort
/// with its diagnostic, like failures from [`init_python`]. `addsitedir`
/// deliberately retains standard `.pth` semantics because this directory is
/// the explicit installation authority selected by the host.
#[tracing::instrument(
	level = "debug",
	name = "python_site_scan",
	skip_all,
	fields(site_path = %engine.site_packages.display(), site_policy = ?policy)
)]
fn initialize_authorized_site(engine: &Engine, policy: SitePolicy) {
	if policy == SitePolicy::Direct {
		return;
	}
	engine.attach(|py| {
		let site = py.import("site").unwrap_or_else(|error| {
			tracing::warn!(
				site_path = %engine.site_packages.display(),
				step = "site_import",
				"authorized Python site initialization failed"
			);
			error.print(py);
			panic!("embedded site module is unavailable");
		});
		site
			.call_method1("addsitedir", (&engine.site_packages,))
			.unwrap_or_else(|error| {
				tracing::warn!(
					site_path = %engine.site_packages.display(),
					step = "pth_files",
					"authorized Python site initialization failed"
				);
				error.print(py);
				panic!("failed to process authorized site directory");
			});
		if policy == SitePolicy::PthFilesAndSiteCustomize {
			site
				.call_method0("execsitecustomize")
				.unwrap_or_else(|error| {
					tracing::warn!(
						site_path = %engine.site_packages.display(),
						step = "sitecustomize",
						"authorized Python site initialization failed"
					);
					error.print(py);
					panic!("failed to execute authorized site customization");
				});
		}
	});
}

/// Boots the configured interpreter in isolated mode with explicit module
/// search paths. Android receives the Termux stdlib, `lib-dynload`, bundled
/// pure-Python site, and user site in that order; desktop receives its user
/// site because the stdlib is frozen.
fn init_python(module_paths: &[CString]) {
	// SAFETY: standard PyConfig embedding sequence — init, populate, hand to
	// Py_InitializeFromConfig, clear, then detach the initialization thread.
	// `config` outlives every borrow of it, and CPython copies both wide strings.
	unsafe {
		let mut config = MaybeUninit::<ffi::PyConfig>::uninit();
		ffi::PyConfig_InitIsolatedConfig(config.as_mut_ptr());
		let config = config.as_mut_ptr();
		(*config).site_import = 0;
		(*config).write_bytecode = 0;
		(*config).buffered_stdio = 0;
		// Keep CPython's own frozen bootstrap modules available. The desktop
		// stdlib and repo modules are registered in the table below; Android's
		// system stdlib is resolved from module_search_paths.
		(*config).use_frozen_modules = 1;
		check(ffi::PyConfig_SetBytesString(
			config,
			&raw mut (*config).program_name,
			c"omp-py".as_ptr(),
		));
		check(ffi::PyConfig_SetBytesString(
			config,
			&raw mut (*config).stdio_encoding,
			c"utf-8".as_ptr(),
		));
		(*config).module_search_paths_set = 1;
		for path in module_paths {
			let wide = ffi::Py_DecodeLocale(path.as_ptr(), null_mut());
			if wide.is_null() {
				tracing::error!("embedded Python search path decoding failed");
				panic!("failed to decode search path");
			}
			let status = ffi::PyWideStringList_Append(&raw mut (*config).module_search_paths, wide);
			ffi::PyMem_RawFree(wide.cast());
			check(status);
		}
		let status = ffi::Py_InitializeFromConfig(config);
		ffi::PyConfig_Clear(config);
		check(status);
		let initial = ffi::PyEval_SaveThread();
		if initial.is_null() {
			tracing::error!("embedded Python initialization created no thread state");
			panic!("CPython initialization did not create a thread state");
		}
	}
}
