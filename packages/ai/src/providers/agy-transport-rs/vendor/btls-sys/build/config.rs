use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

pub(crate) struct Config {
    pub(crate) manifest_dir: PathBuf,
    pub(crate) out_dir: PathBuf,
    pub(crate) is_bazel: bool,
    pub(crate) host: String,
    pub(crate) target: String,
    pub(crate) target_arch: String,
    pub(crate) target_os: String,
    pub(crate) unix: bool,
    pub(crate) target_env: String,
    pub(crate) target_features: Vec<String>,
    pub(crate) features: Features,
    pub(crate) env: Env,
}

pub(crate) struct Features {
    pub(crate) fips: bool,
    pub(crate) rpk: bool,
    pub(crate) underscore_wildcards: bool,
    pub(crate) prefix_symbols: bool,
}

pub(crate) struct Env {
    pub(crate) path: Option<PathBuf>,
    pub(crate) include_path: Option<PathBuf>,
    pub(crate) source_path: Option<PathBuf>,
    pub(crate) assume_patched: bool,
    pub(crate) sysroot: Option<PathBuf>,
    pub(crate) compiler_external_toolchain: Option<PathBuf>,
    pub(crate) debug: Option<OsString>,
    pub(crate) opt_level: Option<OsString>,
    pub(crate) android_ndk_home: Option<PathBuf>,
    pub(crate) cmake_toolchain_file: Option<PathBuf>,
    pub(crate) cpp_runtime_lib: Option<OsString>,
    /// C compiler (ignored if using FIPS)
    pub(crate) cc: Option<OsString>,
    pub(crate) cxx: Option<OsString>,
    pub(crate) docs_rs: bool,
    /// If set, built artifacts (libraries and patched headers) will be copied
    /// into this directory. The directory must exist and be empty.
    pub(crate) export_to_install_dir: Option<PathBuf>,
}

impl Config {
    pub(crate) fn from_env() -> Result<Self, &'static str> {
        let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
            .ok_or("CARGO_MANIFEST_DIR")?
            .into();
        let out_dir = env::var_os("OUT_DIR").ok_or("OUT_DIR")?.into();
        let host = env::var("HOST").unwrap();
        let target = env::var("TARGET").unwrap();
        let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
        let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
        let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap();
        let unix = env::var("CARGO_CFG_UNIX").is_ok();

        let target_features = env::var("CARGO_CFG_TARGET_FEATURE")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.to_owned())
            .collect();

        let features = Features::from_env();
        let env = Env::from_env(&host, &target, features.is_fips_like());

        let is_bazel = env
            .source_path
            .as_ref()
            .is_some_and(|path| path.join("src").exists());

        let config = Self {
            manifest_dir,
            out_dir,
            is_bazel,
            host,
            target,
            target_arch,
            target_os,
            unix,
            target_env,
            target_features,
            features,
            env,
        };

        config.check_feature_compatibility()?;

        Ok(config)
    }

    fn check_feature_compatibility(&self) -> Result<(), &'static str> {
        if self.features.fips && self.features.rpk {
            return Err("`fips` and `rpk` features are mutually exclusive");
        }

        let is_precompiled_native_lib = self.env.path.is_some();
        let is_external_native_lib_source =
            !is_precompiled_native_lib && self.env.source_path.is_none();

        if self.env.assume_patched && is_external_native_lib_source {
            return Err(
                "`BORING_BSSL_{{,_FIPS}}_ASSUME_PATCHED` env variable is supposed to be used with\
                `BORING_BSSL{{,_FIPS}}_PATH` or `BORING_BSSL{{,_FIPS}}_SOURCE_PATH` env variables",
            );
        }

        let features_with_patches_enabled = self.features.rpk || self.features.underscore_wildcards;

        let patches_required = features_with_patches_enabled && !self.env.assume_patched;

        if is_precompiled_native_lib && patches_required {
            println!(
                "cargo:warning=precompiled BoringSSL was provided, so patches will be ignored"
            );
        }

        if self.env.export_to_install_dir.is_some() && is_precompiled_native_lib {
            return Err("`BORING_BSSL{{,_FIPS_}}INSTALL_DIR` cannot be used together with a precompiled library");
        }
        Ok(())
    }
}

