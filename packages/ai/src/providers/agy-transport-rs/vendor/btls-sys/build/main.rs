use core::panic;
use fslock::LockFile;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::process::{Command, Output};
use std::sync::OnceLock;

use crate::config::Config;
use crate::prefix::{prefix_symbols, PrefixCallback};

mod config;
mod prefix;

fn should_use_cmake_cross_compilation(config: &Config) -> bool {
    if config.host == config.target {
        return false;
    }
    match config.target_os.as_str() {
        "macos" | "ios" => {
            // Cross-compiling for Apple platforms on macOS is supported using the normal Xcode
            // tools, along with the settings from `cmake_params_apple`.
            !config.host.ends_with("-darwin")
        }
        _ => true,
    }
}

// Android NDK >= 19.
const CMAKE_PARAMS_ANDROID_NDK: &[(&str, &[(&str, &str)])] = &[
    ("aarch64", &[("ANDROID_ABI", "arm64-v8a")]),
    ("arm", &[("ANDROID_ABI", "armeabi-v7a")]),
    ("x86", &[("ANDROID_ABI", "x86")]),
    ("x86_64", &[("ANDROID_ABI", "x86_64")]),
];

fn cmake_params_android(config: &Config) -> &'static [(&'static str, &'static str)] {
    for (android_arch, params) in CMAKE_PARAMS_ANDROID_NDK {
        if *android_arch == config.target_arch {
            return params;
        }
    }
    &[]
}

const CMAKE_PARAMS_APPLE: &[(&str, &[(&str, &str)])] = &[
    // iOS
    (
        "aarch64-apple-ios",
        &[
            ("CMAKE_OSX_ARCHITECTURES", "arm64"),
            ("CMAKE_OSX_SYSROOT", "iphoneos"),
            ("CMAKE_MACOSX_BUNDLE", "OFF"),
        ],
    ),
    (
        "aarch64-apple-ios-sim",
        &[
            ("CMAKE_OSX_ARCHITECTURES", "arm64"),
            ("CMAKE_OSX_SYSROOT", "iphonesimulator"),
            ("CMAKE_MACOSX_BUNDLE", "OFF"),
        ],
    ),
    (
        "x86_64-apple-ios",
        &[
            ("CMAKE_OSX_ARCHITECTURES", "x86_64"),
            ("CMAKE_OSX_SYSROOT", "iphonesimulator"),
            ("CMAKE_MACOSX_BUNDLE", "OFF"),
        ],
    ),
    // macOS
    (
        "aarch64-apple-darwin",
        &[
            ("CMAKE_OSX_ARCHITECTURES", "arm64"),
            ("CMAKE_OSX_SYSROOT", "macosx"),
        ],
    ),
    (
        "x86_64-apple-darwin",
        &[
            ("CMAKE_OSX_ARCHITECTURES", "x86_64"),
            ("CMAKE_OSX_SYSROOT", "macosx"),
        ],
    ),
];

fn cmake_params_apple(config: &Config) -> &'static [(&'static str, &'static str)] {
    for (next_target, params) in CMAKE_PARAMS_APPLE {
        if *next_target == config.target {
            return params;
        }
    }
    &[]
}

fn get_apple_sdk_name(config: &Config) -> &'static str {
    for (name, value) in cmake_params_apple(config) {
        if *name == "CMAKE_OSX_SYSROOT" {
            return value;
        }
    }

    panic!(
        "cannot find SDK for {} in CMAKE_PARAMS_APPLE",
        config.target
    );
}

/// Returns an absolute path to the BoringSSL source.
fn get_boringssl_source_path(config: &Config) -> &Path {
    static SOURCE_PATH: OnceLock<PathBuf> = OnceLock::new();

    SOURCE_PATH.get_or_init(|| {
        if let Some(src_path) = &config.env.source_path {
            if !src_path.exists() {
                println!(
                    "cargo:warning=boringssl source path doesn't exist: {}",
                    src_path.display()
                );
            }
            return src_path.into();
        }

        let submodule_dir = "boringssl";

        let src_path = config.out_dir.join(submodule_dir);

        let submodule_path = config.manifest_dir.join("deps").join(submodule_dir);

        if !submodule_path.join("CMakeLists.txt").exists() {
            println!("cargo:warning=fetching boringssl git submodule");

            run_command(
                Command::new("git")
                    .args(["submodule", "update", "--init", "--recursive"])
                    .arg(&submodule_path),
            )
            .expect("git submodule update");
        }

        let _ = fs::remove_dir_all(&src_path);
        fs_extra::dir::copy(submodule_path, &config.out_dir, &Default::default())
            .inspect_err(|_| {
                let _ = fs::remove_dir_all(&config.out_dir);
            })
            .expect("copying failed. Try running `cargo clean`");

        // NOTE: .git can be both file and dir, depening on whether it was copied from a submodule
        // or created by the patches code.
        let src_git_path = src_path.join(".git");
        let _ = fs::remove_file(&src_git_path);
        let _ = fs::remove_dir_all(&src_git_path);

        src_path
    })
}

