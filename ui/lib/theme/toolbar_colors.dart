import 'package:flutter/material.dart';

class ToolbarColorConfig {
  final String id;
  final String name;
  final Color color;

  const ToolbarColorConfig({
    required this.id,
    required this.name,
    required this.color,
  });
}

/// 9 Catppuccin-inspired toolbar color variants (matching settings-handlers.js)
const toolbarColors = [
  ToolbarColorConfig(id: 'default', name: 'Default', color: Color(0xFF313244)),
  ToolbarColorConfig(id: 'blue', name: 'Blue', color: Color(0xFF89B4FA)),
  ToolbarColorConfig(id: 'purple', name: 'Purple', color: Color(0xFFCBA6F7)),
  ToolbarColorConfig(id: 'green', name: 'Green', color: Color(0xFFA6E3A1)),
  ToolbarColorConfig(id: 'red', name: 'Red', color: Color(0xFFF38BA8)),
  ToolbarColorConfig(id: 'orange', name: 'Orange', color: Color(0xFFFAB387)),
  ToolbarColorConfig(id: 'pink', name: 'Pink', color: Color(0xFFF5C2E7)),
  ToolbarColorConfig(id: 'teal', name: 'Teal', color: Color(0xFF94E2D5)),
  ToolbarColorConfig(id: 'yellow', name: 'Yellow', color: Color(0xFFF9E2AF)),
];

/// Look up a toolbar color by id. Falls back to 'default'.
ToolbarColorConfig getToolbarColor(String id) {
  return toolbarColors.firstWhere(
    (c) => c.id == id,
    orElse: () => toolbarColors.first,
  );
}
