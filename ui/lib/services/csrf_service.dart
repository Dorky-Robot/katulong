import 'dart:js_interop';
import 'package:flutter/foundation.dart';
import 'package:web/web.dart' as web;

/// Reads the CSRF token from <meta name="csrf-token"> injected by the server.
class CsrfService {
  CsrfService._();

  static String? _cachedToken;

  static String? get token {
    _cachedToken ??= _readFromMeta();
    return _cachedToken;
  }

  /// Force re-read (e.g. after login sets a new token).
  static void invalidate() {
    _cachedToken = null;
  }

  static String? _readFromMeta() {
    if (!kIsWeb) return null;
    final meta = web.document.querySelector('meta[name="csrf-token"]');
    return meta?.getAttribute('content');
  }
}
