class Katulong < Formula
  desc "Self-hosted web terminal with tmux sessions and WebAuthn security"
  homepage "https://github.com/Dorky-Robot/katulong"
  url "https://github.com/Dorky-Robot/katulong/archive/refs/tags/v0.26.6.tar.gz"
  sha256 "09b1a84f5313afc7bc9af475fef81da53e671790fa489c24549d623058d57057"
  license "MIT"

  depends_on "node"

  depends_on "tmux"

  def install
    system "npm", "install", "--omit=dev"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/katulong"
  end

  def post_install
    # Create data directory
    data_dir = Pathname.new(Dir.home) / ".katulong"
    data_dir.mkpath

    # Stop the old server so it doesn't serve 500s from deleted Cellar files.
    # During `brew upgrade`, the old process still references the old Cellar path.
    # Cleanup deletes those files, causing readFileSync failures → 500 errors.
    # This runs in post_install (not install) because Homebrew's sandbox blocks
    # process signals during install on macOS.
    pid_file = data_dir / "server.pid"
    if pid_file.exist?
      old_pid = pid_file.read.strip.to_i
      if old_pid > 0
        begin
          Process.kill("TERM", old_pid)
          sleep 3
        rescue Errno::ESRCH, Errno::EPERM
          # Process already exited or PID reused by another user's process
        end
      end
    end
  end

  def caveats
    <<~EOS
      To restart katulong after upgrading:
        katulong start

      Or use brew services for automatic lifecycle management:
        brew services start katulong
    EOS
  end

  test do
    assert_match "katulong", shell_output("#{bin}/katulong --help")
  end
end
