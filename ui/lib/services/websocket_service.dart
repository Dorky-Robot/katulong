import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'package:web/web.dart' as web;

enum ConnectionState { disconnected, connecting, connected, reconnecting }

/// WebSocket connection manager matching the existing protocol.
///
/// Message types:
///   Send: attach, input, resize
///   Receive: attached, output, exit, error, session-removed, session-renamed,
///            server-draining, reload, credential-registered, credential-removed,
///            p2p-signal, p2p-ready, p2p-closed
class WebSocketService {
  web.WebSocket? _ws;
  ConnectionState _state = ConnectionState.disconnected;
  int _reconnectDelay = 1000;
  Timer? _reconnectTimer;
  bool _isConnecting = false;

  // Track current session params for reconnect with latest values
  String? _currentSession;
  int _currentCols = 80;
  int _currentRows = 24;

  final _messageController = StreamController<Map<String, dynamic>>.broadcast();
  final _stateController = StreamController<ConnectionState>.broadcast();

  /// Stream of parsed JSON messages from the server.
  Stream<Map<String, dynamic>> get messages => _messageController.stream;

  /// Stream of connection state changes.
  Stream<ConnectionState> get stateChanges => _stateController.stream;

  ConnectionState get state => _state;

  void _setState(ConnectionState s) {
    _state = s;
    _stateController.add(s);
  }

  /// Connect to the WebSocket server and attach to the given session.
  void connect({required String session, required int cols, required int rows}) {
    if (_isConnecting) return;

    // Track current params so reconnect uses latest values
    _currentSession = session;
    _currentCols = cols;
    _currentRows = rows;

    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _isConnecting = true;
    _setState(ConnectionState.connecting);

    final proto = web.window.location.protocol == 'https:' ? 'wss:' : 'ws:';
    final host = web.window.location.host;
    _ws = web.WebSocket('$proto//$host');

    _ws!.onopen = ((web.Event e) {
      _isConnecting = false;
      _reconnectDelay = 1000;
      _setState(ConnectionState.connected);
      send({'type': 'attach', 'session': session, 'cols': cols, 'rows': rows});
      send({'type': 'resize', 'cols': cols, 'rows': rows});
    }).toJS;

    _ws!.onmessage = ((web.MessageEvent e) {
      final data = jsonDecode((e.data as JSString).toDart) as Map<String, dynamic>;

      if (data['type'] == 'server-draining') {
        _reconnectDelay = 500;
        _ws?.close();
        return;
      }

      if (data['type'] == 'reload') {
        web.window.location.reload();
        return;
      }

      _messageController.add(data);
    }).toJS;

    final thisWs = _ws!;
    _ws!.onclose = ((web.CloseEvent e) {
      // Ignore onclose from stale sockets (e.g. after forceReconnect)
      if (_ws != thisWs) return;

      _isConnecting = false;
      _setState(ConnectionState.reconnecting);

      // Credential revocation
      if (e.code == 1008) {
        web.window.location.href = '/login?reason=revoked';
        return;
      }

      _reconnectTimer = Timer(Duration(milliseconds: _reconnectDelay), () {
        connect(session: _currentSession!, cols: _currentCols, rows: _currentRows);
      });
      _reconnectDelay = (_reconnectDelay * 2).clamp(1000, 10000);
    }).toJS;

    _ws!.onerror = ((web.Event e) {
      _isConnecting = false;
      _ws?.close();
    }).toJS;
  }

  /// Send a JSON message to the server.
  void send(Map<String, dynamic> message) {
    if (_ws != null && _ws!.readyState == 1 /* OPEN */) {
      _ws!.send(jsonEncode(message).toJS);
    }
  }

  /// Send terminal input.
  void sendInput(String data) {
    send({'type': 'input', 'data': data});
  }

  /// Send terminal resize.
  void sendResize(int cols, int rows) {
    _currentCols = cols;
    _currentRows = rows;
    send({'type': 'resize', 'cols': cols, 'rows': rows});
  }

  /// Disconnect and stop reconnecting.
  void disconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _ws?.close();
    _ws = null;
    _setState(ConnectionState.disconnected);
  }

  /// Force reconnect (e.g. after visibility change).
  void forceReconnect({required String session, required int cols, required int rows}) {
    final oldWs = _ws;
    _ws = null; // Detach so stale onclose is ignored
    _isConnecting = false; // Allow connect() to proceed
    oldWs?.close();
    _reconnectDelay = 500;
    connect(session: session, cols: cols, rows: rows);
  }

  void dispose() {
    disconnect();
    _messageController.close();
    _stateController.close();
  }
}
