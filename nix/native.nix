{
  cmake,
  craneLib,
  lib,
  ninja,
  pipewire,
  pkg-config,
  rustPlatform,
  source,
  stdenv,
  withWaylandScreencast ? false,
}:
let
  platform =
    {
      aarch64-darwin = {
        addon = "pi_natives.darwin-arm64.node";
        nativeLibrary = "libpi_natives.dylib";
      };
      aarch64-linux = {
        addon = "pi_natives.linux-arm64.node";
        nativeLibrary = "libpi_natives.so";
      };
      x86_64-darwin = {
        addon = "pi_natives.darwin-x64-baseline.node";
        nativeLibrary = "libpi_natives.dylib";
        rustFlags = "-C target-cpu=x86-64-v2";
      };
      x86_64-linux = {
        addon = "pi_natives.linux-x64-baseline.node";
        nativeLibrary = "libpi_natives.so";
        rustFlags = "-C target-cpu=x86-64-v2";
      };
    }
    .${stdenv.hostPlatform.system} or (throw "Unsupported OMP platform: ${stdenv.hostPlatform.system}");
  commonArgs = {
    pname = "omp-native";
    version = (builtins.fromTOML (builtins.readFile ../Cargo.toml)).workspace.package.version;
    # Keep Rust inputs independent of Bun sources and packaging scripts.
    src = lib.cleanSourceWith {
      src = source;
      name = "omp-rust-source";
      filter =
        path: _type:
        let
          relative = lib.removePrefix "${toString source}/" (toString path);
        in
        builtins.elem relative [
          "Cargo.toml"
          "Cargo.lock"
          "rust-toolchain.toml"
          ".cargo"
          "crates"
        ]
        || lib.hasPrefix ".cargo/" relative
        || lib.hasPrefix "crates/" relative;
    };

    cargoVendorDir = craneLib.vendorCargoDeps { cargoLock = ../Cargo.lock; };
    cargoExtraArgs = "--locked -p pi-natives ${lib.optionalString withWaylandScreencast "--features wayland-pipewire"}";
    nativeBuildInputs = [
      cmake
      ninja
      pkg-config
      rustPlatform.bindgenHook
    ];
    buildInputs = lib.optionals withWaylandScreencast [ pipewire ];
    strictDeps = true;
    doCheck = false;
    # Stamping, patching, and signing belong to the downstream package.
    dontFixup = true;

    env = {
      CMAKE_POLICY_VERSION_MINIMUM = "3.5";
      PCRE2_SYS_STATIC = "1";
      SOURCE_DATE_EPOCH = "1";
    }
    // lib.optionalAttrs (platform ? rustFlags) { RUSTFLAGS = platform.rustFlags; };
  };
  vendoredCrates = builtins.path {
    path = source + "/crates/vendor";
    name = "omp-vendored-crates";
    # brush-core depends on OMP's pi-vfs, so build it with the real OMP crates.
    filter = path: _type: path != "${source}/crates/vendor/brush-core";
  };
  dependencyArtifacts = craneLib.buildDepsOnly (
    commonArgs
    // {
      # Cache release builds only, not unused check or test artifacts.
      buildPhaseCargoCommand = "cargoWithProfile build ${commonArgs.cargoExtraArgs}";
      # Patched dependencies must expose their real APIs to registry crates.
      extraDummyScript = ''
        for crate in ${vendoredCrates}/*; do
          name="$(basename "$crate")"
          rm -rf "$out/crates/vendor/$name"
          cp -R "$crate" "$out/crates/vendor/$name"
        done
      '';
    }
  );
in
craneLib.buildPackage (
  commonArgs
  // {
    cargoArtifacts = dependencyArtifacts;
    passthru = {
      inherit platform dependencyArtifacts;
    };
    installPhaseCommand = ''
      install -Dm755 "target/release/${platform.nativeLibrary}" "$out/lib/${platform.nativeLibrary}"
    '';
  }
)
