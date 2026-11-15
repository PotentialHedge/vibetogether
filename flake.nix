{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    treefmt-nix,
    ...
  }: let
    inherit (nixpkgs) lib;

    forEachSystem = f:
      lib.genAttrs ["aarch64-darwin" "x86_64-linux"]
      (system: f nixpkgs.legacyPackages.${system});

    # One environment, entered by the shell and by the checks alike. The
    # TypeScript compiler and the type definitions are pinned by pnpm instead,
    # since editors look for them in node_modules.
    tools = pkgs: with pkgs; [nodejs pnpm biome just curl jq rsync];

    # A part of the workspace as it runs: its sources and those of the parts it
    # depends on, with their production dependencies, which Node runs as they
    # are, stripping the types itself.
    workspacePackage = pkgs: {
      pname,
      bin,
      parts,
      main,
      hash,
    }:
      pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
        inherit pname;
        version = "0.1.0";
        src = lib.fileset.toSource {
          root = ./.;
          fileset =
            lib.fileset.unions ([./package.json ./pnpm-lock.yaml ./pnpm-workspace.yaml]
              ++ lib.concatMap (part: [./${part}/package.json ./${part}/src]) parts);
        };
        pnpmWorkspaces = ["${pname}..."];
        nativeBuildInputs = [pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook pkgs.makeWrapper];
        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src pnpmWorkspaces;
          inherit hash;
          fetcherVersion = 4;
          # pnpm leaves an empty `links` in its store on Darwin only, which
          # fetchPnpmDeps keeps, so the hash would differ between platforms.
          preFixup = "rm -rf $storePath/v11/links";
        };
        pnpmInstallFlags = ["--prod"];
        # Each part's node_modules links into the workspace's, so all go.
        installPhase = ''
          dir=$out/lib/${pname}
          mkdir -p $dir
          cp -r node_modules $dir
          ${lib.concatMapStrings (part: ''
              mkdir -p $dir/${part}
              cp -r ${part}/package.json ${part}/src $dir/${part}
              # A part with no dependencies of its own has none.
              if [ -d ${part}/node_modules ]; then cp -r ${part}/node_modules $dir/${part}; fi
            '')
            parts}
          makeWrapper ${lib.getExe pkgs.nodejs} $out/bin/${bin} --add-flags $dir/${main}
        '';
        meta.mainProgram = bin;
      });
  in {
    packages = forEachSystem (pkgs: {
      # The backend, the MCP server in it.
      vibetogether-backend = workspacePackage pkgs {
        pname = "vibetogether-backend";
        bin = "vibetogether-backend";
        parts = ["backend" "mcp" "operations"];
        main = "backend/src/main.ts";
        hash = "sha256-a5jUcY2fVIVEVuHqSI4p4AoPCpSlpf7feZokubpfQzo=";
      };
      # The command line, made from the operations' mapping alone.
      vibetogether = workspacePackage pkgs {
        pname = "vibetogether-cli";
        bin = "vibetogether";
        parts = ["cli" "operations"];
        main = "cli/src/cli.ts";
        hash = "sha256-k+kTjtSljaE+aMAQzBNVXpiA97lZsZdBWTdSVl1f47w=";
      };
    });

    nixosModules.backend = import ./backend/nixos-module.nix self;

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
        programs.just.enable = true;
        programs.shellcheck.enable = true;
        programs.shfmt.enable = true;
        # direnv reads it, no shell runs it.
        settings.formatter.shellcheck.excludes = [".envrc"];
      });

    devShells = forEachSystem (pkgs: {
      default = pkgs.mkShell {packages = tools pkgs;};
    });
  };
}
