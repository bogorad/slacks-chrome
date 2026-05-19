{
  description = "Development Environment (with NixOS fixes)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    sops-nix.url = "github:Mic92/sops-nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      sops-nix,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # config.allowUnfree = true; # Required for steam-run
        };

        # Check if system is x86_64 (amd64)
        isX86_64 = pkgs.stdenv.hostPlatform.system == "x86_64-linux";
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              # Development tools
              nodejs_25
              nodePackages.pnpm
              go

              # Database tools
              postgresql

              # Secrets management
              sops
              age
              ssh-to-age

              # Utilities
              curl
              jq
              yq-go
              tmux
              xmlstarlet
              qrencode

              # Dynamic linker for agent-browser
              nix-ld
            ]
            # Extra tools on x86_64
            ++ pkgs.lib.optionals isX86_64 [
              wrangler
            ];

          shell = "${pkgs.zsh}/bin/zsh";

          shellHook = ''
            # Automatically install dependencies with pnpm if not already installed
            if [ ! -d "node_modules" ]; then
              echo "Running 'pnpm install' for you..."
              pnpm install
            fi

            ${pkgs.lib.optionalString isX86_64 ''
              echo "============================================================================="
              echo "Welcome to the Artwalls dev environment."
              echo "Wrangler is configured for NixOS (via steam-run) when workerd is installed."
              echo "Run 'just dev' to start the local server."
              echo "============================================================================="
            ''}

            ${pkgs.lib.optionalString (!isX86_64) ''
              echo ""
              echo "============================================================================="
              echo "  ⚠️  ERROR: INCOMPATIBLE ARCHITECTURE DETECTED"
              echo "============================================================================="
              echo ""
              echo "Current system: ${pkgs.stdenv.hostPlatform.system}"
              echo ""
              echo "This development environment requires x86_64-linux (amd64)."
              echo "Cloudflare wrangler and workerd are NOT available on ARM64/aarch64."
              echo ""
              echo "❌ Local development will NOT work on this system"
              echo "❌ 'just dev' and 'wrangler' commands will fail"
              echo ""
              echo "Options:"
              echo "  • Use an x86_64 Linux machine or VM"
              echo "  • Deploy to staging for testing: 'just deploy-staging'"
              echo "  • Use remote development environment"
              echo ""
              echo "============================================================================="
              echo ""
            ''}

            # Enable dynamic linking for agent-browser
            export NIX_LD_LIBRARY_PATH=${
              pkgs.lib.makeLibraryPath [
                pkgs.stdenv.cc.cc
                pkgs.glibc
                pkgs.zlib
                pkgs.xorg.libX11
                pkgs.xorg.libXcomposite
                pkgs.xorg.libXdamage
                pkgs.xorg.libXext
                pkgs.xorg.libXfixes
                pkgs.xorg.libXrandr
                pkgs.libdrm
                pkgs.mesa
                pkgs.nspr
                pkgs.nss
                pkgs.pango
                pkgs.expat
                pkgs.libxkbcommon
                pkgs.cairo
                pkgs.cups
                pkgs.dbus
                pkgs.atk
                pkgs.gtk3
                pkgs.gdk-pixbuf
                pkgs.at-spi2-atk
                pkgs.at-spi2-core
                pkgs.alsa-lib
              ]
            }
            export NIX_LD=$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)

            # Auto-patch agent-browser if it exists and needs patching
            if [ -f "./node_modules/agent-browser/bin/agent-browser-linux-x64" ]; then
              # Check if already patched by looking for our interpreter
              if ! patchelf --print-interpreter node_modules/agent-browser/bin/agent-browser-linux-x64 2>/dev/null | grep -q "nix/store"; then
                echo "Patching agent-browser binary for NixOS..."
                patchelf --set-interpreter $NIX_LD node_modules/agent-browser/bin/agent-browser-linux-x64 2>/dev/null || true
              fi
            fi

            export AGENT_BROWSER_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium
            export OPENCODE_EXPERIMENTAL=1
          '';
        };
      }
    );
}
