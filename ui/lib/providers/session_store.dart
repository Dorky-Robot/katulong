import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_client.dart';

class SessionInfo {
  final String name;
  final bool active;

  const SessionInfo({required this.name, this.active = false});

  factory SessionInfo.fromJson(Map<String, dynamic> json) {
    return SessionInfo(
      name: json['name'] as String,
      active: json['active'] as bool? ?? false,
    );
  }
}

class SessionStore extends StateNotifier<AsyncValue<List<SessionInfo>>> {
  SessionStore() : super(const AsyncValue.loading()) {
    load();
  }

  Future<void> load() async {
    state = const AsyncValue.loading();
    try {
      final res = await ApiClient.get('/sessions');
      if (!res.ok) throw Exception('Failed to load sessions');
      final data = res.json;
      final sessions = (data['sessions'] as List)
          .map((s) => SessionInfo.fromJson(s as Map<String, dynamic>))
          .toList();
      state = AsyncValue.data(sessions);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> create(String name) async {
    final res = await ApiClient.post('/sessions', {'name': name});
    if (!res.ok) throw Exception(res.json['error'] ?? 'Failed to create session');
    await load();
  }

  Future<void> rename(String oldName, String newName) async {
    final res = await ApiClient.put('/sessions/$oldName', {'name': newName});
    if (!res.ok) throw Exception(res.json['error'] ?? 'Failed to rename session');
    await load();
  }

  Future<void> delete(String name) async {
    final res = await ApiClient.delete('/sessions/$name');
    if (!res.ok) throw Exception(res.json['error'] ?? 'Failed to delete session');
    await load();
  }
}

final sessionStoreProvider =
    StateNotifierProvider<SessionStore, AsyncValue<List<SessionInfo>>>(
  (ref) => SessionStore(),
);
