import 'dart:async';
import 'dart:js_interop';
import 'package:web/web.dart' as web;

/// Monitors online/offline network status and triggers reconnection.
class NetworkMonitor {
  final _controller = StreamController<bool>.broadcast();
  bool _online = true;

  Stream<bool> get onlineState => _controller.stream;
  bool get isOnline => _online;

  void init({VoidCallback? onReconnect}) {
    _online = web.window.navigator.onLine;

    web.window.addEventListener('online', ((web.Event e) {
      _online = true;
      _controller.add(true);
      onReconnect?.call();
    }).toJS);

    web.window.addEventListener('offline', ((web.Event e) {
      _online = false;
      _controller.add(false);
    }).toJS);
  }

  void dispose() {
    _controller.close();
  }
}

typedef VoidCallback = void Function();
