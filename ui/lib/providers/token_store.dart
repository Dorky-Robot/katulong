import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_client.dart';

class SetupToken {
  final String id;
  final String token;
  final String? label;
  final bool used;
  final int createdAt;

  const SetupToken({
    required this.id,
    required this.token,
    this.label,
    this.used = false,
    required this.createdAt,
  });

  factory SetupToken.fromJson(Map<String, dynamic> json) {
    return SetupToken(
      id: json['id'] as String,
      token: json['token'] as String? ?? '',
      label: json['name'] as String?,
      used: json['credential'] != null,
      createdAt: json['createdAt'] as int? ?? 0,
    );
  }
}

class TokenStore extends StateNotifier<AsyncValue<List<SetupToken>>> {
  TokenStore() : super(const AsyncValue.loading()) {
    load();
  }

  String? _lastCreatedToken;
  String? get lastCreatedToken => _lastCreatedToken;

  Future<void> load() async {
    state = const AsyncValue.loading();
    try {
      final res = await ApiClient.get('/api/tokens');
      if (!res.ok) throw Exception('Failed to load tokens');
      final data = res.json;
      final tokens = (data['tokens'] as List)
          .map((t) => SetupToken.fromJson(t as Map<String, dynamic>))
          .toList();
      state = AsyncValue.data(tokens);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<String> create({String? label}) async {
    final res = await ApiClient.post('/api/tokens', {
      if (label != null) 'name': label,
    });
    if (!res.ok) throw Exception(res.json['error'] ?? 'Failed to create token');
    final token = res.json['token'] as String;
    _lastCreatedToken = token;
    await load();
    return token;
  }

  Future<void> delete(String id) async {
    final res = await ApiClient.delete('/api/tokens/$id');
    if (!res.ok) throw Exception(res.json['error'] ?? 'Failed to delete token');
    await load();
  }
}

final tokenStoreProvider =
    StateNotifierProvider<TokenStore, AsyncValue<List<SetupToken>>>(
  (ref) => TokenStore(),
);
