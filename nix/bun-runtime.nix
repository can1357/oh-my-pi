{
  bun,
  stdenvNoCC,
  unzip,
}:
stdenvNoCC.mkDerivation {
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
}
