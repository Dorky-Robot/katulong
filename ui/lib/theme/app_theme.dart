import 'package:flutter/material.dart';
import 'catppuccin.dart';
import 'design_tokens.dart';

const _fontFamily =
    "'JetBrains Mono', 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace";

class AppTheme {
  AppTheme._();

  static ThemeData dark() {
    return ThemeData.dark(useMaterial3: true).copyWith(
      scaffoldBackgroundColor: CatppuccinMocha.base,
      colorScheme: ColorScheme.dark(
        surface: CatppuccinMocha.base,
        onSurface: CatppuccinMocha.text,
        primary: CatppuccinMocha.mauve,
        onPrimary: CatppuccinMocha.crust,
        secondary: CatppuccinMocha.blue,
        error: CatppuccinMocha.red,
        outline: CatppuccinMocha.surface1,
        surfaceContainerHighest: CatppuccinMocha.surface0,
      ),
      textTheme: ThemeData.dark().textTheme.apply(
        fontFamily: _fontFamily,
        bodyColor: CatppuccinMocha.text,
        displayColor: CatppuccinMocha.text,
      ),
      cardTheme: CardThemeData(
        color: CatppuccinMocha.surface0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DesignTokens.radiusLg),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: CatppuccinMocha.base,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(DesignTokens.radiusMd),
          borderSide: BorderSide(color: CatppuccinMocha.surface1),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: CatppuccinMocha.surface0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DesignTokens.radiusLg),
        ),
      ),
      dividerColor: CatppuccinMocha.surface1,
    );
  }

  static ThemeData light() {
    return ThemeData.light(useMaterial3: true).copyWith(
      scaffoldBackgroundColor: CatppuccinLatte.base,
      colorScheme: ColorScheme.light(
        surface: CatppuccinLatte.base,
        onSurface: CatppuccinLatte.text,
        primary: CatppuccinLatte.mauve,
        onPrimary: CatppuccinLatte.base,
        secondary: CatppuccinLatte.blue,
        error: CatppuccinLatte.red,
        outline: CatppuccinLatte.surface0,
        surfaceContainerHighest: CatppuccinLatte.mantle,
      ),
      textTheme: ThemeData.light().textTheme.apply(
        fontFamily: _fontFamily,
        bodyColor: CatppuccinLatte.text,
        displayColor: CatppuccinLatte.text,
      ),
      cardTheme: CardThemeData(
        color: Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DesignTokens.radiusLg),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: CatppuccinLatte.mantle,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(DesignTokens.radiusMd),
          borderSide: BorderSide(color: CatppuccinLatte.surface0),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DesignTokens.radiusLg),
        ),
      ),
      dividerColor: CatppuccinLatte.surface0,
    );
  }

  /// xterm.js theme object for Catppuccin Mocha (dark)
  static Map<String, String> get xtermDarkTheme => {
    'background': '#1e1e2e',
    'foreground': '#cdd6f4',
    'cursor': '#f5e0dc',
    'selectionBackground': 'rgba(137,180,250,0.3)',
    'black': '#45475a',
    'brightBlack': '#585b70',
    'red': '#f38ba8',
    'brightRed': '#f38ba8',
    'green': '#a6e3a1',
    'brightGreen': '#a6e3a1',
    'yellow': '#f9e2af',
    'brightYellow': '#f9e2af',
    'blue': '#89b4fa',
    'brightBlue': '#89b4fa',
    'magenta': '#f5c2e7',
    'brightMagenta': '#f5c2e7',
    'cyan': '#94e2d5',
    'brightCyan': '#94e2d5',
    'white': '#bac2de',
    'brightWhite': '#a6adc8',
  };

  /// xterm.js theme object for Catppuccin Latte (light)
  static Map<String, String> get xtermLightTheme => {
    'background': '#eff1f5',
    'foreground': '#4c4f69',
    'cursor': '#dc8a78',
    'selectionBackground': 'rgba(30,102,245,0.2)',
    'black': '#5c5f77',
    'brightBlack': '#6c6f85',
    'red': '#d20f39',
    'brightRed': '#d20f39',
    'green': '#40a02b',
    'brightGreen': '#40a02b',
    'yellow': '#df8e1d',
    'brightYellow': '#df8e1d',
    'blue': '#1e66f5',
    'brightBlue': '#1e66f5',
    'magenta': '#ea76cb',
    'brightMagenta': '#ea76cb',
    'cyan': '#179299',
    'brightCyan': '#179299',
    'white': '#acb0be',
    'brightWhite': '#bcc0cc',
  };
}
