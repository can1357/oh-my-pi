{
  autoPatchelfHook,
  alsa-lib,
  bun,
  bun2nix,
  cmake,
  darwin,
  lib,
  libopus,
  libpulseaudio,
  makeBinaryWrapper,
  ninja,
  pipewire,
  pkg-config,
  removeReferencesTo,
  rustPlatform,
  rustToolchain,
  source,
  stdenv,
  stdenvNoCC,
  unzip,
  # Wayland screencast support links libpipewire, whose runtime closure adds
  # ~750 MB (gstreamer, ffmpeg, systemd, ...). Official npm/Bazel addons ship
  # without it, so default to the lean build; opt in via `.override`.
  withWaylandScreencast ? false,
}:
let
  packageJson = lib.importJSON ../packages/coding-agent/package.json;
  rootPackageJson = lib.importJSON ../package.json;
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
  patchedDependencies = lib.mapAttrs (
    _: patch: source + "/${patch}"
  ) rootPackageJson.patchedDependencies;
  patchOverrides = bun2nix.patchedDependenciesToOverrides { inherit patchedDependencies; };
  runtimeNativeLibraries = lib.optionals stdenv.hostPlatform.isLinux (
    [ stdenv.cc.cc.lib ] ++ lib.optional (stdenv.cc.cc ? libgcc) stdenv.cc.cc.libgcc
  );
  bunRuntimeTemplate = stdenvNoCC.mkDerivation {
    pname = "omp-bun-runtime-template";
    inherit (bun) version;
    src = bun.src;

    nativeBuildInputs = [ unzip ];
    dontUnpack = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall
      unzip -q "$src"
      install -Dm755 bun-*/bun "$out/libexec/bun"
      runHook postInstall
    '';
  };
