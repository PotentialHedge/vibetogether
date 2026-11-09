{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    rust-overlay,
    treefmt-nix,
    ...
  }: let
    inherit (nixpkgs) lib;

    forEachSystem = f:
      lib.genAttrs ["aarch64-darwin" "x86_64-linux"]
      (system:
        f (import nixpkgs {
          inherit system;
          overlays = [(import rust-overlay)];
        }));

    # The one toolchain, which the shell and the packages share.
    rust = pkgs: pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

    # One environment, entered by the shell and by the checks alike. The
    # TypeScript compiler and the type definitions are pinned by pnpm instead,
    # since editors look for them in node_modules. Chromium is voice's bench's
    # browser, and only the server runs it.
    tools = pkgs:
      with pkgs;
        [(rust pkgs) bacon cargo-edit nodejs pnpm biome just curl jq openssl python3 rsync ffmpeg-headless uv]
        ++ lib.optional stdenv.hostPlatform.isLinux chromium;

    # A binary of the Cargo workspace. Cargo needs every member to build one,
    # so each takes the Rust sources of all of them.
    rustPackage = pkgs: {
      pname,
      binaries ? [pname],
      args ? {},
    }:
      (pkgs.makeRustPlatform {
        cargo = rust pkgs;
        rustc = rust pkgs;
      }).buildRustPackage ({
          inherit pname;
          version = "0.1.0";
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./Cargo.toml
              ./Cargo.lock
              (lib.fileset.fileFilter (file: file.hasExt "rs" || file.name == "Cargo.toml") ./agentwire)
              ./agentwire/relay/people.html
              (lib.fileset.fileFilter (file: file.hasExt "rs" || file.name == "Cargo.toml") ./mcp)
              (lib.fileset.fileFilter (file: file.hasExt "rs" || file.name == "Cargo.toml") ./messagent)
            ];
          };
          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = ["-p" pname];
          cargoTestFlags = ["-p" pname];
          # A binary names the toolchain's sources, in panic messages, which
          # would pull all of it into whatever runs it.
          nativeBuildInputs = [pkgs.removeReferencesTo];
          postFixup = lib.concatMapStrings (binary: "remove-references-to -t ${rust pkgs} $out/bin/${binary}\n") binaries;
          disallowedReferences = [(rust pkgs)];
          meta.mainProgram = pname;
        }
        // args);
  in {
    packages = forEachSystem (pkgs: {
      agentwire-relay = rustPackage pkgs {pname = "agentwire-relay";};

      # The spec and the script the relay serves, apart from its binary, so
      # that a new wording changes no binary and restarts no relay.
      agentwire-relay-files = pkgs.runCommandLocal "agentwire-relay-files" {} ''
        mkdir $out
        cp ${./agentwire/agentwire} $out/agentwire
        cp ${./agentwire/agentwire.md} $out/agentwire.md
      '';

      vibetogether-mcp = rustPackage pkgs {
        pname = "vibetogether-mcp";
        # The HTTP client loads the system's certificates even for the tests'
        # local relay, and the build sandbox has none.
        args.nativeCheckInputs = [pkgs.cacert];
      };

      # Both binaries: `messagent`, and `messagent-claude`, which wakes Claude
      # Code.
      messagent = rustPackage pkgs {
        pname = "messagent";
        binaries = ["messagent" "messagent-claude"];
        args = {
          cargoBuildFlags = ["-p" "messagent" "-p" "messagent-claude"];
          cargoTestFlags = ["-p" "messagent" "-p" "messagent-claude"];
        };
      };

      # The account service as it runs: its sources and its production
      # dependencies, which Node runs as they are, stripping the types itself.
      vibetogether-accounts = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
        pname = "vibetogether-accounts";
        version = "0.1.0";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./accounts/package.json
            ./accounts/src
          ];
        };
        pnpmWorkspaces = ["vibetogether-accounts"];
        nativeBuildInputs = [pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook pkgs.makeWrapper];
        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src pnpmWorkspaces;
          fetcherVersion = 4;
          hash = lib.fakeHash;
          # pnpm leaves an empty `links` in its store on Darwin only, which
          # fetchPnpmDeps keeps, so the hash would differ between platforms.
          preFixup = "rm -rf $storePath/v11/links";
        };
        pnpmInstallFlags = ["--prod"];
        installPhase = ''
          mkdir -p $out/lib/vibetogether-accounts
          cp -r accounts/package.json accounts/src accounts/node_modules $out/lib/vibetogether-accounts
          makeWrapper ${lib.getExe pkgs.nodejs} $out/bin/vibetogether-accounts \
            --add-flags $out/lib/vibetogether-accounts/src/main.ts
        '';
        meta.mainProgram = "vibetogether-accounts";
      });
    });

    nixosModules = {
      relay = import ./agentwire/nixos-module.nix self;
      mcp = import ./mcp/nixos-module.nix self;
      accounts = import ./accounts/nixos-module.nix self;
    };

    # Every language in the tree, behind one command. The global pre-commit
    # hook checks a repository by running this, so a language left out here is
    # a language nothing checks.
    formatter = forEachSystem (pkgs:
      treefmt-nix.lib.mkWrapper pkgs {
        projectRootFile = "flake.nix";
        programs.biome.enable = true;
        # One configuration for both, rather than treefmt's own default.
        # treefmt names the files itself, and Biome would look for the ignore
        # file next to the copy in the store. Biome checks the configuration as
        # it loads, and treefmt-nix's schema lags behind it.
        programs.biome.validate.enable = false;
        programs.biome.settings = removeAttrs (builtins.fromJSON (builtins.readFile ./biome.json)) ["vcs"];
        programs.alejandra.enable = true;
        programs.rustfmt.enable = true;
        programs.just.enable = true;
        programs.shellcheck.enable = true;
        programs.shfmt.enable = true;
        # direnv reads it, no shell runs it.
        settings.formatter.shellcheck.excludes = [".envrc"];
        # agentwire's script has no extension, since it is run as `sh agentwire`.
        settings.formatter.shellcheck.includes = ["*.sh" "agentwire/agentwire"];
        settings.formatter.shfmt.includes = ["*.sh" "agentwire/agentwire"];
      });

    devShells = forEachSystem (pkgs: {
      default = pkgs.mkShell {packages = tools pkgs;};
    });
  };
}
