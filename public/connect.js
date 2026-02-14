(function() {
  var trustUrl = document.body.dataset.trustUrl || '';
  var httpsPort = document.body.dataset.httpsPort || '3002';

  var steps = [
    document.getElementById('step-1'),
    document.getElementById('step-2'),
    document.getElementById('step-3'),
  ];
  var dots = [
    document.getElementById('dot-1'),
    document.getElementById('dot-2'),
    document.getElementById('dot-3'),
  ];
  var currentStep = 0;

  function goToStep(n) {
    steps[currentStep].classList.remove('active');
    steps[n].classList.add('active');
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.remove('active', 'done');
      if (i < n) dots[i].classList.add('done');
      else if (i === n) dots[i].classList.add('active');
    }
    currentStep = n;

    if (n === 1) startPairing();
    if (n !== 1) stopPairing();
  }

  // --- Step 1: Trust QR ---
  if (trustUrl) {
    QRCode.toCanvas(trustUrl, {
      width: 200, margin: 2,
      color: { dark: '#cdd6f4', light: '#1e1e2e' },
    }, function(err, canvas) {
      if (!err) document.getElementById('trust-qr').appendChild(canvas);
    });
  }

  document.getElementById('next-to-step2').addEventListener('click', function() {
    goToStep(1);
  });

  document.getElementById('back-to-step1').addEventListener('click', function() {
    goToStep(0);
  });

  // --- Step 2: Pairing with auto-refresh ---
  var pairRefreshTimer = 0;
  var pairCountdownTimer = 0;
  var activePairCode = null;
  var ws = null;

  function stopPairing() {
    clearTimeout(pairRefreshTimer);
    clearInterval(pairCountdownTimer);
    activePairCode = null;
  }

  async function startPairing() {
    stopPairing();
    await refreshPairCode();
  }

  async function refreshPairCode() {
    var errorEl = document.getElementById('pair-error');
    errorEl.textContent = '';

    try {
      var res = await fetch('/auth/pair/start', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start pairing');
      var data = await res.json();

      activePairCode = data.code;

      // Render QR
      var qrContainer = document.getElementById('pair-qr');
      qrContainer.innerHTML = '';
      if (data.url) {
        QRCode.toCanvas(data.url, {
          width: 200, margin: 2,
          color: { dark: '#cdd6f4', light: '#1e1e2e' },
        }, function(err, canvas) {
          if (!err) qrContainer.appendChild(canvas);
        });
      }

      // Show PIN
      document.getElementById('pair-pin').textContent = data.pin;

      // Countdown
      clearInterval(pairCountdownTimer);
      function updateCountdown() {
        var left = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000));
        document.getElementById('pair-countdown').textContent =
          left > 0 ? 'Refreshing in ' + left + 's' : 'Refreshing...';
      }
      updateCountdown();
      pairCountdownTimer = setInterval(updateCountdown, 1000);

      // Schedule refresh ~25s (5s before expiry)
      var refreshIn = Math.max(1000, (data.expiresAt - Date.now()) - 5000);
      pairRefreshTimer = setTimeout(function() {
        if (currentStep === 1) refreshPairCode();
      }, refreshIn);

    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  // --- WebSocket for pair-complete ---
  function connectWS() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'pair-complete' && activePairCode && msg.code === activePairCode) {
          goToStep(2);
        } else if (msg.type === 'reload') {
          location.reload();
        }
      } catch {}
    };

    ws.onclose = function() {
      setTimeout(connectWS, 3000);
    };
    ws.onerror = function() { ws.close(); };
  }
  connectWS();

  // --- Step 3: Done ---
  document.getElementById('done-btn').addEventListener('click', function() {
    window.location.href = '/';
  });
})();
