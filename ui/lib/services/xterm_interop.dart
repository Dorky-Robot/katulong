import 'dart:js_interop';
import 'dart:js_interop_unsafe';

/// Dart interop for window.xtermBridge (defined in web/js/xterm_bridge.js).
class XtermInterop {
  XtermInterop._();

  static JSObject? get _bridge =>
      globalContext.getProperty('xtermBridge'.toJS) as JSObject?;

  static void init(String containerId) {
    _bridge?.callMethod('init'.toJS, containerId.toJS);
  }

  static void write(String data) {
    _bridge?.callMethod('write'.toJS, data.toJS);
  }

  static void resize(int cols, int rows) {
    _bridge?.callMethod('resize'.toJS, cols.toJS, rows.toJS);
  }

  static void fit() {
    _bridge?.callMethod('fit'.toJS);
  }

  static void focus() {
    _bridge?.callMethod('focus'.toJS);
  }

  static void dispose() {
    _bridge?.callMethod('dispose'.toJS);
  }

  static ({int cols, int rows}) getSize() {
    final result = _bridge?.callMethod('getSize'.toJS);
    if (result == null) return (cols: 80, rows: 24);
    final obj = result as JSObject;
    return (
      cols: (obj.getProperty('cols'.toJS) as JSNumber).toDartInt,
      rows: (obj.getProperty('rows'.toJS) as JSNumber).toDartInt,
    );
  }

  static void search(String query) {
    _bridge?.callMethod('search'.toJS, query.toJS);
  }

  static void searchPrevious(String query) {
    _bridge?.callMethod('searchPrevious'.toJS, query.toJS);
  }

  static void clearSearch() {
    _bridge?.callMethod('clearSearch'.toJS);
  }

  static void onData(void Function(String) callback) {
    _bridge?.callMethod(
      'onData'.toJS,
      ((JSString data) {
        callback(data.toDart);
      }).toJS,
    );
  }

  static void onResize(void Function(int cols, int rows) callback) {
    _bridge?.callMethod(
      'onResize'.toJS,
      ((JSObject event) {
        final cols = (event.getProperty('cols'.toJS) as JSNumber).toDartInt;
        final rows = (event.getProperty('rows'.toJS) as JSNumber).toDartInt;
        callback(cols, rows);
      }).toJS,
    );
  }

  static void setTheme(Map<String, String> theme) {
    final obj = JSObject();
    for (final entry in theme.entries) {
      obj.setProperty(entry.key.toJS, entry.value.toJS);
    }
    _bridge?.callMethod('setTheme'.toJS, obj);
  }

  static void scrollToBottom() {
    _bridge?.callMethod('scrollToBottom'.toJS);
  }

  static bool isAtBottom() {
    final result = _bridge?.callMethod('isAtBottom'.toJS);
    if (result == null) return true;
    return (result as JSBoolean).toDart;
  }
}
