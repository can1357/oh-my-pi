#![cfg(unix)]

//! Trusted workspace Python extension fixture: the P9 registration pattern as a
//! reusable harness piece. One module is written under the project root,
//! registered behind the environment authority's CONTROL extension host, and
//! checked against the host's frozen registry evidence.

use std::{fs, path::Path};

use omp_core::{ArtifactDigest, Provenance, Str};
use omp_envd::{
	EnvServer, ExtensionDataBinding,
	exthost::{
		ActivationTrigger, DeclarationSet, ExtensionManifest, ServiceManifest, ToolDeclarationKey,
	},
	worker::{ExtHostSpec, HostKey},
};
use omp_ext::config::{StaticDeclaration, StaticDeclarations};

use crate::{Context as _, Result, error};

/// One single-module trusted workspace extension and the tools it registers
/// with `@omp.tool(name, rev=1)`.
#[derive(Clone, Copy, Debug)]
pub struct PythonExtension {
	module:  &'static str,
	source:  &'static str,
	tools:   &'static [&'static str],
	trusted: bool,
}

pub(super) struct ExtensionInstall {
	pub(super) spec:    ExtHostSpec,
	pub(super) binding: ExtensionDataBinding,
}

impl PythonExtension {
	/// Describes an extension whose module `module` has Python `source` and
	/// registers `tools`, each at revision 1.
	pub const fn new(
		module: &'static str,
		source: &'static str,
		tools: &'static [&'static str],
	) -> Self {
		Self { module, source, tools, trusted: false }
	}

	/// Lets the module publish hooks its manifest does not declare, as an
	/// operator-trusted module may.
	pub const fn trusting(mut self) -> Self {
		self.trusted = true;
		self
	}

	/// Returns the tool revision `InvokeTool.rev` must carry (`<module>.1`).
	pub fn revision(&self) -> String {
		format!("{}.1", self.module)
	}

	/// Writes the module under `root` and builds the host spec and DATA
	/// endpoint scoped to `session_id` and `generation`.
	pub(super) fn install(
		&self,
		root: &Path,
		state: &Path,
		session_id: &str,
		generation: u64,
	) -> Result<ExtensionInstall> {
		let entry = root.join(format!("{}.py", self.module));
		fs::write(&entry, self.source).context("install extension module")?;
		let key = HostKey::new("workspace", "trusted", self.module);
		let provenance = Provenance::new(
			Str::new_static("omp-e2e"),
			key.extension().clone(),
			Str::new_static("1.0.0"),
			ArtifactDigest::new([9; 32]),
			key.layer().clone(),
			key.tier().clone(),
			1,
		);
		let keys: Vec<ToolDeclarationKey> = self
			.tools
			.iter()
			.map(|name| ToolDeclarationKey::new(*name, self.module, 1))
			.collect();
		let declarations: Vec<StaticDeclaration> = keys
			.iter()
			.map(|tool| {
				let id = Str::from(format!("{}@{}.{}", tool.name, tool.family, tool.rev));
				StaticDeclaration {
					id: id.clone(),
					kind: Str::new_static("soft"),
					module: Str::new_static(self.module),
					trigger: Str::new_static("lazy"),
					key: id,
					api: 1,
					failure: Str::new_static("fault"),
					..StaticDeclaration::default()
				}
			})
			.collect();
		let mut manifest = ExtensionManifest::new_with_static(
			provenance,
			Str::new_static(self.module),
			[],
			DeclarationSet::new(keys, []),
			ServiceManifest::default(),
			StaticDeclarations {
				ordered: declarations.clone().into_boxed_slice(),
				tools: declarations.into_boxed_slice(),
				..StaticDeclarations::default()
			},
			[],
			[ActivationTrigger::FirstReach],
		);
		if self.trusted {
			manifest.trust_runtime_declarations();
		}
		let mut spec = ExtHostSpec::new(key.clone(), manifest);
		spec.python_site = Some(root.to_path_buf());
		spec.entry_path = Some(entry);
		let mut binding =
			ExtensionDataBinding::scoped(state, key, session_id, generation, spec.data_grants.clone());
		binding
			.prepare_endpoint()
			.context("prepare scoped extension DATA socket")?;
		spec.data_socket = Some(binding.path().to_owned());
		Ok(ExtensionInstall { spec, binding })
	}

	/// Proves `server` authenticated exactly this extension's CONTROL child and
	/// that the child registered every declared tool.
	pub(super) fn verify(&self, server: &EnvServer) -> Result<()> {
		let identities = server.extension_control_identities();
		let [identity] = identities.as_slice() else {
			return Err(error(format!(
				"expected one authenticated CONTROL child, got {}",
				identities.len()
			)));
		};
		if identity.extension.as_str() != self.module {
			return Err(error(format!(
				"CONTROL child authenticated as unexpected extension {:?}",
				identity.extension
			)));
		}
		let evidence = server
			.extension_registry_evidence(identity)
			.context("CONTROL child omitted frozen registry evidence")?;
		for tool in self.tools {
			let registered = evidence.tools.iter().any(|declaration| {
				declaration
					.definition
					.as_ref()
					.is_some_and(|definition| definition.name == *tool)
			});
			if !registered {
				return Err(error(format!("CONTROL child did not register {tool}")));
			}
		}
		Ok(())
	}
}