impl Features {
    fn from_env() -> Self {
        let fips = env::var_os("CARGO_FEATURE_FIPS").is_some();
        let rpk = env::var_os("CARGO_FEATURE_RPK").is_some();
        let underscore_wildcards = env::var_os("CARGO_FEATURE_UNDERSCORE_WILDCARDS").is_some();
        let prefix_symbols = env::var_os("CARGO_FEATURE_PREFIX_SYMBOLS").is_some();

        Self {
            fips,
            rpk,
            underscore_wildcards,
            prefix_symbols,
        }
    }

    pub(crate) fn is_fips_like(&self) -> bool {
        self.fips
    }
}

impl Env {
    fn from_env(host: &str, target: &str, is_fips_like: bool) -> Self {
        let var_prefix = if host == target { "HOST" } else { "TARGET" };
        let target_with_underscores = target.replace('-', "_");

        let target_only_var = |name: &str| {
            var(&format!("{name}_{target}"))
                .or_else(|| var(&format!("{name}_{target_with_underscores}")))
                .or_else(|| var(&format!("{var_prefix}_{name}")))
        };
        let target_var = |name: &str| target_only_var(name).or_else(|| var(name));

        let boringssl_var = |name: &str| {
            const BORING_BSSL_PREFIX: &str = "BORING_BSSL_";
            const BORING_BSSL_FIPS_PREFIX: &str = "BORING_BSSL_FIPS_";

            // The passed name is the non-fips version of the environment variable,
            // to help look for them in the repository.
            assert!(name.starts_with(BORING_BSSL_PREFIX));

            let non_fips = target_var(name);
            if is_fips_like {
                let fips_name = name.replace(BORING_BSSL_PREFIX, BORING_BSSL_FIPS_PREFIX);
                let fips = target_var(&fips_name);
                if fips.is_none() && non_fips.is_some() {
                    println!("cargo:warning=env var {name} ignored, because FIPS is enabled. Set {fips_name} instead.");
                }
                fips
            } else {
                non_fips
            }
        };

        Self {
            path: boringssl_var("BORING_BSSL_PATH").map(PathBuf::from), // gets BORING_BSSL_FIPS_PATH if fips is enabled
            include_path: boringssl_var("BORING_BSSL_INCLUDE_PATH").map(PathBuf::from), // gets BORING_BSSL_FIPS_INCLUDE_PATH if fips is enabled
            source_path: boringssl_var("BORING_BSSL_SOURCE_PATH").map(PathBuf::from), // gets BORING_BSSL_FIPS_SOURCE_PATH if fips is enabled
            assume_patched: boringssl_var("BORING_BSSL_ASSUME_PATCHED") // gets BORING_BSSL_FIPS_ASSUME_PATCHED if fips is enabled
                .is_some_and(|v| !v.is_empty()),
            sysroot: boringssl_var("BORING_BSSL_SYSROOT").map(PathBuf::from), // gets BORING_BSSL_FIPS_SYSROOT if fips is enabled
            compiler_external_toolchain: boringssl_var("BORING_BSSL_COMPILER_EXTERNAL_TOOLCHAIN") // gets BORING_BSSL_FIPS_COMPILER_EXTERNAL_TOOLCHAIN if fips is enabled
                .map(PathBuf::from),
            debug: target_var("DEBUG"),
            opt_level: target_var("OPT_LEVEL"),
            android_ndk_home: target_var("ANDROID_NDK_HOME").map(Into::into),
            cmake_toolchain_file: target_var("CMAKE_TOOLCHAIN_FILE").map(Into::into),
            cpp_runtime_lib: target_var("BORING_BSSL_RUST_CPPLIB"),
            // matches the `cc` crate
            cc: target_only_var("CC"),
            cxx: target_only_var("CXX"),
            docs_rs: var("DOCS_RS").is_some(),
            export_to_install_dir: boringssl_var("BORING_BSSL_INSTALL_DIR").map(PathBuf::from),
        }
    }
}

fn var(name: &str) -> Option<OsString> {
    println!("cargo:rerun-if-env-changed={name}");

    env::var_os(name)
}
