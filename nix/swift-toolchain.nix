# Keep the vendor layout so Swift's compiler-relative libraries resolve.
{
  lib,
  stdenvNoCC,
  stdenv,
  makeWrapper,
  fetchurl,
  xar,
  gzip,
  cpio,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "omp-swift-toolchain";
  version = "6.4.0";

  src = fetchurl {
    url = "https://download.swift.org/swift-${finalAttrs.version}-release/xcode/swift-${finalAttrs.version}-RELEASE/swift-${finalAttrs.version}-RELEASE-osx.pkg";
    hash = "sha256-j9AxhbmP4n9UpUYxwkSd7PddW0Zs6ONKu9QUFBBjxqo=";
  };

  nativeBuildInputs = [
    xar
    gzip
    cpio
    makeWrapper
  ];
  unpackPhase = ''
    runHook preUnpack
    xar -xf "$src"
    gzip -dc "swift-${finalAttrs.version}-RELEASE-osx-package.pkg/Payload" | cpio -idm
    runHook postUnpack
  '';
  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin"
    mv usr "$out/toolchain"
    # The driver otherwise searches for a system linker outside the sandbox.
    makeWrapper "$out/toolchain/bin/swiftc" "$out/bin/swiftc" \
      --add-flags "-ld-path=${stdenv.cc.bintools}/bin/ld"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/swiftc" -version
    runHook postInstallCheck
  '';

  meta = {
    description = "Build-only Swift compiler for OMP's Apple Foundation Models bridge";
    homepage = "https://www.swift.org/install/macos/";
    license = lib.licenses.asl20;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = lib.platforms.darwin;
  };
})
