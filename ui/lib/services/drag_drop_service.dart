import 'dart:js_interop';
import 'package:web/web.dart' as web;
import 'image_upload.dart';

/// Sets up drag-and-drop image upload on the document body.
class DragDropService {
  DragDropService._();

  static bool _initialized = false;

  static void init({required void Function(String) onTerminalWrite}) {
    if (_initialized) return;
    _initialized = true;

    final body = web.document.body!;

    body.addEventListener('dragover', ((web.DragEvent e) {
      e.preventDefault();
    }).toJS);

    body.addEventListener('drop', ((web.DragEvent e) {
      e.preventDefault();
      final files = e.dataTransfer?.files;
      if (files != null && files.length > 0) {
        final file = files.item(0);
        if (file != null && file.type.startsWith('image/')) {
          ImageUpload.upload(file, onTerminalWrite: onTerminalWrite);
        }
      }
    }).toJS);
  }
}
