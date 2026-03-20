class Katulong < Formula
  desc "Self-hosted web terminal with tmux sessions and WebAuthn security"
  homepage "https://github.com/Dorky-Robot/katulong"
  url "https://github.com/Dorky-Robot/katulong/archive/refs/tags/v0.31.12.tar.gz"
  sha256 "34237919ed0d7c9999652fc36415f9422774702faf85b091afd8f4592107c726"
  license "MIT"

  depends_on "node"

  depends_on "tmux"

  def install
    system "npm", "install", "--omit=dev"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/katulong"
  end

  def post_install
    # Use the katulong CLI itself to handle the upgrade lifecycle.
    # `katulong service restart` does launchctl unload/load if the
    # LaunchAgent is installed; `katulong restart` does stop+start
    # otherwise. This avoids duplicating process/launchd management
    # in Ruby.
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
