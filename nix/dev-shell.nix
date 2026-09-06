{
  pkgs,
  rustToolchain,
}:
let
  inherit (pkgs) lib;
  linuxLibraries = with pkgs; [
    libpulseaudio
    pipewire
    stdenv.cc.cc.lib
    zlib
  ];
in
pkgs.mkShell (
  {
    name = "omp-dev";

    packages =
      (with pkgs; [
        bun
        bun2nix
        rustToolchain
        cargo-nextest
        rustPlatform.bindgenHook
        nixfmt
        typescript-language-server

        python312
        python312Packages.pip
        uv
        basedpyright

        bash
        cacert
        curl
        fd
        git
        git-lfs
        imagemagick
        openssh
        ripgrep
        sqlite
        unzip

        cmake
        ninja
        pkg-config
        zig

        cairo
        giflib
        libjpeg
        libopus
        librsvg
        openssl
        pango
        pcre2
        zlib
      ])
      ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux linuxLibraries;

    CMAKE_POLICY_VERSION_MINIMUM = "3.5";
    PCRE2_SYS_STATIC = "1";
    RUST_SRC_PATH = "${rustToolchain}/lib/rustlib/src/rust/library";
  }
  // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
    LD_LIBRARY_PATH = lib.makeLibraryPath linuxLibraries;
  }
)
