    import {
      startRegistration,
      startAuthentication,
    } from "/vendor/simplewebauthn/browser.esm.js";

    const setupView = document.getElementById("setup-view");
    const loginView = document.getElementById("login-view");
    const pairView = document.getElementById("pair-view");
    const loadingView = document.getElementById("loading-view");
    const setupError = document.getElementById("setup-error");
    const loginError = document.getElementById("login-error");

    const hasWebAuthn = window.isSecureContext && !!window.PublicKeyCredential;
    const isMobile = /Android|iPad|iPhone|iPod/.test(navigator.userAgent);

    // --- WebAuthn Support Checks ---

    function checkWebAuthnSupport() {
      if (!window.PublicKeyCredential) {
        return {
          supported: false,
          error: "WebAuthn not supported. Please use a modern browser (Chrome, Safari, Firefox, Edge)."
        };
      }

      if (!window.isSecureContext) {
        return {
          supported: false,
          error: "Secure context required. Please use HTTPS or localhost."
        };
      }

      return { supported: true };
    }

    function getWebAuthnErrorMessage(err) {
      if (err.name === "NotAllowedError") {
        // Check if we're in incognito mode (heuristic)
        const isLikelyIncognito = !navigator.storage || !navigator.storage.estimate;
        if (isLikelyIncognito) {
          return "Passkey registration cancelled. Note: Private/Incognito mode may not support biometric authentication. Please use a regular browser window.";
        }
        return "Passkey registration cancelled. Please try again and approve the biometric prompt.";
      }

      if (err.name === "InvalidStateError") {
        return "This passkey is already registered. Please use a different authenticator.";
      }

      if (err.name === "NotSupportedError") {
        return "Passkey not supported on this device. Please try a different browser or device.";
      }

      if (err.name === "AbortError") {
        return "Registration timed out. Please try again.";
      }

      // Generic error
      return err.message || "An error occurred during passkey registration.";
    }

    // --- Device ID Management (same as index.html) ---

    async function openDeviceDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('katulong', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('config')) {
            db.createObjectStore('config');
          }
        };
      });
    }

    async function getFromIndexedDB(key) {
      try {
        const db = await openDeviceDB();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('config', 'readonly');
          const store = tx.objectStore('config');
          const request = store.get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } catch {
        return null;
      }
    }

    async function saveToIndexedDB(key, value) {
      try {
        const db = await openDeviceDB();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('config', 'readwrite');
          const store = tx.objectStore('config');
          const request = store.put(value, key);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      } catch {
        // IndexedDB not available
      }
    }

    async function getOrCreateDeviceId() {
      let deviceId = localStorage.getItem('katulong_device_id');
      if (!deviceId) {
        deviceId = await getFromIndexedDB('deviceId');
        if (deviceId) {
          localStorage.setItem('katulong_device_id', deviceId);
        }
      }
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        localStorage.setItem('katulong_device_id', deviceId);
        await saveToIndexedDB('deviceId', deviceId);
      }
      return deviceId;
    }

    function generateDeviceName() {
      const ua = navigator.userAgent;
      if (/iPhone/i.test(ua)) {
        const match = ua.match(/iPhone OS (\d+)/);
        return match ? `iPhone (iOS ${match[1]})` : 'iPhone';
      }
      if (/iPad/i.test(ua)) return 'iPad';
      if (/Android/i.test(ua)) {
        const match = ua.match(/Android (\d+)/);
        return match ? `Android ${match[1]}` : 'Android';
      }
      if (/Mac OS X/i.test(ua)) {
        if (/Chrome/i.test(ua)) return 'Chrome on Mac';
        if (/Firefox/i.test(ua)) return 'Firefox on Mac';
        if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari on Mac';
        return 'Mac';
      }
      if (/Windows/i.test(ua)) {
        if (/Chrome/i.test(ua)) return 'Chrome on Windows';
        if (/Firefox/i.test(ua)) return 'Firefox on Windows';
        if (/Edge/i.test(ua)) return 'Edge on Windows';
        return 'Windows';
      }
      if (/Linux/i.test(ua)) {
        if (/Chrome/i.test(ua)) return 'Chrome on Linux';
        if (/Firefox/i.test(ua)) return 'Firefox on Linux';
        return 'Linux';
      }
      return 'Unknown Device';
    }

    async function checkStatus() {
      const res = await fetch("/auth/status");
      const { setup } = await res.json();
      loadingView.classList.add("hidden");
      if (setup) {
        if (hasWebAuthn && !isMobile) {
          // Desktop with HTTPS — passkey login
          loginView.classList.remove("hidden");

          // Check if user has passkeys for this domain
          await checkForExistingPasskeys();
        } else {
          // Mobile or HTTP — show QR pairing instructions
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

            // Show helpful message
            loginError.innerHTML = 'ℹ️ No passkey registered yet. Please register your fingerprint/Touch ID below.';
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

      if (!token) { setupError.textContent = "Setup token is required."; return; }

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
