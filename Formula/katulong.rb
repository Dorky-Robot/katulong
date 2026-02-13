class Katulong < Formula
  desc "Self-hosted web terminal with remote shell access"
  homepage "https://github.com/dorky-robot/katulong"
  url "https://github.com/dorky-robot/katulong/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "01bc365cc044f00315f9f33608d5f9ace2b949f838ae715aa41016ee235f1f87"
  license "MIT"

  depends_on "node"

  def install
    # Install npm dependencies
    system "npm", "install", "--production", "--omit=dev"

    # Install everything to libexec
    libexec.install Dir["*"]

    # Create wrapper script that sets DATA_DIR
    (bin/"katulong").write <<~EOS
      #!/bin/bash
      export KATULONG_DATA_DIR="${HOME}/.config/katulong"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/katulong" "$@"
    EOS
  end

  def post_install
    # Create config directory
    config_dir = Pathname.new(Dir.home) / ".config" / "katulong"
    config_dir.mkpath
  end

  service do
    run [opt_bin/"katulong", "start", "--foreground"]
    keep_alive true
    working_dir var
    log_path var/"log/katulong.log"
    error_log_path var/"log/katulong.log"
    environment_variables KATULONG_DATA_DIR: "#{Dir.home}/.config/katulong"
  end

  test do
    system "#{bin}/katulong", "--version"
  end
end
