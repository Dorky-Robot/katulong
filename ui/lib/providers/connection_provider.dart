import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/websocket_service.dart';

/// Provides the singleton WebSocketService instance.
final webSocketServiceProvider = Provider<WebSocketService>((ref) {
  final service = WebSocketService();
  ref.onDispose(() => service.dispose());
  return service;
});

/// Exposes the current connection state as a stream.
final connectionStateProvider = StreamProvider<ConnectionState>((ref) {
  final service = ref.watch(webSocketServiceProvider);
  return service.stateChanges;
});
