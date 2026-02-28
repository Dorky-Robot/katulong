# Use Cases

## Remote Development

Access your development server from anywhere. Full terminal on your phone when you're away from your desk.

## Quick Commands

Run deployment scripts, check server status, or restart services from your mobile device.

## Learning & Teaching

Share terminal access with students or teammates. Multiple sessions, multiple devices.

## Home Lab Management

Manage your home server, Raspberry Pi, or media center from any device on your network.

---

## Why Not Just SSH?

SSH is great. Katulong actually includes an SSH server. But SSH alone has friction that adds up:

- **You need a client.** Your phone doesn't have one. Your partner's laptop doesn't have one. A Chromebook at a coffee shop doesn't have one. A browser is universal.
- **You need keys or passwords.** SSH key management is a chore — generating keys, copying them to servers, rotating them, dealing with `Permission denied (publickey)`. Katulong uses WebAuthn passkeys. Register once with your fingerprint, done.
- **You need network plumbing.** SSH requires an open port, which means firewall rules, port forwarding, dynamic DNS, or a VPN. Katulong works over HTTPS through any tunnel — same port, same protocol as every other website.
- **Sessions require tmux.** SSH doesn't persist sessions on its own. You need tmux or screen, which means learning keybindings, configuring `.tmux.conf`, and remembering to attach. Katulong sessions persist by default. Close your browser, open it tomorrow, your session is there.
- **Mobile is painful.** Even with an SSH app, typing commands on a phone keyboard without Ctrl, Tab, or arrow keys is miserable. Katulong has swipe navigation, a shortcut toolbar, and a full-screen text area that works with speech-to-text.
- **Drag-and-drop doesn't work.** Try dragging an image into Claude Code over SSH — you get a file path dumped into the input, not the image. A browser terminal handles drag-and-drop, clipboard, and file uploads natively because it's a browser.
- **Sharing is hard.** Showing someone your terminal over SSH means giving them credentials and hoping they have a client. With Katulong, you share a URL. Multiple people can join the same session instantly — open the same link and you're pair programming in real time.

SSH is the right tool when you have a proper terminal, a configured client, and network access. Katulong is for everything else — the phone in your pocket, the tablet on the couch, the browser tab you can open anywhere.

## When SSH Is the Better Choice

Katulong doesn't replace SSH — it fills a different gap:

- **You're already at a terminal.** SSH gives you native performance with zero overhead.
- **You need to transfer files.** `scp`, `rsync`, and SFTP are battle-tested. Katulong doesn't do file transfer.
- **You're scripting or automating.** `ssh host 'command'` in a script, piping output, running Ansible playbooks — the entire ops ecosystem is built on SSH.
- **You're accessing many machines.** SSH scales to hundreds of hosts with `~/.ssh/config`, jump hosts, and agent forwarding. Katulong runs on one machine.
- **You need port forwarding or tunneling.** SSH tunnels (`-L`, `-R`, `-D`) are a core feature. Katulong doesn't forward ports.
- **You want minimal attack surface.** SSH is a single well-audited binary with decades of hardening. Katulong is a Node.js web application with a broader surface area.