/// Returns the platform-specific output path for lib.
///
/// MSVC generator on Windows place static libs in a target sub-folder,
/// so adjust library location based on platform and build target.
/// See issue: <https://github.com/alexcrichton/cmake-rs/issues/18>
fn msvc_lib_subdir(config: &Config) -> Option<&'static str> {
    if config.target.ends_with("-msvc") {
        // Code under this branch should match the logic in cmake-rs
        let debug_env_var = config
            .env
            .debug
            .as_ref()
            .expect("DEBUG variable not defined in env");

        let deb_info = match debug_env_var.to_str() {
            Some("false") => false,
            Some("true") => true,
            _ => panic!("Unknown DEBUG={debug_env_var:?} env var."),
        };

        let opt_env_var = config
            .env
            .opt_level
            .as_ref()
            .expect("OPT_LEVEL variable not defined in env");

        let subdir = match opt_env_var.to_str() {
            Some("0") => "Debug",
            Some("1" | "2" | "3") => {
                if deb_info {
                    "RelWithDebInfo"
                } else {
                    "Release"
                }
            }
            Some("s" | "z") => "MinSizeRel",
            _ => panic!("Unknown OPT_LEVEL={opt_env_var:?} env var."),
        };

        Some(subdir)
    } else {
        None
    }
}

