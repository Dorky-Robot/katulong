    import { getOrCreateDeviceId, generateDeviceName } from "/lib/device.js";

    const code = new URLSearchParams(location.search).get("code");
    const pinInput = document.getElementById("pin-input");
    const pairBtn = document.getElementById("pair-btn");
    const pairError = document.getElementById("pair-error");
    const debugLog = document.getElementById("debug-log");

    // Debug logging
    function logDebug(msg, isError = false) {
      const div = document.createElement("div");
      div.className = isError ? "log-error" : "log-info";
      div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      debugLog.appendChild(div);
      debugLog.scrollTop = debugLog.scrollHeight;
      console.log(msg);
    }

    logDebug(`Page loaded. Code: ${code ? code.substring(0, 8) + "..." : "MISSING"}`);

    if (!code) {
      pairError.textContent = "Missing pairing code. Scan the QR code again.";
      pairBtn.disabled = true;
      logDebug("ERROR: Missing pairing code in URL", true);
    }

    // --- Device ID Management ---
    // Device management functions imported from /lib/device.js

    async function submitPair() {
      // Strip non-digits (some phones insert formatting in tel/numeric inputs)
      const pin = pinInput.value.replace(/\D/g, "");
      pairError.textContent = "";

      logDebug(`Submit - PIN length: ${pin.length}`);

      if (!pin || pin.length !== 8) {
        pairError.textContent = "Enter the 8-digit PIN.";
        logDebug("ERROR: PIN must be 8 digits", true);
        return;
      }

      pairBtn.disabled = true;
      pairError.textContent = "Verifying...";
      logDebug("Getting device metadata...");

      try {
        // Get device metadata
        const deviceId = await getOrCreateDeviceId();
        const deviceName = generateDeviceName();
        const userAgent = navigator.userAgent;

        logDebug(`Device: ${deviceName} (${deviceId.substring(0, 8)}...)`);
        logDebug("Sending request to /auth/pair/verify...");

        const res = await fetch("/auth/pair/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            pin,
            deviceId,
            deviceName,
            userAgent
          }),
        });

        logDebug(`Response: ${res.status} ${res.statusText}`);

        if (!res.ok) {
          let errorMsg = "Pairing failed";
          try {
            const err = await res.json();
            errorMsg = err.error || errorMsg;
            logDebug(`ERROR: ${errorMsg}`, true);
          } catch {
            errorMsg = `Server error (${res.status} ${res.statusText})`;
            logDebug(`ERROR: ${errorMsg}`, true);
          }
          throw new Error(errorMsg);
        }

        logDebug("Success! Redirecting to /");
        window.location.href = "/";
      } catch (err) {
        logDebug(`ERROR: ${err.message}`, true);
        pairError.textContent = err.message || "Network error - check connection";
      } finally {
        pairBtn.disabled = false;
      }
    }

    pairBtn.addEventListener("click", submitPair);
    pinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitPair();
    });
