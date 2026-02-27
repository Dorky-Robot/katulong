import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_client.dart';

class ShortcutItem {
  final String label;
  final String keys;

  const ShortcutItem({required this.label, required this.keys});

  factory ShortcutItem.fromJson(Map<String, dynamic> json) {
    return ShortcutItem(
      label: json['label'] as String,
      keys: json['keys'] as String,
    );
  }

  Map<String, dynamic> toJson() => {'label': label, 'keys': keys};
}

class ShortcutsStore extends StateNotifier<AsyncValue<List<ShortcutItem>>> {
  ShortcutsStore() : super(const AsyncValue.loading()) {
    load();
  }

  Future<void> load() async {
    state = const AsyncValue.loading();
    try {
      final res = await ApiClient.get('/shortcuts');
      if (!res.ok) throw Exception('Failed to load shortcuts');
      final data = res.json;
      final shortcuts = (data['shortcuts'] as List)
          .map((s) => ShortcutItem.fromJson(s as Map<String, dynamic>))
          .toList();
      state = AsyncValue.data(shortcuts);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> save(List<ShortcutItem> shortcuts) async {
    final res = await ApiClient.put('/shortcuts', {
      'shortcuts': shortcuts.map((s) => s.toJson()).toList(),
    });
    if (!res.ok) throw Exception('Failed to save shortcuts');
    state = AsyncValue.data(shortcuts);
  }

  Future<void> add(ShortcutItem item) async {
    final current = state.valueOrNull ?? [];
    await save([...current, item]);
  }

  Future<void> remove(int index) async {
    final current = state.valueOrNull ?? [];
    final updated = [...current]..removeAt(index);
    await save(updated);
  }
}

final shortcutsStoreProvider =
    StateNotifierProvider<ShortcutsStore, AsyncValue<List<ShortcutItem>>>(
  (ref) => ShortcutsStore(),
);
