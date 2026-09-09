//! Built-in Debug Adapter Protocol declarations and deterministic selection.

use std::{
	collections::BTreeMap,
	env,
	path::{Path, PathBuf},
};

use omp_core::{Str, sf};
use parking_lot::RwLock;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::docserver::lsp_registry;

pub(crate) const SKIP_ATTACH_REQUEST: &str = "skipAttachRequest";

/// How a debug adapter exchanges DAP frames with the document authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DapTransport {
	/// The adapter reads and writes DAP on standard streams.
	Stdio,
	/// The adapter listens on a TCP port substituted for `${port}`.
	Tcp {
		/// Argument token replaced with the allocated port.
		port_argument: Str,
	},
	/// The adapter listens on a Unix-domain socket substituted for `${socket}`.
	Unix {
		/// Argument token replaced with the socket path.
		socket_argument: Str,
	},
}

/// One immutable debug adapter declaration.
#[derive(Clone, Debug)]
pub struct DapAdapterSpec {
	/// Unique configured name.
	pub name: Str,
	/// Executable name or path.
	pub command: Str,
	/// Arguments before launch/attach-specific payloads.
	pub args: Vec<Str>,
	/// Byte transport used by the adapter.
	pub transport: DapTransport,
	/// Program extensions accepted without a leading dot.
	pub extensions: Vec<Str>,
	/// Project-root markers accepted by this adapter.
	pub root_markers: Vec<Str>,
	/// Whether a directory may be supplied as the launch program.
	pub accepts_directory_program: bool,
	/// Defaults merged below caller launch arguments.
	pub launch_defaults: Map<String, Value>,
	/// Defaults merged below caller attach arguments.
	/// `skipAttachRequest: true` marks an adapter that is already attached.
	pub attach_defaults: Map<String, Value>,
	/// Lower values win the deterministic preference tie-break.
	pub preference: u16,
}

impl DapAdapterSpec {
	/// Creates a validated adapter declaration.
	pub fn new(name: impl AsRef<str>, command: impl AsRef<str>) -> Result<Self, DapAdapterError> {
		let name = name.as_ref();
		let command = command.as_ref();
		if name.is_empty() || command.is_empty() {
			return Err(DapAdapterError::InvalidSpec(sf!(
				"adapter name and command must be non-empty",
			)));
		}
		Ok(Self {
			name: Str::new(name),
			command: Str::new(command),
			args: Vec::new(),
			transport: DapTransport::Stdio,
			extensions: Vec::new(),
			root_markers: Vec::new(),
			accepts_directory_program: false,
			launch_defaults: Map::new(),
			attach_defaults: Map::new(),
			preference: u16::MAX,
		})
	}

	/// Applies launch or attach defaults without replacing caller values.
	pub fn merged_arguments(
		&self,
		attach: bool,
		supplied: &Map<String, Value>,
	) -> Map<String, Value> {
		let mut merged = if attach {
			self.attach_defaults.clone()
		} else {
			self.launch_defaults.clone()
		};
		merged.extend(supplied.clone());
		if attach {
			merged.remove(SKIP_ATTACH_REQUEST);
			if self.skip_attach_request() {
				merged.insert(SKIP_ATTACH_REQUEST.to_owned(), Value::Bool(true));
			}
		}
		merged
	}

	/// Returns whether this adapter establishes its target connection before
	/// the DAP handshake and therefore needs no `attach` request.
	pub fn skip_attach_request(&self) -> bool {
		self
			.attach_defaults
			.get(SKIP_ATTACH_REQUEST)
			.and_then(Value::as_bool)
			.unwrap_or(false)
	}

