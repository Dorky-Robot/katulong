import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'package:web/web.dart' as web;
import 'csrf_service.dart';

/// HTTP client that sends CSRF tokens and uses withCredentials for cookies.
class ApiClient {
  ApiClient._();

  static Future<ApiResponse> get(String path) => _request('GET', path);

  static Future<ApiResponse> post(String path, [Object? body]) =>
      _request('POST', path, body);

  static Future<ApiResponse> put(String path, [Object? body]) =>
      _request('PUT', path, body);

  static Future<ApiResponse> patch(String path, [Object? body]) =>
      _request('PATCH', path, body);

  static Future<ApiResponse> delete(String path, [Object? body]) =>
      _request('DELETE', path, body);

  static Future<ApiResponse> _request(
    String method,
    String path, [
    Object? body,
  ]) {
    final completer = Completer<ApiResponse>();
    final xhr = web.XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');

    final csrfToken = CsrfService.token;
    if (csrfToken != null && method != 'GET') {
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    }

    xhr.onload = ((web.Event e) {
      completer.complete(ApiResponse(
        status: xhr.status,
        body: xhr.responseText,
      ));
    }).toJS;

    xhr.onerror = ((web.Event e) {
      completer.completeError(Exception('Network error: $method $path'));
    }).toJS;

    if (body != null) {
      xhr.send(jsonEncode(body).toJS);
    } else {
      xhr.send();
    }

    return completer.future;
  }
}

class ApiResponse {
  final int status;
  final String body;

  const ApiResponse({required this.status, required this.body});

  bool get ok => status >= 200 && status < 300;

  Map<String, dynamic> get json => jsonDecode(body) as Map<String, dynamic>;
}
