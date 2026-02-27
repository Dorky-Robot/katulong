import 'dart:async';
import 'dart:js_interop';
import 'package:web/web.dart' as web;
import 'csrf_service.dart';

/// Uploads an image file to the /upload endpoint.
class ImageUpload {
  ImageUpload._();

  static Future<void> upload(
    web.File file, {
    required void Function(String) onTerminalWrite,
  }) async {
    final completer = Completer<void>();

    final xhr = web.XMLHttpRequest();
    xhr.open('POST', '/upload', true);
    xhr.withCredentials = true;

    final csrfToken = CsrfService.token;
    if (csrfToken != null) {
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    }
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('X-Filename', file.name);

    xhr.onload = ((web.Event e) {
      if (xhr.status == 200) {
        try {
          // Response contains the terminal command to display the image
          final response = xhr.responseText;
          onTerminalWrite(response);
        } catch (_) {}
      }
      completer.complete();
    }).toJS;

    xhr.onerror = ((web.Event e) {
      completer.complete();
    }).toJS;

    xhr.send(file as JSAny);

    return completer.future;
  }
}