/// Returns a new `cmake::Config` for building BoringSSL.
///
/// It will add platform-specific parameters if needed.
fn get_boringssl_cmake_config(config: &Config) -> cmake::Config {
    let src_path = get_boringssl_source_path(config);
    let mut boringssl_cmake = cmake::Config::new(src_path);

    if config.env.cmake_toolchain_file.is_some() {
        return boringssl_cmake;
    }

    if config.target_os == "windows" {
        // Explicitly use the non-debug CRT.
        // This is required now because newest BoringSSL requires CMake 3.22 which
        // uses the new logic with CMAKE_MSVC_RUNTIME_LIBRARY introduced in CMake 3.15.
        // https://github.com/rust-lang/cmake-rs/pull/30#issuecomment-2969758499
        if config.target_features.iter().any(|f| f == "crt-static") {
            boringssl_cmake.define("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreaded");
        } else {
            boringssl_cmake.define("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreadedDLL");
        }
    }

    if config.host == config.target {
        return boringssl_cmake;
    }

    if should_use_cmake_cross_compilation(config) {
        boringssl_cmake
            .define("CMAKE_CROSSCOMPILING", "true")
            .define("CMAKE_C_COMPILER_TARGET", &config.target)
            .define("CMAKE_CXX_COMPILER_TARGET", &config.target)
            .define("CMAKE_ASM_COMPILER_TARGET", &config.target);
    }

    if !config.features.fips {
        if let Some(cc) = &config.env.cc {
            boringssl_cmake.define("CMAKE_C_COMPILER", cc);
        }
        if let Some(cxx) = &config.env.cxx {
            boringssl_cmake.define("CMAKE_CXX_COMPILER", cxx);
        }
    }

    if let Some(sysroot) = &config.env.sysroot {
        boringssl_cmake.define("CMAKE_SYSROOT", sysroot);
    }

    if let Some(toolchain) = &config.env.compiler_external_toolchain {
        boringssl_cmake
            .define("CMAKE_C_COMPILER_EXTERNAL_TOOLCHAIN", toolchain)
            .define("CMAKE_CXX_COMPILER_EXTERNAL_TOOLCHAIN", toolchain)
            .define("CMAKE_ASM_COMPILER_EXTERNAL_TOOLCHAIN", toolchain);
    }

    // Add platform-specific parameters for cross-compilation.
    match &*config.target_os {
        "android" => {
            // We need ANDROID_NDK_HOME to be set properly.
            let android_ndk_home = config
                .env
                .android_ndk_home
                .as_ref()
                .expect("Please set ANDROID_NDK_HOME for Android build");
            for (name, value) in cmake_params_android(config) {
                eprintln!("android arch={} add {}={}", config.target_arch, name, value);
                boringssl_cmake.define(name, value);
            }
            let toolchain_file = android_ndk_home.join("build/cmake/android.toolchain.cmake");
            let toolchain_file = toolchain_file.to_str().unwrap();
            eprintln!("android toolchain={toolchain_file}");
            boringssl_cmake.define("CMAKE_TOOLCHAIN_FILE", toolchain_file);

            // 21 is the minimum level tested. You can give higher value.
            boringssl_cmake.define("CMAKE_SYSTEM_VERSION", "21");
            boringssl_cmake.define("CMAKE_ANDROID_STL_TYPE", "c++_shared");
        }

        "macos" => {
            for (name, value) in cmake_params_apple(config) {
                eprintln!("macos arch={} add {}={}", config.target_arch, name, value);
                boringssl_cmake.define(name, value);
            }
        }

        "ios" => {
            for (name, value) in cmake_params_apple(config) {
                eprintln!("ios arch={} add {}={}", config.target_arch, name, value);
                boringssl_cmake.define(name, value);
            }

            // Bitcode is always on.
            let bitcode_cflag = "-fembed-bitcode";

            // Hack for Xcode 10.1.
            let target_cflag = if config.target_arch == "x86_64" {
                "-target x86_64-apple-ios-simulator"
            } else {
                ""
            };

            let cflag = format!("{bitcode_cflag} {target_cflag}");
            boringssl_cmake.define("CMAKE_ASM_FLAGS", &cflag);
            boringssl_cmake.cflag(&cflag);
        }

        "windows" if config.host.contains("windows") => {
            // BoringSSL's CMakeLists.txt isn't set up for cross-compiling using Visual Studio.
            // Disable assembly support so that it at least builds.
            boringssl_cmake.define("OPENSSL_NO_ASM", "YES");
        }

        "linux" => match &*config.target_arch {
            "x86" => {
                boringssl_cmake.define(
                    "CMAKE_TOOLCHAIN_FILE",
                    // `src_path` can be a path relative to the manifest dir, but
                    // cmake hates that.
                    config
                        .manifest_dir
                        .join(src_path)
                        .join("util/32-bit-toolchain.cmake")
                        .as_os_str(),
                );
            }
            "aarch64" => {
                boringssl_cmake.define(
                    "CMAKE_TOOLCHAIN_FILE",
                    config
                        .manifest_dir
                        .join("cmake/aarch64-linux.cmake")
                        .as_os_str(),
                );
            }
            "arm" => {
                boringssl_cmake.define(
                    "CMAKE_TOOLCHAIN_FILE",
                    config
                        .manifest_dir
                        .join("cmake/armv7-linux.cmake")
                        .as_os_str(),
                );
            }
            _ => {
                println!(
                    "cargo:warning=no toolchain file configured by btls-sys for {}",
                    config.target
                );
            }
        },

        _ => {}
    }

    boringssl_cmake
}

fn pick_best_android_ndk_toolchain(toolchains_dir: &Path) -> io::Result<OsString> {
    let toolchains = std::fs::read_dir(toolchains_dir)?.collect::<Result<Vec<_>, _>>()?;
    // First look for one of the toolchains that Google has documented.
    // https://developer.android.com/ndk/guides/other_build_systems
    for known_toolchain in ["linux-x86_64", "darwin-x86_64", "windows-x86_64"] {
        if let Some(toolchain) = toolchains
            .iter()
            .find(|entry| entry.file_name() == known_toolchain)
        {
            return Ok(toolchain.file_name());
        }
    }
    // Then fall back to any subdirectory, in case Google has added support for a new host.
    // (Maybe there's a linux-aarch64 toolchain now.)
    if let Some(toolchain) = toolchains
        .into_iter()
        .find(|entry| entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false))
    {
        return Ok(toolchain.file_name());
    }
    // Finally give up.
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no subdirectories at given path",
    ))
}

