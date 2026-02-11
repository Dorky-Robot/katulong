    import {
      startRegistration,
      startAuthentication,
    } from "/vendor/simplewebauthn/browser.esm.js";
    import { getOrCreateDeviceId, generateDeviceName } from "/lib/device.js";
    import { checkWebAuthnSupport, getWebAuthnErrorMessage } from "/lib/webauthn-errors.js";

    const setupView = document.getElementById("setup-view");
    const loginView = document.getElementById("login-view");
    const pairView = document.getElementById("pair-view");
    const loadingView = document.getElementById("loading-view");
    const setupError = document.getElementById("setup-error");
    const loginError = document.getElementById("login-error");

    const hasWebAuthn = window.isSecureContext && !!window.PublicKeyCredential;
    const isMobile = /Android|iPad|iPhone|iPod/.test(navigator.userAgent);

    // Check if user was redirected after session revocation
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reason') === 'revoked') {
      // Show info message about session being revoked
      if (loginError) {
        loginError.innerHTML = '<i class="ph ph-info"></i> Your access was revoked. Please register a new passkey to continue.';
        loginError.style.color = '#6b9bd1'; // Info blue
        loginError.style.textAlign = 'center';
        loginError.style.marginBottom = '1rem';
      }
      // Clean up URL without reload
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // --- WebAuthn Support Checks ---
    // WebAuthn support and error functions imported from /lib/webauthn-errors.js

    // --- Device ID Management ---
    // Device management functions imported from /lib/device.js

    async function checkStatus() {
      const res = await fetch("/auth/status");
      const { setup } = await res.json();
      loadingView.classList.add("hidden");
      if (setup) {
        if (hasWebAuthn) {
          // HTTPS (desktop or mobile) — passkey login/registration
          loginView.classList.remove("hidden");

          // Check if user has passkeys for this domain
          await checkForExistingPasskeys();
        } else {
          // HTTP or no WebAuthn support — show QR pairing instructions
          pairView.classList.remove("hidden");
        }
      } else {
        setupView.classList.remove("hidden");
      }
    }

    async function checkForExistingPasskeys() {
      try {
        // Try to get login options to see if there are any credentials
        const optsRes = await fetch("/auth/login/options", { method: "POST" });
        if (optsRes.ok) {
          const opts = await optsRes.json();

          // If no credentials available, hide login button and show only register
          if (!opts.allowCredentials || opts.allowCredentials.length === 0) {
            // Hide the login button
            const loginBtn = document.getElementById("login-btn");
            if (loginBtn) {
              loginBtn.style.display = 'none';
            }

            // Hide the "Register New Passkey" button and show fields directly
            const showRegisterBtn = document.getElementById("show-register-btn");
            const registerFields = document.getElementById("register-fields");
            if (showRegisterBtn && registerFields) {
              showRegisterBtn.style.display = 'none';
              registerFields.classList.remove('hidden');
            }

            // Show helpful message
            loginError.innerHTML = '<i class="ph ph-info"></i> No passkey registered yet. Please register your fingerprint/Touch ID below.';
            loginError.style.color = '#6b9bd1'; // Info blue instead of error red
            loginError.style.textAlign = 'center';
            loginError.style.marginBottom = '1rem';
          }
        }
      } catch (err) {
        // Silently fail - user can still try to login and get proper error
        console.log('Could not check for existing passkeys:', err);
      }
    }

    // --- Registration ---

    document.getElementById("register-btn").addEventListener("click", async () => {
      const btn = document.getElementById("register-btn");
      const token = document.getElementById("setup-token").value.trim();
      setupError.textContent = "";

      // Token is optional for first registration from localhost
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '::1';
      if (!token && !isLocalhost) {
        setupError.textContent = "Setup token is required for remote registration.";
        return;
      }

      // Check WebAuthn support
      const supportCheck = checkWebAuthnSupport();
      if (!supportCheck.supported) {
        setupError.textContent = supportCheck.error;
        return;
      }

      btn.disabled = true;
      try {
        // Get registration options
        const optsRes = await fetch("/auth/register/options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setupToken: token }),
        });
        if (!optsRes.ok) {
          const err = await optsRes.json();
          throw new Error(err.error || "Failed to get registration options");
        }
        const opts = await optsRes.json();

        // Start WebAuthn registration
        const credential = await startRegistration({ optionsJSON: opts });

        // Get device metadata
        const deviceId = await getOrCreateDeviceId();
        const deviceName = generateDeviceName();
        const userAgent = navigator.userAgent;

        // Verify with server
        const verifyRes = await fetch("/auth/register/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credential,
            setupToken: token,
            deviceId,
            deviceName,
            userAgent
          }),
        });
        if (!verifyRes.ok) {
          const err = await verifyRes.json();
          throw new Error(err.error || "Registration failed");
        }

        // Store credential ID for "this device" detection
        localStorage.setItem('katulong_current_credential', credential.id);

        // Success — redirect
        window.location.href = "/";
      } catch (err) {
        setupError.textContent = getWebAuthnErrorMessage(err);
      } finally {
        btn.disabled = false;
      }
    });

    // --- Register new passkey (on already-setup instance) ---

    document.getElementById("show-register-btn").addEventListener("click", () => {
      document.getElementById("register-fields").classList.toggle("hidden");
    });

    document.getElementById("register-new-btn").addEventListener("click", async () => {
      const btn = document.getElementById("register-new-btn");
      const token = document.getElementById("register-token").value.trim();
      loginError.textContent = "";

      if (!token) { loginError.textContent = "Setup token is required."; return; }

      // Check WebAuthn support
      const supportCheck = checkWebAuthnSupport();
      if (!supportCheck.supported) {
        loginError.textContent = supportCheck.error;
        return;
      }

      btn.disabled = true;
      try {
        const optsRes = await fetch("/auth/register/options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setupToken: token }),
        });
        if (!optsRes.ok) {
          const err = await optsRes.json();
          throw new Error(err.error || "Failed to get registration options");
        }
        const opts = await optsRes.json();
        const credential = await startRegistration({ optionsJSON: opts });

        // Get device metadata
        const deviceId = await getOrCreateDeviceId();
        const deviceName = generateDeviceName();
        const userAgent = navigator.userAgent;

        const verifyRes = await fetch("/auth/register/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credential,
            setupToken: token,
            deviceId,
            deviceName,
            userAgent
          }),
        });
        if (!verifyRes.ok) {
          const err = await verifyRes.json();
          throw new Error(err.error || "Registration failed");
        }

        // Store credential ID for "this device" detection
        localStorage.setItem('katulong_current_credential', credential.id);

        window.location.href = "/";
      } catch (err) {
        loginError.textContent = getWebAuthnErrorMessage(err);
      } finally {
        btn.disabled = false;
      }
    });

    // --- Login ---

    document.getElementById("login-btn").addEventListener("click", async () => {
      const btn = document.getElementById("login-btn");
      loginError.textContent = "";
      loginError.style.color = ''; // Reset to default error color

      // Check WebAuthn support
      const supportCheck = checkWebAuthnSupport();
      if (!supportCheck.supported) {
        loginError.textContent = supportCheck.error;
        return;
      }

      btn.disabled = true;

      try {
        // Get authentication options
        const optsRes = await fetch("/auth/login/options", { method: "POST" });
        if (!optsRes.ok) {
          const err = await optsRes.json();
          throw new Error(err.error || "Failed to get login options");
        }
        const opts = await optsRes.json();

        // Check if there are any passkeys available for this domain
        if (!opts.allowCredentials || opts.allowCredentials.length === 0) {
          loginError.innerHTML = 'No passkeys registered for this device. Please click <strong>"Register New Passkey"</strong> below to set one up.';
          return;
        }

        // Start WebAuthn authentication
        const credential = await startAuthentication({ optionsJSON: opts });

        // Verify with server
        const verifyRes = await fetch("/auth/login/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential }),
        });
        if (!verifyRes.ok) {
          const err = await verifyRes.json();
          throw new Error(err.error || "Login failed");
        }

        // Store credential ID for "this device" detection
        localStorage.setItem('katulong_current_credential', credential.id);

        // Success — redirect
        window.location.href = "/";
      } catch (err) {
        // Special handling for "no passkeys available" error
        if (err.name === "NotAllowedError" && err.message?.includes("No available authenticator")) {
          loginError.innerHTML = 'No passkeys found for this device. Please click <strong>"Register New Passkey"</strong> below to set one up.';
        } else {
          loginError.textContent = getWebAuthnErrorMessage(err);
        }
      } finally {
        btn.disabled = false;
      }
    });

    checkStatus();
