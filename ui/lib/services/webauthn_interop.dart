import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

/// Dart interop for window.webauthnBridge (defined in web/js/webauthn_bridge.js).
class WebAuthnInterop {
  WebAuthnInterop._();

  static JSObject? get _bridge =>
      globalContext.getProperty('webauthnBridge'.toJS) as JSObject?;

  /// Start WebAuthn registration ceremony.
  static Future<Map<String, dynamic>> startRegistration(
    Map<String, dynamic> optionsJSON,
  ) async {
    final bridge = _bridge;
    if (bridge == null) {
      throw Exception('webauthnBridge not loaded');
    }

    final jsOptions = _dartMapToJSObject(optionsJSON);
    final promise = bridge.callMethod('startRegistration'.toJS, jsOptions) as JSPromise;
    final result = await promise.toDart;
    return _jsObjectToDartMap(result as JSObject);
  }

  /// Start WebAuthn authentication ceremony.
  static Future<Map<String, dynamic>> startAuthentication(
    Map<String, dynamic> optionsJSON,
  ) async {
    final bridge = _bridge;
    if (bridge == null) {
      throw Exception('webauthnBridge not loaded');
    }

    final jsOptions = _dartMapToJSObject(optionsJSON);
    final promise = bridge.callMethod('startAuthentication'.toJS, jsOptions) as JSPromise;
    final result = await promise.toDart;
    return _jsObjectToDartMap(result as JSObject);
  }

  /// Check if WebAuthn is supported.
  static bool isSupported() {
    final bridge = _bridge;
    if (bridge == null) return false;
    final result = bridge.callMethod('isSupported'.toJS);
    return (result as JSBoolean).toDart;
  }

  static final JSObject _json = globalContext.getProperty('JSON'.toJS) as JSObject;

  /// Convert Dart Map to JS object (deep) via JSON round-trip.
  static JSObject _dartMapToJSObject(Map<String, dynamic> map) {
    final jsonStr = jsonEncode(map);
    return _json.callMethod('parse'.toJS, jsonStr.toJS) as JSObject;
  }

  /// Convert JS object to Dart Map (deep) via JSON round-trip.
  static Map<String, dynamic> _jsObjectToDartMap(JSObject obj) {
    final jsonStr = (_json.callMethod('stringify'.toJS, obj) as JSString).toDart;
    return jsonDecode(jsonStr) as Map<String, dynamic>;
  }
}