fn get_extra_clang_args_for_bindgen(config: &Config) -> Vec<String> {
    let mut params = Vec::new();

    // Add platform-specific parameters.
    match &*config.target_os {
        "ios" | "macos" => {
            // When cross-compiling for Apple targets, tell bindgen to use SDK sysroot,
            // and *don't* use system headers of the host macOS.
            let sdk = get_apple_sdk_name(config);
            match run_command(Command::new("xcrun").args(["--show-sdk-path", "--sdk", sdk])) {
                Ok(output) => {
                    let sysroot = std::str::from_utf8(&output.stdout).expect("xcrun output");
                    params.push("-isysroot".to_string());
                    // There is typically a newline at the end which confuses clang.
                    params.push(sysroot.trim_end().to_string());
                }
                Err(e) => {
                    println!("cargo:warning={e}");
                    // Uh... let's try anyway, I guess?
                }
            }
        }
        "android" => {
            let mut android_sysroot = config
                .env
                .android_ndk_home
                .clone()
                .expect("Please set ANDROID_NDK_HOME for Android build");

            android_sysroot.extend(["toolchains", "llvm", "prebuilt"]);

            match pick_best_android_ndk_toolchain(&android_sysroot) {
                Ok(toolchain) => {
                    android_sysroot.push(toolchain);
                    android_sysroot.push("sysroot");
                    params.push("--sysroot".to_string());
                    params.push(android_sysroot.into_os_string().into_string().unwrap());
                }
                Err(e) => {
                    println!("cargo:warning=failed to find prebuilt Android NDK toolchain for bindgen: {e}");
                    // Uh... let's try anyway, I guess?
                }
            }
        }
        _ => {}
    }

    params
}

fn ensure_patches_applied(config: &Config) -> io::Result<()> {
    if config.env.assume_patched || config.env.path.is_some() {
        println!(
            "cargo:warning=skipping git patches application, provided\
            native BoringSSL is expected to have the patches included"
        );
        return Ok(());
    } else if config.env.source_path.is_some()
        && (config.features.rpk || config.features.underscore_wildcards)
    {
        panic!(
            "BORING_BSSL_ASSUME_PATCHED must be set when setting
               BORING_BSSL_SOURCE_PATH and using any of the following
               features: rpk, underscore-wildcards"
        );
    }

    let mut lock_file = LockFile::open(&config.out_dir.join(".patch_lock"))?;
    let src_path = get_boringssl_source_path(config);
    let has_git = src_path.join(".git").exists();

    lock_file.lock()?;

    // NOTE: init git in the copied files, so we can apply patches
    if !has_git {
        run_command(Command::new("git").arg("init").current_dir(src_path))?;
    }

    println!("cargo:warning=applying post quantum crypto patch to boringssl");
    apply_patch(config, "boring-pq.patch")?;

    println!("cargo:warning=applying patch to boringssl");
    apply_patch(config, "boringssl.patch")?;

    println!("cargo:warning=applying loongarch patch to boringssl");
    apply_patch(config, "boringssl-loongarch.patch")?;

    println!("cargo:warning=applying windows cross compile patch to boringssl");
    apply_patch(config, "boringssl-windows.patch")?;

    println!("cargo:warning=applying measured ClientHello patch to boringssl");
    apply_patch(config, "agy-clienthello.patch")?;

    println!("cargo:warning=applying ML-DSA TLS and X.509 support");
    apply_patch(config, "agy-mldsa-tls.patch")?;

    println!("cargo:warning=applying hybrid ML-KEM group negotiation");
    apply_patch(config, "agy-hybrid-negotiation.patch")?;

    if config.features.underscore_wildcards {
        println!("cargo:warning=applying underscore wildcards patch to boringssl");
        apply_patch(config, "underscore-wildcards.patch")?;
    }

    Ok(())
}

fn apply_patch(config: &Config, patch_name: &str) -> io::Result<()> {
    let src_path = get_boringssl_source_path(config);
    #[cfg(not(windows))]
    let cmd_path = config
        .manifest_dir
        .join("patches")
        .join(patch_name)
        .canonicalize()?;

    #[cfg(windows)]
    let cmd_path = config.manifest_dir.join("patches").join(patch_name);

    let mut args = vec!["apply", "-v", "--whitespace=fix"];

    // non-bazel versions of BoringSSL have no src/ dir
    if config.is_bazel {
        args.push("-p2");
    }

    run_command(
        Command::new("git")
            .args(&args)
            .arg(cmd_path)
            .current_dir(src_path),
    )?;

    Ok(())
}

