import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

/// Dart interop for window.p2pBridge (defined in web/js/p2p_bridge.js).
class P2PService {
  bool _connected = false;
  final _stateController = StreamController<bool>.broadcast();

  Stream<bool> get connectionState => _stateController.stream;
  bool get isConnected => _connected;

  static JSObject? get _bridge =>
      globalContext.getProperty('p2pBridge'.toJS) as JSObject?;

  void create({bool initiator = false}) {
    final bridge = _bridge;
    if (bridge == null) return;

    bridge.callMethod('create'.toJS, initiator.toJS);

    bridge.callMethod('onConnect'.toJS, (() {
      _connected = true;
      _stateController.add(true);
    }).toJS);

    bridge.callMethod('onClose'.toJS, (() {
      _connected = false;
      _stateController.add(false);
    }).toJS);

    bridge.callMethod('onError'.toJS, ((JSString msg) {
      _connected = false;
      _stateController.add(false);
    }).toJS);
  }

  void signal(String dataJSON) {
    _bridge?.callMethod('signal'.toJS, dataJSON.toJS);
  }

  void send(String data) {
    _bridge?.callMethod('send'.toJS, data.toJS);
  }

  void destroy() {
    _bridge?.callMethod('destroy'.toJS);
    _connected = false;
    _stateController.add(false);
  }

  void dispose() {
    destroy();
    _stateController.close();
  }
}
