{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";

    crane.url = "github:ipetkov/crane";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    rust-overlay,
    crane,
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

    toolchain = pkgs: pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

    # The command line that makes the website's bindings from the client's
    # WebAssembly. It must be the version of the wasm-bindgen crate in
    # Cargo.lock, which the client pins to it.
    wasmBindgen = pkgs: pkgs.wasm-bindgen-cli_0_2_129;

    # The Rust workspace: its sources, with the backend's migrations and the
    # tests' fixtures, which are no Cargo sources.
    rust = pkgs: let
      craneLib = (crane.mkLib pkgs).overrideToolchain toolchain;
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          (craneLib.fileset.commonCargoSources ./.)
          (lib.fileset.fileFilter (file: file.hasExt "sql") ./backend)
        ];
      };
      common = {
        inherit src;
        pname = "vibetogether";
        inherit ((lib.importTOML ./Cargo.toml).workspace.package) version;
        strictDeps = true;
        # The tests run in `just ci`, against a backend on loopback.
        doCheck = false;
      };
      native = common // {cargoArtifacts = craneLib.buildDepsOnly common;};
      wasm =
        common
        // {
          pname = "vibetogether-client-wasm";
          CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
          cargoExtraArgs = "--locked -p vibetogether-client";
        };
    in {
      backend = craneLib.buildPackage (native
        // {
          pname = "vibetogether-backend";
          cargoExtraArgs = "--locked -p vibetogether-backend";
          meta.mainProgram = "vibetogether-backend";
        });
      cli = craneLib.buildPackage (native
        // {
          pname = "vibetogether";
          cargoExtraArgs = "--locked -p vibetogether";
          meta.mainProgram = "vibetogether";
        });
      # The command line as one static binary for Linux, which runs on any
      # Linux of its architecture: what a release ships, for an agent that
      # can't install it otherwise, such as one in a sandbox.
      cliStatic = let
        static = pkgs.pkgsStatic;
        target = static.stdenv.hostPlatform.rust.rustcTarget;
        cc = "${static.stdenv.cc}/bin/${static.stdenv.cc.targetPrefix}cc";
        craneStatic = (crane.mkLib pkgs).overrideToolchain (p: (toolchain p).override {targets = [target];});
        args =
          common
          // {
            pname = "vibetogether-static";
            cargoExtraArgs = "--locked -p vibetogether";
            CARGO_BUILD_TARGET = target;
            CARGO_BUILD_RUSTFLAGS = "-C target-feature=+crt-static";
            "CARGO_TARGET_${lib.toUpper (builtins.replaceStrings ["-"] ["_"] target)}_LINKER" = cc;
            "CC_${builtins.replaceStrings ["-"] ["_"] target}" = cc;
            HOST_CC = "${pkgs.stdenv.cc}/bin/cc";
            meta.mainProgram = "vibetogether";
          };
      in
        craneStatic.buildPackage (args // {cargoArtifacts = craneStatic.buildDepsOnly args;});
      # The client compiled to WebAssembly, with its bindings for the
      # website: an ES module, its WebAssembly and its types.
      web = craneLib.mkCargoDerivation (wasm
        // {
          cargoArtifacts = craneLib.buildDepsOnly wasm;
          nativeBuildInputs = [(wasmBindgen pkgs)];
          buildPhaseCargoCommand = "cargo build --release $cargoExtraArgs";
          installPhaseCommand = ''
            wasm-bindgen --target web --out-dir $out \
              target/wasm32-unknown-unknown/release/vibetogether_client.wasm
          '';
        });
    };
  in {
    packages = forEachSystem (pkgs: let
      built = rust pkgs;
    in
      {
        vibetogether-backend = built.backend;
        vibetogether = built.cli;
        default = built.cli;
      }
      // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        vibetogether-static = built.cliStatic;
      }
      // {
        # The website, as it is served: its pages with the client's bindings.
        website = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = "vibetogether-website";
          inherit ((lib.importTOML ./Cargo.toml).workspace.package) version;
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.difference (lib.fileset.unions [
              ./package.json
              ./pnpm-lock.yaml
              ./pnpm-workspace.yaml
              ./website
            ]) (lib.fileset.maybeMissing ./website/node_modules);
          };
          pnpmWorkspaces = ["vibetogether"];
          nativeBuildInputs = [pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook];
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src pnpmWorkspaces;
            hash = "sha256-eXJTnF829XLAbKeg1hyUvED6V+EAHXxfDr5PMPvkBew=";
            fetcherVersion = 4;
            # pnpm leaves an empty `links` in its store on Darwin only, which
            # fetchPnpmDeps keeps, so the hash would differ between platforms.
            preFixup = "rm -rf $storePath/v11/links";
          };
          buildPhase = ''
            runHook preBuild
            rm -rf website/src/client
            cp -r ${built.web} website/src/client
            chmod -R u+w website/src/client
            pnpm --filter vibetogether build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            cp -r website/dist $out
            runHook postInstall
          '';
        });
      });

    nixosModules.backend = import ./backend/nixos-module.nix self;

    # Every language in the tree, behind one command. The global pre-commit
    # hook checks a repository by running this, so a language left out here is
    # a language nothing checks.
    formatter = forEachSystem (pkgs:
      treefmt-nix.lib.mkWrapper pkgs {
        projectRootFile = "flake.nix";
        programs.rustfmt.enable = true;
        programs.rustfmt.package = toolchain pkgs;
        programs.biome.enable = true;
        # One configuration for both, rather than treefmt's own default.
        # treefmt names the files itself, and Biome would look for the ignore
        # file next to the copy in the store. Biome checks the configuration as
        # it loads, and treefmt-nix's schema lags behind it.
        programs.biome.validate.enable = false;
        programs.biome.settings = removeAttrs (builtins.fromJSON (builtins.readFile ./biome.json)) ["vcs"];
        programs.alejandra.enable = true;
        programs.just.enable = true;
        programs.shellcheck.enable = true;
        programs.shfmt.enable = true;
        # direnv reads it, no shell runs it.
        settings.formatter.shellcheck.excludes = [".envrc"];
        # Made by wasm-bindgen.
        settings.global.excludes = ["website/src/client/*"];
      });

    devShells = forEachSystem (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs; [(toolchain pkgs) (wasmBindgen pkgs) nodejs pnpm biome just sqlite rsync];
      };
    });
  };
}
