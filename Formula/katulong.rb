class Katulong < Formula
  desc "Self-hosted web terminal with tmux sessions and WebAuthn security"
  homepage "https://github.com/Dorky-Robot/katulong"
  url "https://github.com/Dorky-Robot/katulong/archive/refs/tags/v0.61.0.tar.gz"
  sha256 "a211f803d0bb0426bd0412671715f8954b5ae9d8b062234e50173466008ce7ca"
  license any_of: ["MIT", "Apache-2.0"]

  depends_on "node"

  depends_on "tmux"

  def install
    system "npm", "install", "--omit=dev"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/katulong"
  end

  def post_install
    katulong = bin/"katulong"

    # Best-effort orphan tmux socket cleanup. Dev machines that have
    # run the test suite accumulate `katulong-test-<pid>` sockets in
    # /tmp/tmux-$UID/ (one machine hit 16k+), which eventually
    # destabilizes tmux itself. The sweep is prefix-scoped and only
    # touches entries whose creator PID is dead, so it's always safe
    # to run. Failure here must never block the install — we run in
    # a subshell that always exits 0.
    system "/bin/sh", "-c", "#{katulong} tmux-sweep --quiet 2>/dev/null || true"

    # When `katulong update` is driving the upgrade, it creates a sentinel
    # file and handles the smoke-test-and-swap restart itself.  Skip here
    # so we don't race with that process or hit EPERM on the plist.
    sentinel = Pathname.new(Dir.home) / ".katulong" / ".update-in-progress"
    if sentinel.exist?
      ohai "Restart managed by `katulong update` — skipping post_install restart"
      return
    end

    # Standalone `brew upgrade` (not via `katulong update`): restart normally.
    if (Pathname.new(Dir.home) / "Library/LaunchAgents/com.dorkyrobot.katulong.plist").exist?
      system katulong, "service", "restart"
    else
      system katulong, "restart"
    end
  end

  def caveats
    <<~EOS
      To auto-start katulong on login:
        katulong service install

      To restart after upgrading (if not using the service):
        katulong start

      If the service is installed, brew upgrade restarts it automatically.

      Upgrading from a pre-v0.56 build? The pub/sub directory may contain
      stale topics left behind by retired releases (high-volume PTY output
      streams, and pre-thin-event Claude session logs). Run:
        katulong topics purge             # preview (dry-run, default)
        katulong topics purge --yes       # delete the previewed topics
    EOS
  end

  test do
    assert_match "katulong", shell_output("#{bin}/katulong --help")
  end
end