	/// Applies adapter-specific launch defaults derived from the resolved
	/// program. Delve debugs Go sources/directories and executes binaries.
	pub fn launch_arguments(
		&self,
		program: &Path,
		supplied: &Map<String, Value>,
	) -> Map<String, Value> {
		let mut merged = self.launch_defaults.clone();
		if self.name == "dlv" {
			let mode = if program.is_dir()
				|| program.extension().and_then(|value| value.to_str()) == Some("go")
			{
				"debug"
			} else {
				"exec"
			};
			merged.insert("mode".to_owned(), Value::String(mode.to_owned()));
		}
		merged.extend(supplied.clone());
		merged
	}
}

/// Stable process-local identity of an installed DAP adapter.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DapAdapterId(u64);

impl DapAdapterId {
	/// Returns the registry-local integer.
	pub const fn get(self) -> u64 {
		self.0
	}
}

/// Public installed adapter row.
#[derive(Clone, Debug)]
pub struct DapAdapterInfo {
	/// Stable registry identity.
	pub id:   DapAdapterId,
	/// Installed declaration.
	pub spec: DapAdapterSpec,
}

/// Result of launch adapter selection.
#[derive(Clone, Debug)]
pub enum LaunchAdapterSelection {
	/// The selected adapter command exists.
	Available(DapAdapterInfo),
	/// Selection succeeded but the configured executable is absent.
	Unavailable {
		/// Selected adapter.
		adapter:  DapAdapterInfo,
		/// Missing command.
		command:  Str,
		/// Actionable installation or discovery guidance.
		guidance: Option<Str>,
	},
	/// No configured adapter accepts the target.
	NoMatch,
}

/// Registry mutation or selection failure.
#[derive(Clone, Debug, Error)]
pub enum DapAdapterError {
	/// A declaration is incomplete or inconsistent.
	#[error("invalid DAP adapter: {0}")]
	InvalidSpec(Str),
	/// Another declaration already owns the name.
	#[error("DAP adapter {0:?} is already installed")]
	Duplicate(Str),
}

#[derive(Default)]
struct RegistryState {
	next_id: u64,
	by_name: BTreeMap<Str, DapAdapterInfo>,
}

/// Project-scoped DAP adapter registry, intentionally separate from LSP
/// bindings.
#[derive(Default)]
pub struct DapAdapterRegistry {
	state: RwLock<RegistryState>,
}

impl DapAdapterRegistry {
	/// Creates a registry populated with OMP's built-in adapters.
	pub fn with_builtins() -> Self {
		let registry = Self::default();
		for spec in builtin_adapters() {
			registry
				.install(spec)
				.expect("built-in DAP declarations are unique");
		}
		registry
	}

	/// Installs one unique named adapter.
	pub fn install(&self, spec: DapAdapterSpec) -> Result<DapAdapterId, DapAdapterError> {
		let mut state = self.state.write();
		if state.by_name.contains_key(&spec.name) {
			return Err(DapAdapterError::Duplicate(spec.name));
		}
		state.next_id = state
			.next_id
			.checked_add(1)
			.expect("DAP adapter id space exhausted");
		let id = DapAdapterId(state.next_id);
		state
			.by_name
			.insert(spec.name.clone(), DapAdapterInfo { id, spec });
		Ok(id)
	}

	/// Replaces a declaration while preserving its stable registry identity.
	pub fn replace(&self, spec: DapAdapterSpec) -> Result<DapAdapterId, DapAdapterError> {
		let mut state = self.state.write();
		if let Some(current) = state.by_name.get_mut(&spec.name) {
			current.spec = spec;
			return Ok(current.id);
		}
		drop(state);
		self.install(spec)
	}

	/// Returns installed adapters in deterministic name order.
	pub fn list(&self) -> Vec<DapAdapterInfo> {
		self.state.read().by_name.values().cloned().collect()
	}

