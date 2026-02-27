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
      final data = res.json;
      state = AsyncValue.data(AppConfig(
        instanceName: data['instanceName'] as String? ?? 'katulong',
        instanceIcon: data['instanceIcon'] as String? ?? 'terminal-window',
        toolbarColor: data['toolbarColor'] as String? ?? 'default',
      ));
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> setInstanceName(String name) async {
    await ApiClient.put('/api/config/instance-name', {'instanceName': name});
    state = AsyncValue.data(
      (state.valueOrNull ?? const AppConfig()).copyWith(instanceName: name),
    );
  }

  Future<void> setInstanceIcon(String icon) async {
    await ApiClient.put('/api/config/instance-icon', {'instanceIcon': icon});
    state = AsyncValue.data(
      (state.valueOrNull ?? const AppConfig()).copyWith(instanceIcon: icon),
    );
  }

  Future<void> setToolbarColor(String color) async {
    await ApiClient.put('/api/config/toolbar-color', {'toolbarColor': color});
    state = AsyncValue.data(
      (state.valueOrNull ?? const AppConfig()).copyWith(toolbarColor: color),
    );
  }
}

final configProvider =
    StateNotifierProvider<ConfigNotifier, AsyncValue<AppConfig>>(
  (ref) => ConfigNotifier(),
);
