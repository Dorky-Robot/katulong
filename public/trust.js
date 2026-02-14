(function() {
  var httpsUrl = document.body.dataset.httpsUrl || '';
  var lanIP = document.body.dataset.lanIp || '';
  var httpsPort = document.body.dataset.httpsPort || '443';
  var ua = navigator.userAgent || '';

  // Android browsers don't resolve .local via mDNS — use LAN IP directly
  if (/Android/.test(ua) && lanIP && httpsUrl) {
    httpsUrl = 'https://' + lanIP + ':' + httpsPort;
  }
  // iOS: include port since phones can't do client-side port forwarding
  else if (/iPad|iPhone|iPod/.test(ua) && httpsPort !== '443' && httpsUrl) {
    try {
      var u = new URL(httpsUrl);
      u.port = httpsPort;
      httpsUrl = u.toString().replace(/\/$/, '');
    } catch(e) {}
  }

  // Platform detection — show matching install + uninstall sections
  if (/iPad|iPhone|iPod/.test(ua)) {
    document.getElementById('ios-section').classList.add('active');
    document.getElementById('ios-uninstall').classList.add('active');
  } else if (/Android/.test(ua)) {
    document.getElementById('android-section').classList.add('active');
    document.getElementById('android-uninstall').classList.add('active');
  } else {
    document.getElementById('desktop-section').classList.add('active');
    document.getElementById('desktop-uninstall').classList.add('active');
    if (!/Mac/.test(ua)) {
      document.getElementById('desktop-steps-mac').style.display = 'none';
      document.getElementById('desktop-steps-other').style.display = '';
      document.getElementById('desktop-uninstall-mac').style.display = 'none';
      document.getElementById('desktop-uninstall-other').style.display = '';
    }
  }

  // Toggle uninstall section
  document.getElementById('uninstall-toggle').addEventListener('click', function() {
    document.getElementById('uninstall-content').classList.toggle('visible');
  });

  // Check if cert is trusted by attempting HTTPS fetch
  // This will only succeed if the certificate is trusted by the browser
  if (httpsUrl) {
    function checkCert() {
      fetch(httpsUrl + '/auth/status', {
        mode: 'cors',
        credentials: 'include',
        cache: 'no-store'
      })
        .then(function(response) {
          if (response.ok) {
            document.getElementById('success-banner').classList.add('visible');
            document.getElementById('next-step').classList.add('visible');
          } else {
            setTimeout(checkCert, 3000);
          }
        })
        .catch(function() {
          // Certificate not trusted or network error - retry
          setTimeout(checkCert, 3000);
        });
    }
    checkCert();
  }
})();