	/// Resolves js-debug installation locations, preferring the
	/// explicit environment path, then Mason, then `~/.local/opt/js-debug`.
	/// The discovered script replaces the synthetic built-in command.
	pub fn discover_js_debug(
		&self,
		project_root: &Path,
		home: &Path,
		xdg_data_home: Option<&Path>,
		configured: Option<&Path>,
	) -> Option<DapAdapterId> {
		let script = discover_js_debug_server(project_root, home, xdg_data_home, configured)?;
		let node = resolve_path_command("node")?;
		let mut spec = self
			.state
			.read()
			.by_name
			.get("js-debug-adapter")?
			.spec
			.clone();
		spec.command = Str::new(node.to_string_lossy());
		spec.args = vec![
			Str::new(script.to_string_lossy()),
			Str::new_static("${port}"),
			Str::new_static("127.0.0.1"),
		];
		spec.transport = DapTransport::Tcp { port_argument: Str::new_static("${port}") };
		self.replace(spec).ok()
	}

	/// Resolves js-debug using `JS_DEBUG_DAP_SERVER`, XDG data, and HOME.
	pub fn discover_js_debug_from_env(&self, project_root: &Path) -> Option<DapAdapterId> {
		let home = env::var_os("HOME").map(PathBuf::from)?;
		let xdg = env::var_os("XDG_DATA_HOME").map(PathBuf::from);
		let configured = env::var_os("JS_DEBUG_DAP_SERVER").map(PathBuf::from);
		self.discover_js_debug(project_root, &home, xdg.as_deref(), configured.as_deref())
	}

	/// Selects a launch adapter by extension, root marker, preference, then
	/// name.
	pub fn select_launch(&self, program: &Path, project_root: &Path) -> LaunchAdapterSelection {
		let is_directory = program.is_dir();
		let extension = program
			.extension()
			.and_then(|value| value.to_str())
			.unwrap_or_default();
		let mut candidates = self
			.list()
			.into_iter()
			.filter_map(|adapter| {
				if is_directory && !adapter.spec.accepts_directory_program {
					return None;
				}
				let extension_rank = adapter
					.spec
					.extensions
					.iter()
					.any(|candidate| candidate.trim_start_matches('.') == extension);
				let marker_rank =
					lsp_registry::root_marker_ancestor(program, &adapter.spec.root_markers)
						.is_some_and(|root| root.starts_with(project_root));
				if !extension_rank && !marker_rank && !extension.is_empty() {
					return None;
				}
				if extension.is_empty()
					&& !marker_rank
					&& !matches!(adapter.spec.name.as_str(), "gdb" | "lldb-dap")
				{
					return None;
				}
				Some((
					!extension_rank,
					!marker_rank,
					adapter.spec.preference,
					adapter.spec.name.clone(),
					adapter,
				))
			})
			.collect::<Vec<_>>();
		candidates.sort_by(|left, right| {
			left
				.0
				.cmp(&right.0)
				.then(left.1.cmp(&right.1))
				.then(left.2.cmp(&right.2))
				.then(left.3.cmp(&right.3))
		});
		let Some((_, _, _, _, adapter)) = candidates.into_iter().next() else {
			return LaunchAdapterSelection::NoMatch;
		};
		if command_available(adapter.spec.command.as_str()) {
			LaunchAdapterSelection::Available(adapter)
		} else {
			let guidance = unavailable_guidance(adapter.spec.name.as_str());
			LaunchAdapterSelection::Unavailable {
				command: adapter.spec.command.clone(),
				adapter,
				guidance,
			}
		}
	}

	/// Selects attach by explicit name, a port hint (debugpy first), or
	/// preference.
	pub fn select_attach(
		&self,
		preferred: Option<&str>,
		port: Option<u16>,
	) -> Option<DapAdapterInfo> {
		let mut adapters = self.list();
		if let Some(preferred) = preferred {
			return adapters
				.into_iter()
				.find(|adapter| adapter.spec.name.as_str() == preferred);
		}
		adapters.retain(|adapter| command_available(adapter.spec.command.as_str()));
		adapters.sort_by_key(|adapter| {
			let port_rank = if port.is_some() {
				match adapter.spec.name.as_str() {
					"debugpy" => 0_u8,
					"gdb" | "lldb-dap" => 1,
					_ => 2,
				}
			} else {
				0
			};
			(port_rank, adapter.spec.preference, adapter.spec.name.clone())
		});
		adapters.into_iter().next()
	}
}

