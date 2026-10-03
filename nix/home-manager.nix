{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.omp;
  yaml = pkgs.formats.yaml { };
  configFile = yaml.generate "omp-config.yml" cfg.settings;
in
{
  options.programs.omp = {
    enable = lib.mkEnableOption "OMP coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.omp.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "OMP package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.nullOr yaml.type;
      default = null;
      description = ''
        Settings written declaratively to {file}`~/.omp/agent/config.yml`.
        On each `home-manager switch` the declared settings are copied into
        place as a writable regular file (not a read-only store symlink), so
        OMP can acquire its config lock and rewrite the file when persisting
        runtime changes (`/settings`, onboarding). Those runtime changes are
        overwritten by the declared values again on the next
        `home-manager switch`.
      '';
      example = {
        theme.dark = "titanium";
        startup.quiet = true;
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # OMP rewrites its config at runtime and acquires an advisory lock on it
    # first; on macOS the lock backend creates an flock sidecar next to the
    # target file. A `home.file` store symlink is read-only and lives under
    # /nix/store, so both the lock and the atomic rewrite fail with EACCES and
    # break every launch. Copy a writable regular file instead. The DAG entry
    # is written literally (rather than via `lib.hm.dag.entryAfter`) so the
    # home-manager-free module evaluation in `flake.nix` keeps working.
    home.activation.ompConfig = lib.mkIf (cfg.settings != null) {
      before = [ ];
      after = [ "writeBoundary" ];
      data = ''
        run mkdir -p "$HOME/.omp/agent"
        run install -m 600 ${configFile} "$HOME/.omp/agent/config.yml"
      '';
    };
  };
}
