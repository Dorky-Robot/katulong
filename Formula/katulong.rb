class Katulong < Formula
  desc "Self-hosted web terminal with tmux sessions and WebAuthn security"
  homepage "https://github.com/Dorky-Robot/katulong"
  url "https://github.com/Dorky-Robot/katulong/archive/refs/tags/v0.28.0.tar.gz"
  sha256 "36fbd4a77ced81ecb8ad366c405ce1c2ac4d97bcede4eaed3b2a6dba1cbed705"
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

    plist_path = Pathname.new(Dir.home) / "Library/LaunchAgents/com.dorkyrobot.katulong.plist"

    if plist_path.exist?
      # LaunchAgent is installed — let launchctl handle the lifecycle.
      # Unload (kills old process) then reload (starts new version).
      system "launchctl", "unload", plist_path.to_s
      system "launchctl", "load", "-w", plist_path.to_s
    else
      # No LaunchAgent — stop the old server manually so it doesn't serve
      # 500s from deleted Cellar files. During `brew upgrade`, the old
      # process still references the old Cellar path. Cleanup deletes those
      # files, causing readFileSync failures → 500 errors.
      # This runs in post_install (not install) because Homebrew's sandbox
      # blocks process signals during install on macOS.
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
  end

  def caveats
    <<~EOS
      To auto-start katulong on login:
        katulong service install

      To restart after upgrading (if not using the service):
        katulong start

      If the service is installed, brew upgrade restarts it automatically.
    EOS
  end

  test do
    assert_match "katulong", shell_output("#{bin}/katulong --help")
  end
end