in
stdenv.mkDerivation {
  pname = "omp";
  inherit (packageJson) version;
  src = source;

  cargoDeps = rustPlatform.importCargoLock { lockFile = ../Cargo.lock; };
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
    overrides = patchOverrides;
  };

  nativeBuildInputs = [
    bun
    bun2nix.hook
    cmake
    ninja
    pkg-config
    removeReferencesTo
    rustPlatform.bindgenHook
    rustPlatform.cargoSetupHook
    rustToolchain
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
    makeBinaryWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ darwin.autoSignDarwinBinariesHook ];

  # pcre2 is vendored via PCRE2_SYS_STATIC, but opus must link the nixpkgs
  # library: audiopus_sys' bundled cmake build installs to lib64 while its
  # link-search hardcodes lib, so the pkg-config path is the one that works.
  # libgcc_s is resolved from the compiler's lib output during autoPatchelf.
  # All dynamic store paths are pinned into the closure via nix-support (see
  # installPhase).
  buildInputs = [
    libopus
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ]
  ++ lib.optionals withWaylandScreencast [ pipewire ];

  strictDeps = true;
  # Nix builders cannot reliably hardlink cache files into node_modules
  # (and Darwin's clonefile backend also rejects store permissions).
  bunInstallFlags = [
    "--linker=isolated"
    "--backend=copyfile"
  ];
  dontConfigure = true;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  dontStrip = true;

  env = {
    CMAKE_POLICY_VERSION_MINIMUM = "3.5";
    PCRE2_SYS_STATIC = "1";
    SOURCE_DATE_EPOCH = "1";
  }
  // lib.optionalAttrs (platform ? rustFlags) { RUSTFLAGS = platform.rustFlags; }
  // lib.optionalAttrs stdenv.hostPlatform.isDarwin { BUN_NO_CODESIGN_MACHO_BINARY = "1"; };

  buildPhase = ''
    runHook preBuild

    echo "Building pi-natives"
    cargo build --release -p pi-natives ${lib.optionalString withWaylandScreencast "--features wayland-pipewire"}
    install -Dm755 "target/release/${platform.nativeLibrary}" \
      "packages/natives/native/${platform.addon}"
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # The loader extracts this archived addon at runtime, so fix its
      # interpreter-independent Nix RPATH before Bun embeds it.
      autoPatchelf -- "packages/natives/native/${platform.addon}"
      # pi-voice dlopens libpulse-simple.so.0 / libpulse.so.0 / libasound.so.2
      # by bare name; glibc resolves those through the calling object's
      # RUNPATH, so append the client libraries here. Nothing links them, so
      # autoPatchelf cannot discover them on its own.
      patchelf --add-rpath "${
        lib.makeLibraryPath [
          libpulseaudio
          alsa-lib
        ]
      }" \
        "packages/natives/native/${platform.addon}"
    ''}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      # arm64 Darwin requires even locally-built Mach-O addons to carry an
      # ad-hoc signature. Sign before Bun archives the file.
      signIfRequired "packages/natives/native/${platform.addon}"
    ''}

    echo "Compiling OMP"
    BUN_COMPILE_EXECUTABLE_PATH="${bunRuntimeTemplate}/libexec/bun" \
      bun --cwd="$PWD/packages/coding-agent" run build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 packages/coding-agent/dist/omp "$out/bin/omp"
    install -Dm644 LICENSE "$out/share/doc/omp/LICENSE"
    install -Dm644 THIRD-PARTY-NOTICES.txt "$out/share/doc/omp/THIRD-PARTY-NOTICES.txt"

    # The addon is gzip-compressed inside the compiled binary, so the store
    # paths it links against are invisible to the output reference scanner.
    # Record them in plain text to pin the libraries into the runtime closure.
    mkdir -p "$out/nix-support"
    ${
      if stdenv.hostPlatform.isLinux then
        ''
          patchelf --print-rpath "packages/natives/native/${platform.addon}" \
            > "$out/nix-support/embedded-addon-runpath"
        ''
      else
        ''
          echo "${lib.getLib libopus}/lib" > "$out/nix-support/embedded-addon-runpath"
        ''
    }

    runHook postInstall
  '';

  # Bun serializes the build interpreter path into the bundled entrypoint's
  # inert shebang. Remove its hash before Nix scans output references; this
  # runs before Darwin's binary-signing fixup hook.
  preFixup = ''
    remove-references-to -t ${bun} "$out/bin/omp"
  '';

  # Prebuilt addons that omp bun-installs into its cache at first use
  # (onnxruntime-node, sherpa-onnx-node, sharp, fastembed) are process.dlopen'd and
  # need libstdc++.so.6 / libgcc_s.so.1, which nix glibc's default loader path lacks;
  # their own DT_RUNPATH means this executable's RPATH is never consulted for their
  # dependencies, so only LD_LIBRARY_PATH resolves them. The agent injects this value
  # into the inference worker subprocesses' LD_LIBRARY_PATH alone (see
  # packages/coding-agent/src/subprocess/worker-client.ts) instead of exporting
  # LD_LIBRARY_PATH process-wide, where it would also reorder the loader search path
  # of every user command the bash tool, daemon PTY sessions and eval kernels spawn.
  # Additionally, force libstdc++ to load at process start via DT_NEEDED: addons the
  # main process itself dlopen's then resolve libstdc++.so.6 / libgcc_s.so.1 by
  # soname from the already-loaded set, regardless of the addon's own DT_RUNPATH.
  # stdenv.cc.cc.lib is already in buildInputs, so the autoPatchelfHook pass that
  # follows resolves the new dependency and sets the RPATH. patchelf must run before
  # wrapProgram: the wrapper replaces $out/bin/omp with a script and moves the ELF
  # to $out/bin/.omp-wrapped.
  postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
    patchelf --add-needed libstdc++.so.6 "$out/bin/omp"
    wrapProgram "$out/bin/omp" \
      --set-default OMP_NATIVE_LIBRARY_PATH "${lib.makeLibraryPath runtimeNativeLibraries}"
  '';

  disallowedReferences = [ bun ];

  # patchelf leaves DT_VERDEF pointing at the pre-relocation `.gnu.version_d`
  # address whenever it grows `.dynamic`: both the `--add-needed libstdc++.so.6`
  # above and the autoPatchelfHook RPATH pass that follows it do. bun --compile
  # output defines its own symbol versions (DT_VERDEFNUM), so glibc follows that
  # stale pointer in `_dl_check_map_versions` and the binary SIGSEGVs in the
  # loader before `main()` runs (issue #9881). Repoint DT_VERDEF at the current
  # section address. preInstallCheck runs after every fixupPhase hook, including
  # the autoPatchelfHook pass that follows postFixup, so it is the last point at
  # which the field can be corrected; wrapProgram moved the real ELF to
  # `.omp-wrapped`.
  preInstallCheck = lib.optionalString stdenv.hostPlatform.isLinux ''
    bun ${../scripts/fix-dt-verdef.ts} "$out/bin/.omp-wrapped"
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    # Capture rather than pipe into grep: piping masks a signal death of omp
    # under `set -o pipefail` (grep -q's exit status wins), which hid the
    # loader SIGSEGV in issue #9881. With a variable, errexit surfaces omp's
    # real exit status and stderr in the build log.
    smokeOutput="$(HOME="$TMPDIR" "$out/bin/omp" --smoke-test)"
    grep -q "smoke-test: ok" <<<"$smokeOutput"
    BUN_BE_BUN=1 "$out/bin/omp" -e \
      'if (Bun.version !== "${bun.version}" || typeof Bun.Image !== "function") process.exit(1)'
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # The addons are dlopen'd, so prove the advertised directories actually
      # resolve the libraries rather than merely carrying a plausible string.
      env -u LD_LIBRARY_PATH BUN_BE_BUN=1 "$out/bin/omp" -e \
        'const {dlopen}=require("bun:ffi");const dirs=(process.env.OMP_NATIVE_LIBRARY_PATH||"").split(":").filter(Boolean);const need={"libstdc++.so.6":{__cxa_demangle:{args:["ptr","ptr","ptr","ptr"],returns:"ptr"}},"libgcc_s.so.1":{_Unwind_Backtrace:{args:["ptr","ptr"],returns:"i32"}}};for(const lib of Object.keys(need)){let ok=false;for(const d of dirs){try{dlopen(d+"/"+lib,need[lib]);ok=true;break}catch(e){}}if(!ok){console.error("unresolved: "+lib);process.exit(1)}}'
      # The libstdc++ preload (see postFixup) must survive: without it addons the
      # main process dlopen's directly fail to resolve libstdc++.so.6 on NixOS.
      # wrapProgram moved the real ELF to .omp-wrapped.
      patchelf --print-needed "$out/bin/.omp-wrapped" | grep -q '^libstdc++\.so\.6$'
    ''}
    runHook postInstallCheck
  '';

  meta = {
    description = "Terminal-based coding agent with multi-model support";
    homepage = "https://omp.sh";
    changelog = "https://github.com/can1357/oh-my-pi/releases/tag/v${packageJson.version}";
    license = lib.licenses.mit;
    mainProgram = "omp";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [
      binaryNativeCode
      fromSource
    ];
  };
}
