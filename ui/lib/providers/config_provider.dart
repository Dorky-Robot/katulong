import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_client.dart';

class AppConfig {
  final String instanceName;
  final String instanceIcon;
  final String toolbarColor;

  const AppConfig({
    this.instanceName = 'katulong',
    this.instanceIcon = 'terminal-window',
    this.toolbarColor = 'default',
  });

  AppConfig copyWith({
    String? instanceName,
    String? instanceIcon,
    String? toolbarColor,
  }) {
    return AppConfig(
      instanceName: instanceName ?? this.instanceName,
      instanceIcon: instanceIcon ?? this.instanceIcon,
      toolbarColor: toolbarColor ?? this.toolbarColor,
    );
  }
}

class ConfigNotifier extends StateNotifier<AsyncValue<AppConfig>> {
  ConfigNotifier() : super(const AsyncValue.loading()) {
    load();
  }

  Future<void> load() async {
    try {
      final res = await ApiClient.get('/api/config');
      if (!res.ok) {
        state = const AsyncValue.data(AppConfig());
        return;
      }
      final data = res.json as Map<String, dynamic>;
      final config = data['config'] as Map<String, dynamic>? ?? {};
      state = AsyncValue.data(AppConfig(
        instanceName: config['instanceName'] as String? ?? 'katulong',
        instanceIcon: config['instanceIcon'] as String? ?? 'terminal-window',
        toolbarColor: config['toolbarColor'] as String? ?? 'default',
      ));
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> setInstanceName(String name) async {
    final res = await ApiClient.put('/api/config/instance-name', {'instanceName': name});
    if (!res.ok) throw Exception('Failed to update instance name');
    state = AsyncValue.data(
      (state.valueOrNull ?? const AppConfig()).copyWith(instanceName: name),
    );
  }

  Future<void> setInstanceIcon(String icon) async {
    final res = await ApiClient.put('/api/config/instance-icon', {'instanceIcon': icon});
    if (!res.ok) throw Exception('Failed to update instance icon');
    state = AsyncValue.data(
      (state.valueOrNull ?? const AppConfig()).copyWith(instanceIcon: icon),
    );
  }

  Future<void> setToolbarColor(String color) async {
    final res = await ApiClient.put('/api/config/toolbar-color', {'toolbarColor': color});
    if (!res.ok) throw Exception('Failed to update toolbar color');
    state = AsyncValue.data(
      (state.valueOrNull ?? const AppConfig()).copyWith(toolbarColor: color),
    );
  }
}

final configProvider =
    StateNotifierProvider<ConfigNotifier, AsyncValue<AppConfig>>(
  (ref) => ConfigNotifier(),
);
