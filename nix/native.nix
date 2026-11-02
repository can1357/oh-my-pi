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
  writeText,
  withWaylandScreencast ? false,
  withFatLto ? true,
}:
let
  rootCargoToml = builtins.readFile (source + "/Cargo.toml");
  lockText = builtins.readFile (source + "/Cargo.lock");
  workspaceVersion = (builtins.fromTOML rootCargoToml).workspace.package.version;
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
    version = workspaceVersion;
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

    cargoVendorDir = craneLib.vendorCargoDeps { cargoLockContents = lockText; };
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
    // lib.optionalAttrs (platform ? rustFlags) { RUSTFLAGS = platform.rustFlags; }
    # Override the release profile in place so the install path and the
    # dependency artifacts stay the same. These values match `profile.ci`.
    // lib.optionalAttrs (!withFatLto) {
      CARGO_PROFILE_RELEASE_LTO = "thin";
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "16";
    };
  };
  # The dependency build sees the workspace version as 0.0.0, so a release
  # bump does not invalidate it. Only the root Cargo.toml and the workspace
  # entries in Cargo.lock carry that version. Every member inherits it.
  placeholderVersion = "0.0.0";
  workspaceCrates = map (crate: crate.name) (
    builtins.filter (
      crate: !(crate ? source) && crate.version == workspaceVersion
    ) (builtins.fromTOML lockText).package
  );
  # Vendored crates are built from real source in the dependency stage, since
  # registry crates depend on their real APIs (e.g. nix -> cfg_aliases). A
  # vendored crate that depends on an OMP crate, directly or through another
  # vendored crate, would compile against a dummy there, so it stays a dummy
  # and builds with the OMP crates instead (brush-core -> pi-vfs today).
  vendoredCrates =
    let
      vendorDir = source + "/crates/vendor";
      dependencyNames =
        manifest:
        let
          tables = [
            (manifest.dependencies or { })
            (manifest.build-dependencies or { })
          ]
          ++ lib.concatMap (target: [
            (target.dependencies or { })
            (target.build-dependencies or { })
          ]) (builtins.attrValues (manifest.target or { }));
        in
        lib.concatMap (lib.mapAttrsToList (
          name: spec: if builtins.isAttrs spec && spec ? package then spec.package else name
        )) tables;
      crates = lib.mapAttrsToList (
        dir: _type:
        let
          manifest = builtins.fromTOML (builtins.readFile "${vendorDir}/${dir}/Cargo.toml");
        in
        {
          inherit dir;
          inherit (manifest.package) name;
          dependencies = dependencyNames manifest;
        }
      ) (lib.filterAttrs (_: type: type == "directory") (builtins.readDir vendorDir));
      # Grow the dummy set until no vendored crate depends on a dummy.
      dummies =
        names:
        let
          next =
            names
            ++ map (crate: crate.name) (
              builtins.filter (
                crate:
                !builtins.elem crate.name names
                && builtins.any (dependency: builtins.elem dependency names) crate.dependencies
              ) crates
            );
        in
        if builtins.length next == builtins.length names then names else dummies next;
      dummyCrates = dummies workspaceCrates;
    in
    map (crate: {
      inherit (crate) dir;
      path = builtins.path {
        path = "${vendorDir}/${crate.dir}";
        name = "omp-vendored-${crate.dir}";
      };
    }) (builtins.filter (crate: !builtins.elem crate.name dummyCrates) crates);
  versionEntry = version: name: "name = \"${name}\"\nversion = \"${version}\"";
  dependencyCargoLock = writeText "Cargo.lock" (
    builtins.replaceStrings (map (versionEntry workspaceVersion) workspaceCrates)
      (map (versionEntry placeholderVersion) workspaceCrates)
      lockText
  );
  # Crane writes a workspace root as its cleaned Cargo.toml, so only the
  # version differs from what mkDummySrc would produce.
  dependencyCargoToml = craneLib.writeTOML "Cargo.toml" (
    lib.recursiveUpdate (craneLib.cleanCargoToml { cargoTomlContents = rootCargoToml; }) {
      workspace.package.version = placeholderVersion;
    }
  );
  dependencySource = craneLib.mkDummySrc {
    # Keep the real source name: rustc path remapping must match the final
    # build, or cargo rebuilds every dependency.
    src = lib.cleanSourceWith {
      inherit (commonArgs) src;
      name = "omp-rust-source";
      filter =
        path: _type:
        !builtins.elem (lib.removePrefix "${toString source}/" (toString path)) [
          "Cargo.toml"
          "Cargo.lock"
        ];
    };
    # Patched dependencies must expose their real APIs to registry crates.
    extraDummyScript = ''
      cp ${dependencyCargoToml} "$out/Cargo.toml"
      cp ${dependencyCargoLock} "$out/Cargo.lock"
      ${lib.concatMapStrings (crate: ''
        rm -rf "$out/crates/vendor/${crate.dir}"
        cp -R ${crate.path} "$out/crates/vendor/${crate.dir}"
      '') vendoredCrates}
    '';
  };
  dependencyArtifacts = craneLib.buildDepsOnly (
    removeAttrs commonArgs [ "src" ]
    // {
      version = placeholderVersion;
      dummySrc = dependencySource;
      # Cache release builds only, not unused check or test artifacts.
      buildPhaseCargoCommand = "cargoWithProfile build ${commonArgs.cargoExtraArgs}";
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