fn command_available(command: &str) -> bool {
	resolve_path_command(command).is_some()
}

fn resolve_path_command(command: &str) -> Option<PathBuf> {
	let path = Path::new(command);
	if path.components().count() > 1 {
		return path.is_file().then(|| path.to_owned());
	}
	env::var_os("PATH").and_then(|paths| {
		env::split_paths(&paths).find_map(|directory| {
			executable_candidates(&directory, command)
				.into_iter()
				.find(|path| path.is_file())
		})
	})
}

/// Locates the js-debug server script in priority order.
pub fn discover_js_debug_server(
	project_root: &Path,
	home: &Path,
	xdg_data_home: Option<&Path>,
	configured: Option<&Path>,
) -> Option<PathBuf> {
	let data_home = xdg_data_home
		.map(Path::to_owned)
		.unwrap_or_else(|| home.join(".local/share"));
	let configured = configured.map(|path| {
		if path.is_absolute() {
			path.to_owned()
		} else {
			project_root.join(path)
		}
	});
	configured
		.into_iter()
		.chain([
			data_home.join("nvim/mason/packages/js-debug-adapter/js-debug/src/dapDebugServer.js"),
			home.join(".local/opt/js-debug/src/dapDebugServer.js"),
		])
		.find(|path| path.is_file())
}

/// Converts known adapter startup diagnostics into actionable installation
/// guidance without hiding the original process failure.
pub fn dap_startup_guidance(adapter: &str, diagnostic: &str) -> Option<Str> {
	if adapter == "debugpy"
		&& (diagnostic.contains("No module named debugpy")
			|| diagnostic.contains("No module named 'debugpy'"))
	{
		return Some(Str::new_static(
			"debugpy is unavailable; install it with `python -m pip install debugpy`",
		));
	}
	unavailable_guidance(adapter)
}

fn unavailable_guidance(adapter: &str) -> Option<Str> {
	match adapter {
		"debugpy" => Some(Str::new_static(
			"debugpy is unavailable; install it with `python -m pip install debugpy`",
		)),
		"js-debug-adapter" => Some(Str::new_static(
			"js-debug is unavailable; set JS_DEBUG_DAP_SERVER or install js-debug under Mason or \
			 ~/.local/opt/js-debug",
		)),
		_ => None,
	}
}

#[cfg(windows)]
fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
	let mut candidates = vec![directory.join(command)];
	if Path::new(command).extension().is_none() {
		for extension in env::var_os("PATHEXT")
			.unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
			.to_string_lossy()
			.split(';')
		{
			candidates.push(directory.join(format!("{command}{extension}")));
		}
	}
	candidates
}

#[cfg(not(windows))]
fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
	vec![directory.join(command)]
}

