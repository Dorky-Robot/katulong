class Katulong < Formula
  desc "Self-hosted web terminal with remote shell access"
  homepage "https://github.com/dorky-robot/katulong"
  url "https://github.com/dorky-robot/katulong/archive/refs/tags/v0.14.9.tar.gz"
  sha256 "91478706b94f9090b69faa466b40ea77ad93c8ee025ceaea938fc7326a8a9268"
  license "MIT"

  depends_on "node"
  depends_on "tmux"

  def install
    # Install npm dependencies (prepare script now handles missing husky gracefully)
    system "npm", "install", "--production", "--omit=dev"

    # Install everything to libexec
    libexec.install Dir["*"]

    # Create wrapper script that sets DATA_DIR and ensures Homebrew bin is in PATH
    (bin/"katulong").write <<~EOS
      #!/bin/bash
      export KATULONG_DATA_DIR="${HOME}/.katulong"
      export PATH="#{HOMEBREW_PREFIX}/bin:#{HOMEBREW_PREFIX}/sbin:$PATH"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/katulong" "$@"
    EOS
  end

  def post_install
    # Create data directory (matches wrapper's KATULONG_DATA_DIR)
    data_dir = Pathname.new(Dir.home) / ".katulong"
    data_dir.mkpath
  end

  service do
    run [opt_bin/"katulong", "start", "--foreground"]
    keep_alive true
    working_dir var
    log_path var/"log/katulong.log"
    error_log_path var/"log/katulong.log"
    environment_variables KATULONG_DATA_DIR: "#{Dir.home}/.katulong"
  end

  test do
    system "#{bin}/katulong", "--version"
  end
end
