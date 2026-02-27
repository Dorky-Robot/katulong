import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web/web.dart' as web;
import '../providers/connection_provider.dart';
import '../services/xterm_interop.dart';
import '../widgets/terminal/terminal_view.dart';
import '../widgets/terminal/shortcut_bar.dart';
import '../widgets/terminal/search_overlay.dart';
import '../widgets/terminal/scroll_to_bottom.dart';
import '../widgets/modals/settings_modal.dart';
import '../widgets/modals/shortcuts_popup.dart';
import '../widgets/modals/edit_shortcuts_modal.dart';
import '../widgets/modals/add_shortcut_modal.dart';
import '../widgets/modals/session_manager_modal.dart';

class TerminalScreen extends ConsumerStatefulWidget {
  const TerminalScreen({super.key});

  @override
  ConsumerState<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends ConsumerState<TerminalScreen> {
  bool _showSearch = false;
  late final String _sessionName;

  @override
  void initState() {
    super.initState();
    final uri = Uri.parse(web.window.location.href);
    _sessionName = uri.queryParameters['s'] ?? 'default';
  }

  void _toggleSearch() {
    setState(() => _showSearch = !_showSearch);
    if (!_showSearch) {
      XtermInterop.clearSearch();
      XtermInterop.focus();
    }
  }

  void _sendKeys(String keys) {
    final wsService = ref.read(webSocketServiceProvider);
    wsService.sendInput(keys);
    XtermInterop.focus();
  }

  void _showSessionManager() {
    showDialog(
      context: context,
      builder: (_) => SessionManagerModal(currentSession: _sessionName),
    );
  }

  void _showShortcuts() {
    showDialog(
      context: context,
      builder: (_) => ShortcutsPopup(
        onSendKeys: _sendKeys,
        onEdit: _showEditShortcuts,
      ),
    );
  }

  void _showEditShortcuts() {
    showDialog(
      context: context,
      builder: (_) => EditShortcutsModal(onAdd: _showAddShortcut),
    );
  }

  void _showAddShortcut() {
    showDialog(
      context: context,
      builder: (_) => const AddShortcutModal(),
    );
  }

  void _showSettings() {
    showDialog(
      context: context,
      builder: (_) => const SettingsModal(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: KeyboardListener(
        focusNode: FocusNode(),
        onKeyEvent: (event) {
          if (event is KeyDownEvent &&
              event.logicalKey == LogicalKeyboardKey.keyF &&
              HardwareKeyboard.instance.isControlPressed) {
            _toggleSearch();
          }
        },
        child: Stack(
          children: [
            Column(
              children: [
                ShortcutBar(
                  sessionName: _sessionName,
                  onSessionTap: _showSessionManager,
                  onShortcutsTap: _showShortcuts,
                  onSettingsTap: _showSettings,
                  onSendSequence: _sendKeys,
                ),
                Expanded(
                  child: TerminalView(sessionName: _sessionName),
                ),
              ],
            ),
            if (_showSearch)
              SearchOverlay(onClose: _toggleSearch),
            const ScrollToBottomButton(),
          ],
        ),
      ),
    );
  }
}