pub(crate) fn builtin_adapters() -> Vec<DapAdapterSpec> {
	struct Builtin<'a> {
		name:       &'a str,
		command:    &'a str,
		args:       &'a [&'a str],
		extensions: &'a [&'a str],
		markers:    &'a [&'a str],
		launch:     Value,
		attach:     Value,
		directory:  bool,
		tcp:        bool,
	}
	let builtins = vec![
		Builtin {
			name:       "gdb",
			command:    "gdb",
			args:       &["-i", "dap"],
			extensions: &["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "rs"],
			markers:    &["Makefile", "CMakeLists.txt", "Cargo.toml", "compile_commands.json"],
			launch:     serde_json::json!({"request":"launch","stopOnEntry":true,"stopAtBeginningOfMainSubprogram":true}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "lldb-dap",
			command:    "lldb-dap",
			args:       &[],
			extensions: &["c", "cc", "cpp", "cxx", "m", "mm", "swift", "rs", "zig"],
			markers:    &["Package.swift", "Cargo.toml", "Makefile", "CMakeLists.txt", "build.zig"],
			launch:     serde_json::json!({"request":"launch","stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "codelldb",
			command:    "codelldb",
			args:       &["--port", "${port}"],
			extensions: &["c", "cc", "cpp", "cxx", "rs", "zig"],
			markers:    &[
				"Cargo.toml",
				"CMakeLists.txt",
				"Makefile",
				"compile_commands.json",
				"build.zig",
			],
			launch:     serde_json::json!({"request":"launch","stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        true,
		},
		Builtin {
			name:       "debugpy",
			command:    "python",
			args:       &["-m", "debugpy.adapter"],
			extensions: &["py"],
			markers:    &["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
			launch:     serde_json::json!({"request":"launch","justMyCode":false,"stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach","justMyCode":false}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "dlv",
			command:    "dlv",
			args:       &["dap", "--listen=127.0.0.1:${port}"],
			extensions: &["go"],
			markers:    &["go.mod", "go.sum", "go.work"],
			launch:     serde_json::json!({"request":"launch","mode":"debug","stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach","mode":"local"}),
			directory:  true,
			tcp:        true,
		},
		Builtin {
			name:       "js-debug-adapter",
			command:    "js-debug-adapter",
			args:       &[],
			extensions: &["js", "jsx", "ts", "tsx", "mjs", "cjs"],
			markers:    &["package.json", "tsconfig.json", "jsconfig.json"],
			launch:     serde_json::json!({"request":"launch","type":"pwa-node","stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach","type":"pwa-node"}),
			directory:  false,
			tcp:        true,
		},
		Builtin {
			name:       "netcoredbg",
			command:    "netcoredbg",
			args:       &["--interpreter=vscode"],
			extensions: &["cs", "csx", "fs", "fsx"],
			markers:    &["*.sln", "*.csproj", "*.fsproj", "global.json"],
			launch:     serde_json::json!({"request":"launch","stopAtEntry":true}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "kotlin-debug-adapter",
			command:    "kotlin-debug-adapter",
			args:       &[],
			extensions: &["kt", "kts"],
			markers:    &[
				"build.gradle",
				"build.gradle.kts",
				"pom.xml",
				"settings.gradle",
				"settings.gradle.kts",
			],
			launch:     serde_json::json!({"request":"launch","mainClass":"","projectRoot":""}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "rdbg",
			command:    "rdbg",
			args:       &["--open", "--command", "--"],
			extensions: &["rb", "rake", "gemspec"],
			markers:    &["Gemfile", "Rakefile", ".ruby-version"],
			launch:     serde_json::json!({"request":"launch","type":"rdbg"}),
			attach:     serde_json::json!({"request":"attach","type":"rdbg"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "php-debug-adapter",
			command:    "php-debug-adapter",
			args:       &[],
			extensions: &["php", "phtml"],
			markers:    &["composer.json", "composer.lock"],
			launch:     serde_json::json!({"request":"launch","stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "bash-debug-adapter",
			command:    "bash-debug-adapter",
			args:       &[],
			extensions: &["sh", "bash"],
			markers:    &[".git"],
			launch:     serde_json::json!({"request":"launch","type":"bashdb","pathBashdb":"bashdb","pathBash":"bash"}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "dart-debug-adapter",
			command:    "dart",
			args:       &["debug_adapter"],
			extensions: &["dart"],
			markers:    &["pubspec.yaml", "pubspec.lock"],
			launch:     serde_json::json!({"request":"launch","stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "flutter-debug-adapter",
			command:    "dart",
			args:       &["debug_adapter", "--flutter-sdk-path", ""],
			extensions: &["dart"],
			markers:    &["pubspec.yaml", "android", "ios", "lib/main.dart"],
			launch:     serde_json::json!({"request":"launch"}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
		Builtin {
			name:       "elixir-ls-debugger",
			command:    "elixir-ls-debugger",
			args:       &[],
			extensions: &["ex", "exs", "heex", "eex"],
			markers:    &["mix.exs", "mix.lock"],
			launch:     serde_json::json!({"request":"launch","type":"mix_task","task":"run","stopOnEntry":true}),
			attach:     serde_json::json!({"request":"attach"}),
			directory:  false,
			tcp:        false,
		},
	];
	builtins
		.into_iter()
		.enumerate()
		.map(|(preference, builtin)| {
			let mut spec =
				DapAdapterSpec::new(builtin.name, builtin.command).expect("static adapter declaration");
			spec.args = builtin.args.iter().copied().map(Str::new_static).collect();
			spec.extensions = builtin
				.extensions
				.iter()
				.copied()
				.map(Str::new_static)
				.collect();
			spec.root_markers = builtin
				.markers
				.iter()
				.copied()
				.map(Str::new_static)
				.collect();
			spec.accepts_directory_program = builtin.directory;
			spec.launch_defaults = builtin
				.launch
				.as_object()
				.cloned()
				.expect("launch defaults object");
			spec.attach_defaults = builtin
				.attach
				.as_object()
				.cloned()
				.expect("attach defaults object");
			spec.preference = u16::try_from(preference).expect("small built-in adapter set");
			if builtin.tcp {
				spec.transport = DapTransport::Tcp { port_argument: Str::new_static("${port}") };
			}
			spec
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	#[test]
	fn extensionless_order_is_gdb_then_lldb() {
		let registry = DapAdapterRegistry::with_builtins();
		let root = tempfile::tempdir().unwrap();
		let selection = registry.select_launch(&root.path().join("program"), root.path());
		match selection {
			LaunchAdapterSelection::Available(adapter)
			| LaunchAdapterSelection::Unavailable { adapter, .. } => assert_eq!(adapter.spec.name, "gdb"),
			LaunchAdapterSelection::NoMatch => panic!("extensionless debugger"),
		}
	}

	#[test]
	fn delve_launch_mode_tracks_program_shape() {
		let registry = DapAdapterRegistry::with_builtins();
		let dlv = registry
			.list()
			.into_iter()
			.find(|adapter| adapter.spec.name == "dlv")
			.unwrap();
		let root = tempfile::tempdir().unwrap();
		let source = root.path().join("main.go");
		fs::write(&source, b"package main").unwrap();
		assert_eq!(dlv.spec.launch_arguments(&source, &Map::new())["mode"], "debug");
		let binary = root.path().join("app");
		fs::write(&binary, b"").unwrap();
		assert_eq!(dlv.spec.launch_arguments(&binary, &Map::new())["mode"], "exec");
	}

	#[test]
	fn js_debug_discovery_prefers_configured_path() {
		let root = tempfile::tempdir().unwrap();
		let home = tempfile::tempdir().unwrap();
		let configured = root.path().join("configured/dapDebugServer.js");
		fs::create_dir_all(configured.parent().unwrap()).unwrap();
		fs::write(&configured, b"").unwrap();
		let mason = home
			.path()
			.join(".local/share/nvim/mason/packages/js-debug-adapter/js-debug/src/dapDebugServer.js");
		fs::create_dir_all(mason.parent().unwrap()).unwrap();
		fs::write(&mason, b"").unwrap();
		assert_eq!(
			discover_js_debug_server(
				root.path(),
				home.path(),
				None,
				Some(Path::new("configured/dapDebugServer.js"))
			),
			Some(configured),
		);
	}

	#[test]
	fn directory_launch_restricts_to_capable_adapter() {
		let registry = DapAdapterRegistry::with_builtins();
		let root = tempfile::tempdir().unwrap();
		fs::write(root.path().join("go.mod"), b"module example").unwrap();
		let selection = registry.select_launch(root.path(), root.path());
		match selection {
			LaunchAdapterSelection::Available(adapter)
			| LaunchAdapterSelection::Unavailable { adapter, .. } => assert_eq!(adapter.spec.name, "dlv"),
			LaunchAdapterSelection::NoMatch => panic!("directory debugger"),
		}
	}
}