fn run_command(command: &mut Command) -> io::Result<Output> {
    let out = command.output().map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "can't run {}: {e}\n{command:?} failed",
                command.get_program().to_string_lossy(),
            ),
        )
    })?;

    std::io::stderr().write_all(&out.stderr)?;
    std::io::stdout().write_all(&out.stdout)?;

    if !out.status.success() {
        let err = match out.status.code() {
            Some(code) => format!("{command:?} exited with status: {code}"),
            None => format!("{command:?} was terminated by signal"),
        };

        return Err(io::Error::other(err));
    }

    Ok(out)
}

fn build_boringssl_or_get_prebuilt(config: &Config) -> &Path {
    static BUILD_SOURCE_PATH: OnceLock<PathBuf> = OnceLock::new();

    BUILD_SOURCE_PATH.get_or_init(|| {
        if let Some(path) = &config.env.path {
            if !path.exists() {
                println!("cargo:warning=built path doesn't exist: {}", path.display());
            }
            return path.into();
        }

        let mut cfg = get_boringssl_cmake_config(config);

        let num_jobs = std::env::var("NUM_JOBS").ok().or_else(|| {
            std::thread::available_parallelism()
                .ok()
                .map(|t| t.to_string())
        });
        if let Some(num_jobs) = num_jobs {
            cfg.env("CMAKE_BUILD_PARALLEL_LEVEL", num_jobs);
        }

        if config.features.fips {
            cfg.define("CMAKE_C_COMPILER", "clang")
                .define("CMAKE_CXX_COMPILER", "clang++")
                .define("CMAKE_ASM_COMPILER", "clang")
                .define("FIPS", "1");
        }

        if config.features.prefix_symbols {
            cfg.define("CMAKE_POSITION_INDEPENDENT_CODE", "ON");
        }

        cfg.build_target("ssl").build();
        let path = cfg.build_target("crypto").build();
        let build_dir = path.join("build");
        if build_dir.exists() {
            build_dir
        } else {
            path
        }
    })
}

fn get_cpp_runtime_lib(config: &Config) -> Option<String> {
    if let Some(ref cpp_lib) = config.env.cpp_runtime_lib {
        return cpp_lib.clone().into_string().ok();
    }

    match &*config.target_os {
        "macos" | "ios" | "freebsd" | "openbsd" | "android" => Some("c++".into()),
        // The standalone Windows helper cannot depend on a mingw runtime DLL
        // placed beside an otherwise self-contained executable.
        "windows" if config.target_env == "gnu" => Some("static=stdc++".into()),
        _ if config.unix || config.target_env == "gnu" => Some("stdc++".into()),
        // TODO(rmehra): figure out how to do this for windows
        _ => None,
    }
}

/// Copies built BoringSSL artifacts (libraries and patched headers) into a
/// user-specified directory. This is intended for producing a pre-built package.
///
/// The destination directory must exist and be empty. Writes:
///
///   - `lib/libcrypto.a`
///   - `lib/libssl.a`
///   - `lib/bcm.o` (if FIPS is enabled)
///   - `include/openssl/...` (patched headers)
fn install_artifacts(
    config: &Config,
    install_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let install_dir = match install_dir.canonicalize() {
        Ok(dir) if dir.read_dir().is_ok_and(|mut d| d.next().is_none()) => dir,
        dir => {
            let path = dir.as_deref().unwrap_or(install_dir).display();
            return Err(format!("{path} must be an empty dir").into());
        }
    };
    let bssl_build_dir = build_boringssl_or_get_prebuilt(config);

    let lib_dir = install_dir.join("lib");
    fs::create_dir(&lib_dir)?;

    for lib in ["libcrypto.a", "libssl.a", "bcm.o"] {
        if !config.features.fips && lib == "bcm.o" {
            continue;
        }
        fs::copy(bssl_build_dir.join(lib), lib_dir.join(lib))?;
    }

    fs_extra::dir::copy(get_include_path(config)?, &install_dir, &Default::default())?;

    eprintln!(
        "installed BoringSSL artifacts into {}",
        install_dir.display()
    );
    Ok(())
}

