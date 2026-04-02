class Katulong < Formula
  desc "Self-hosted web terminal with tmux sessions and WebAuthn security"
  homepage "https://github.com/Dorky-Robot/katulong"
  url "https://github.com/Dorky-Robot/katulong/archive/refs/tags/v0.44.53.tar.gz"
  sha256 "c9e8670918fbfdba70d82c2b482203cb945932a788347f529fbd695d7e49f305"
  license "MIT"

  depends_on "node"

  depends_on "tmux"

  def install
    system "npm", "install", "--omit=dev"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/katulong"
  end

  def post_install
    # When `katulong update` is driving the upgrade, it creates a sentinel
    # file and handles the smoke-test-and-swap restart itself.  Skip here
    # so we don't race with that process or hit EPERM on the plist.
    sentinel = Pathname.new(Dir.home) / ".katulong" / ".update-in-progress"
    if sentinel.exist?
      ohai "Restart managed by `katulong update` — skipping post_install restart"
      return
    end

    # Standalone `brew upgrade` (not via `katulong update`): restart normally.
    katulong = bin/"katulong"
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
    EOS
  end

  test do
    assert_match "katulong", shell_output("#{bin}/katulong --help")
  end
end
