# Katulong GitHub Pages

This directory contains the source for the Katulong project website hosted on GitHub Pages.

## 📸 Adding Screenshots

To add screenshots to the website:

1. Take screenshots of Katulong in action (see suggestions below)
2. Save images to `docs/assets/images/`
3. Update `docs/index.html` to replace the placeholder divs with actual images

### Recommended Screenshots

1. **Terminal Interface** (`terminal-main.png`)
   - Full terminal view with shortcut bar
   - Show some colorful terminal output
   - Demonstrate the clean UI

2. **Mobile View** (`terminal-mobile.png`)
   - Terminal on mobile device (use browser dev tools to simulate)
   - Show touch-optimized controls
   - Demonstrate responsive design

3. **LAN Pairing** (`pairing-flow.png`)
   - QR code displayed in settings
   - PIN entry screen
   - Show the pairing wizard

4. **Settings Panel** (`settings.png`)
   - Device management interface
   - List of paired devices
   - Token management

5. **Shortcuts Editor** (`shortcuts-editor.png`)
   - Visual shortcut customization interface
   - Keyboard chord builder
   - Custom command setup

6. **Multi-Session** (`sessions.png`)
   - Session list view
   - Multiple active sessions
   - Session switching UI

### Screenshot Guidelines

- **Resolution:** 1920x1080 or higher (will be scaled down)
- **Format:** PNG for UI screenshots, JPG for photos
- **Content:** Show real usage scenarios, not lorem ipsum
- **Privacy:** Don't include sensitive information in terminal output
- **Quality:** Use macOS screenshot (Cmd+Shift+4) or equivalent
- **Annotations:** Optional - add arrows or highlights for clarity

### Updating the HTML

Replace placeholder divs like this:

```html
<!-- Before -->
<div class="screenshot-placeholder">
  <p>📸 Terminal Interface</p>
</div>

<!-- After -->
<img src="assets/images/terminal-main.png" alt="Terminal Interface" />
```

## 🚀 Deploying to GitHub Pages

1. Commit changes to the `docs/` folder
2. Push to main branch
3. Go to GitHub repo Settings → Pages
4. Set source to: **main branch / docs folder**
5. Save and wait for deployment (usually < 1 minute)

Your site will be available at: `https://dorky-robot.github.io/katulong/`

## 🎨 Customization

### Colors

Edit `docs/assets/css/style.css` CSS variables:

```css
:root {
  --primary: #6366f1;      /* Main brand color */
  --primary-dark: #4f46e5; /* Hover states */
  --dark: #0f172a;         /* Text color */
  /* ... */
}
```

### Content

Edit `docs/index.html` directly. Sections:
- Hero (title, subtitle, CTA)
- Features (feature cards)
- Security (security highlights)
- Screenshots (gallery)
- Installation (getting started guide) - **Updated with Homebrew as primary method**
- Use Cases (who is this for)

**Note:** Installation section now shows Homebrew as the primary installation method, with CLI commands for managing Katulong services.

### JavaScript

Edit `docs/assets/js/main.js` for:
- Smooth scrolling behavior
- Animation triggers
- Code block copy functionality

## 📝 Tips

- Keep content concise and scannable
- Use emojis sparingly for visual interest
- Highlight unique features (WebAuthn, P2P, LAN pairing)
- Include actual terminal commands that work
- Make CTAs clear and prominent
- Update security stats when new improvements ship

## 🔗 External Links

Make sure these are up to date:
- GitHub repository URL
- Issue tracker
- Discussions page
- Documentation links

## 📊 Analytics (Optional)

To add analytics:
1. Get Google Analytics tracking ID
2. Add tracking script to `<head>` in index.html
3. Or use privacy-focused alternatives (Plausible, Fathom)

---

**Note:** The site is currently using placeholder screenshots. Replace them with real screenshots before promoting widely!
