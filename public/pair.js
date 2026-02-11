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

    // --- Device ID Management (same as login.html) ---

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
