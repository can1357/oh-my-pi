use crate::{config::Config, pick_best_android_ndk_toolchain, run_command};
use std::{fs, io::Write, path::PathBuf, process::Command};

// The prefix to add to all symbols
// Using crate name to avoid collisions with other projects
const PREFIX: &str = env!("CARGO_CRATE_NAME");

// Callback to add a `link_name` macro with the prefix to all generated bindings
#[derive(Debug)]
pub struct PrefixCallback;

impl bindgen::callbacks::ParseCallbacks for PrefixCallback {
    fn generated_link_name_override(
        &self,
        item_info: bindgen::callbacks::ItemInfo<'_>,
    ) -> Option<String> {
        Some(format!("{PREFIX}_{}", item_info.name))
    }
}

fn android_toolchain(config: &Config) -> PathBuf {
    let mut android_bin_path = config
        .env
        .android_ndk_home
        .clone()
        .expect("Please set ANDROID_NDK_HOME for Android build");
    android_bin_path.extend(["toolchains", "llvm", "prebuilt"]);
    android_bin_path.push(pick_best_android_ndk_toolchain(&android_bin_path).unwrap());
    android_bin_path.push("bin");
    android_bin_path
}

pub fn prefix_symbols(config: &Config) {
    // List static libraries to prefix symbols in
    let static_libs: Vec<PathBuf> = [
        config.out_dir.join("build"),
        config.out_dir.join("build").join("ssl"),
        config.out_dir.join("build").join("crypto"),
    ]
    .iter()
    .flat_map(|dir| {
        ["libssl.a", "libcrypto.a"]
            .into_iter()
            .map(move |file| PathBuf::from(dir).join(file))
    })
    .filter(|p| p.exists())
    .collect();

    // Use `nm` to list symbols in these static libraries
    let nm = match &*config.target_os {
        "android" => android_toolchain(config).join("llvm-nm"),
        _ => PathBuf::from("nm"),
    };
    let out = run_command(Command::new(nm).args(&static_libs)).unwrap();
    let mut redefine_syms: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| {
            [" T ", " D ", " B ", " C ", " R ", " W "]
                .iter()
                .any(|s| l.contains(s))
        })
        .filter_map(|l| l.split_whitespace().nth(2).map(|s| s.to_string()))
        .filter(|l| !l.starts_with("_"))
        .map(|l| format!("{l} {PREFIX}_{l}"))
        .collect();
    redefine_syms.sort();
    redefine_syms.dedup();

    let redefine_syms_path = config.out_dir.join("redefine_syms.txt");
    let mut f = fs::File::create(&redefine_syms_path).unwrap();
    for sym in &redefine_syms {
        writeln!(f, "{sym}").unwrap();
    }
    f.flush().unwrap();

    // Use `objcopy` to prefix symbols in these static libraries
    let objcopy = match &*config.target_os {
        "android" => android_toolchain(config).join("llvm-objcopy"),
        _ => PathBuf::from("objcopy"),
    };
    for static_lib in &static_libs {
        run_command(
            Command::new(&objcopy)
                .arg(format!("--redefine-syms={}", redefine_syms_path.display()))
                .arg(static_lib),
        )
        .unwrap();
    }
}