fn main() -> ExitCode {
    if let Err(e) = run() {
        eprintln!("boring-sys failed: {e}");
        println!(
            "cargo::error={}",
            e.to_string().trim_ascii().replace('\n', "\ncargo::error=")
        );
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    ensure_patches_applied(&config)?;
    if !config.env.docs_rs {
        emit_link_directives(&config);
    }

    if config.features.prefix_symbols {
        match config.target_os.as_str() {
            "macos" | "ios" | "windows" => {
                println!(
                    "cargo:warning=The `prefix_symbols` feature is not supported on macOS/iOS or Windows targets. Skipping symbol prefixing."
                );
            }
            _ => {
                // Symbol prefixing requires the 'nm' tool which is not available in the docs.rs
                // build environment. When building documentation, symbol prefixing is skipped.
                // For regular builds, this operation is costly and only performed when necessary.
                if !config.env.docs_rs {
                    prefix_symbols(&config)
                }
            }
        }
    }
    generate_bindings(&config).map_err(|e| format!("could not generate bindings: {e}"))?;
    if let Some(install_dir) = &config.env.export_to_install_dir {
        install_artifacts(&config, install_dir)
            .map_err(|e| format!("install artifacts failed: {e}"))?;
    }
    Ok(())
}

fn emit_link_directives(config: &Config) {
    let bssl_dir = build_boringssl_or_get_prebuilt(config);
    let msvc_lib_subdir = msvc_lib_subdir(config);

    let subdirs =
        if config.is_bazel || (config.features.is_fips_like() && config.env.path.is_some()) {
            &["lib"][..]
        } else {
            &["lib", "crypto", "ssl", ""][..]
        };

    for subdir in subdirs {
        let dir = bssl_dir.join(subdir);
        let dir = msvc_lib_subdir
            .map(|s| dir.join(s))
            .filter(|d| d.exists())
            .unwrap_or(dir);
        println!("cargo:rustc-link-search=native={}", dir.display());
    }

    // Rust's windows-gnu linker does not search the cross-compiler's private
    // GCC directory for libstdc++.a. Resolve it from the same C++ compiler
    // CMake used, so the standalone helper has no mingw DLL sidecar.
    if get_cpp_runtime_lib(config).as_deref() == Some("static=stdc++") {
        let fallback = if config.host == config.target {
            "g++"
        } else {
            "x86_64-w64-mingw32-g++"
        };
        let output = Command::new(config.env.cxx.as_deref().unwrap_or_else(|| std::ffi::OsStr::new(fallback)))
            .arg("-print-file-name=libstdc++.a")
            .output()
            .expect("Windows GNU C++ compiler is required to link the static runtime");
        let archive = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        assert!(
            output.status.success() && archive.is_file(),
            "Windows GNU C++ compiler did not provide a static libstdc++.a: {}",
            archive.display()
        );
        println!("cargo:rustc-link-search=native={}", archive.parent().expect("static library has a directory").display());
    }
    if let Some(cpp_lib) = get_cpp_runtime_lib(config) {
        println!("cargo:rustc-link-lib={cpp_lib}");
    }
    println!("cargo:rustc-link-lib=static=crypto");
    println!("cargo:rustc-link-lib=static=ssl");

    if config.target_os == "windows" {
        // Rust 1.87.0 compat - https://github.com/rust-lang/rust/pull/138233
        println!("cargo:rustc-link-lib=advapi32");
    }
}

fn check_include_path(path: PathBuf) -> Result<PathBuf, String> {
    if path.join("openssl").join("x509v3.h").exists() {
        Ok(path)
    } else {
        Err(format!(
            "Include path {} {}",
            path.display(),
            if !path.exists() {
                "does not exist"
            } else {
                "does not have expected openssl/x509v3.h"
            }
        ))
    }
}

fn get_include_path(config: &Config) -> Result<PathBuf, String> {
    if let Some(path) = &config.env.include_path {
        return check_include_path(path.to_owned());
    }

    if let Some(bssl_path) = &config.env.path {
        return check_include_path(bssl_path.join("include"));
    }

    let src_path = get_boringssl_source_path(config);
    check_include_path(src_path.join("include"))
        .or_else(|_| check_include_path(src_path.join("src").join("include")))
}

fn generate_bindings(config: &Config) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let include_path = get_include_path(config)?;

    let target_rust_version = bindgen::RustTarget::stable(77, 0)
        .map_err(|e| format!("bindgen does not recognize target rust version: {e}"))?;

    let mut builder = bindgen::Builder::default()
        .rust_target(target_rust_version) // bindgen MSRV is 1.70, so this is enough
        .derive_copy(true)
        .derive_debug(true)
        .derive_default(true)
        .derive_eq(false)
        .derive_partialeq(false)
        .default_enum_style(bindgen::EnumVariation::NewType {
            is_bitfield: false,
            is_global: false,
        })
        .default_macro_constant_type(bindgen::MacroTypeVariation::Signed)
        .generate_comments(true)
        .fit_macro_constants(false)
        .size_t_is_usize(true)
        .layout_tests(config.env.debug.is_some())
        .merge_extern_blocks(true)
        .prepend_enum_name(true)
        .blocklist_type("max_align_t") // Not supported by bindgen on all targets, not used by BoringSSL
        .clang_args(get_extra_clang_args_for_bindgen(config))
        .clang_arg("-I")
        .clang_arg(include_path.display().to_string());

    if let Some(sysroot) = &config.env.sysroot {
        builder = builder
            .clang_arg("--sysroot")
            .clang_arg(sysroot.display().to_string());

        // we need to add special platform header file with env for support cross building
        let target_include_dir = sysroot.join(format!(
            "usr/include/{}-{}-{}",
            config.target_arch, config.target_os, config.target_env
        ));
        if target_include_dir.is_dir() {
            builder = builder
                .clang_arg("-I")
                .clang_arg(target_include_dir.display().to_string());
        }
    }

    if config.features.prefix_symbols {
        builder = builder.parse_callbacks(Box::new(PrefixCallback));
    }

    let must_have_headers = [
        "aes.h",
        "asn1_mac.h",
        "asn1t.h",
        "blake2.h",
        "blowfish.h",
        "cast.h",
        "chacha.h",
        "cmac.h",
        "cpu.h",
        "curve25519.h",
        "des.h",
        "dtls1.h",
        "err.h",
        "hkdf.h",
        "hpke.h",
        "ossl_typ.h",
        "pkcs12.h",
        "poly1305.h",
        "x509v3.h",
    ];
    let headers = [
        "hmac.h",
        "hrss.h",
        "md4.h",
        "md5.h",
        "mlkem.h",
        "obj_mac.h",
        "objects.h",
        "opensslv.h",
        "rand.h",
        "rc4.h",
        "ripemd.h",
        "siphash.h",
        "srtp.h",
        "trust_token.h",
    ];
    for (i, header) in must_have_headers.into_iter().chain(headers).enumerate() {
        let header_path = include_path.join("openssl").join(header);
        if header_path.exists() {
            builder = builder.header(header_path.to_str().unwrap());
        } else {
            let err = format!("'openssl/{header}' is missing from '{}'. The include path may be incorrect or contain an outdated version of OpenSSL/BoringSSL", include_path.display());
            if i < must_have_headers.len() {
                return Err(err.into());
            }
            println!("cargo::warning={err}");
        }
    }

    let bindings = builder.generate()?;
    let mut source_code = Vec::new();
    bindings
        .write(Box::new(&mut source_code))
        .map_err(|e| format!("Couldn't serialize bindings: {e}"))?;
    ensure_err_lib_enum_is_named(&mut source_code);
    let bindings_path = config.out_dir.join("bindings.rs");
    fs::write(&bindings_path, source_code).map_err(|e| {
        format!(
            "Couldn't write bindings to {}: {e}",
            bindings_path.display()
        )
    })?;
    Ok(bindings_path)
}

/// err.h has anonymous `enum { ERR_LIB_NONE = 1 }`, which makes a dodgy `_bindgen_ty_1` name
fn ensure_err_lib_enum_is_named(source_code: &mut Vec<u8>) {
    let src = String::from_utf8_lossy(source_code);
    let enum_type = src
        .split_once("ERR_LIB_SSL:")
        .and_then(|(_, def)| Some(def.split_once('=')?.0))
        .unwrap_or("_bindgen_ty_1");

    source_code.extend_from_slice(
        format!("\n/// Newtype for [`ERR_LIB_SSL`] constants\npub use {enum_type} as ErrLib;\n")
            .as_bytes(),
    );
}
