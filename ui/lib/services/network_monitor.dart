import 'dart:async';
import 'dart:js_interop';
import 'package:web/web.dart' as web;

/// Monitors online/offline network status and triggers reconnection.
class NetworkMonitor {
  final _controller = StreamController<bool>.broadcast();
  bool _online = true;
  JSFunction? _onlineHandler;
  JSFunction? _offlineHandler;

  Stream<bool> get onlineState => _controller.stream;
  bool get isOnline => _online;

  void init({void Function()? onReconnect}) {
    _online = web.window.navigator.onLine;

    _onlineHandler = ((web.Event e) {
      _online = true;
      _controller.add(true);
      onReconnect?.call();
    }).toJS;

    _offlineHandler = ((web.Event e) {
      _online = false;
      _controller.add(false);
    }).toJS;

    web.window.addEventListener('online', _onlineHandler!);
    web.window.addEventListener('offline', _offlineHandler!);
  }

  void dispose() {
    if (_onlineHandler != null) {
      web.window.removeEventListener('online', _onlineHandler!);
      _onlineHandler = null;
    }
    if (_offlineHandler != null) {
      web.window.removeEventListener('offline', _offlineHandler!);
      _offlineHandler = null;
    }
    _controller.close();
  }
}
