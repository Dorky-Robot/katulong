import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';

enum ThemePreference { auto, light, dark }

class ThemeState {
  final ThemePreference preference;
  final String toolbarColorId;

  const ThemeState({
    this.preference = ThemePreference.auto,
    this.toolbarColorId = 'default',
  });

  ThemeState copyWith({
    ThemePreference? preference,
    String? toolbarColorId,
  }) {
    return ThemeState(
      preference: preference ?? this.preference,
      toolbarColorId: toolbarColorId ?? this.toolbarColorId,
    );
  }

  /// Resolve auto to the actual theme based on platform brightness.
  Brightness get effectiveBrightness {
    switch (preference) {
      case ThemePreference.light:
        return Brightness.light;
      case ThemePreference.dark:
        return Brightness.dark;
      case ThemePreference.auto:
        return SchedulerBinding.instance.platformDispatcher.platformBrightness;
    }
  }

  bool get isDark => effectiveBrightness == Brightness.dark;

  ThemeData get themeData =>
      isDark ? AppTheme.dark() : AppTheme.light();

  Map<String, String> get xtermTheme =>
      isDark ? AppTheme.xtermDarkTheme : AppTheme.xtermLightTheme;
}

class ThemeNotifier extends StateNotifier<ThemeState> {
  ThemeNotifier() : super(const ThemeState()) {
    _load();
  }

  static const _prefKey = 'theme';
  static const _toolbarKey = 'toolbarColor';

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final themeStr = prefs.getString(_prefKey) ?? 'auto';
    final toolbarColor = prefs.getString(_toolbarKey) ?? 'default';

    state = ThemeState(
      preference: _parsePreference(themeStr),
      toolbarColorId: toolbarColor,
    );
  }

  Future<void> setPreference(ThemePreference pref) async {
    state = state.copyWith(preference: pref);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefKey, pref.name);
  }

  Future<void> setToolbarColor(String colorId) async {
    state = state.copyWith(toolbarColorId: colorId);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_toolbarKey, colorId);
  }

  static ThemePreference _parsePreference(String value) {
    switch (value) {
      case 'light':
        return ThemePreference.light;
      case 'dark':
        return ThemePreference.dark;
      default:
        return ThemePreference.auto;
    }
  }
}

final themeProvider = StateNotifierProvider<ThemeNotifier, ThemeState>(
  (ref) => ThemeNotifier(),
);
