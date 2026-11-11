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
  in {
    packages = forEachSystem (pkgs: {
      # The backend as it runs, the MCP server in it: their sources and their
      # production dependencies, which Node runs as they are, stripping the
      # types itself.
      vibetogether-backend = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
        pname = "vibetogether-backend";
        version = "0.1.0";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./backend/package.json
            ./backend/src
            ./mcp/package.json
            ./mcp/src
          ];
        };
        pnpmWorkspaces = ["vibetogether-backend..."];
        nativeBuildInputs = [pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook pkgs.makeWrapper];
        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src pnpmWorkspaces;
          fetcherVersion = 4;
          hash = "sha256-a5jUcY2fVIVEVuHqSI4p4AoPCpSlpf7feZokubpfQzo=";
          # pnpm leaves an empty `links` in its store on Darwin only, which
          # fetchPnpmDeps keeps, so the hash would differ between platforms.
          preFixup = "rm -rf $storePath/v11/links";
        };
        pnpmInstallFlags = ["--prod"];
        installPhase = ''
          # Each part's node_modules links into the workspace's, so all go.
          dir=$out/lib/vibetogether-backend
          mkdir -p $dir/backend $dir/mcp
          cp -r node_modules $dir
          cp -r backend/package.json backend/src backend/node_modules $dir/backend
          cp -r mcp/package.json mcp/src mcp/node_modules $dir/mcp
          makeWrapper ${lib.getExe pkgs.nodejs} $out/bin/vibetogether-backend \
            --add-flags $dir/backend/src/main.ts
        '';
        meta.mainProgram = "vibetogether-backend";
      });
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
