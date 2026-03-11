class Katulong < Formula
  desc "Self-hosted web terminal with remote shell access"
  homepage "https://github.com/dorky-robot/katulong"
  url "https://github.com/dorky-robot/katulong/archive/refs/tags/v0.14.10.tar.gz"
  sha256 "92ecdcd6adabf66b0c87b14f0f885d089fcdb7c3ee58c1264f83349c39d7bc09"
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
