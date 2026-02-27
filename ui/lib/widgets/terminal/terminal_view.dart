import 'dart:async';
import 'dart:ui_web' as ui_web;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web/web.dart' as web;
import '../../providers/connection_provider.dart';
import '../../providers/theme_provider.dart';
import '../../services/xterm_interop.dart';
import '../../services/websocket_service.dart';

const _viewType = 'xterm-terminal';
bool _factoryRegistered = false;
const _containerId = 'xterm-container';

void ensurePlatformViewFactory() {
  if (_factoryRegistered) return;
  _factoryRegistered = true;

  ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId, {Object? params}) {
    final div = web.document.createElement('div') as web.HTMLDivElement;
    div.id = _containerId;
    div.style.width = '100%';
    div.style.height = '100%';
    return div;
  });
}

class TerminalView extends ConsumerStatefulWidget {
  final String sessionName;

  const TerminalView({super.key, required this.sessionName});

  @override
  ConsumerState<TerminalView> createState() => _TerminalViewState();
}

class _TerminalViewState extends ConsumerState<TerminalView> {
  StreamSubscription? _msgSub;
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    ensurePlatformViewFactory();
  }

  void _onPlatformViewCreated(int id) {
    // Delay to allow DOM to be ready
    Future.delayed(const Duration(milliseconds: 100), _initTerminal);
  }

  void _initTerminal() {
    if (_initialized) return;
    _initialized = true;

    // Initialize xterm.js in the container
    XtermInterop.init(_containerId);

    // Apply current theme
    final themeState = ref.read(themeProvider);
    XtermInterop.setTheme(themeState.xtermTheme);

    // Wire terminal input → WebSocket
    final wsService = ref.read(webSocketServiceProvider);
    XtermInterop.onData((data) {
      wsService.sendInput(data);
    });

    // Wire terminal resize → WebSocket
    XtermInterop.onResize((cols, rows) {
      wsService.sendResize(cols, rows);
    });

    // Wire WebSocket messages → terminal
    _msgSub = wsService.messages.listen((msg) {
      final type = msg['type'] as String?;
      switch (type) {
        case 'output':
          XtermInterop.write(msg['data'] as String? ?? '');
          break;
        case 'attached':
          XtermInterop.fit();
          XtermInterop.focus();
          break;
        case 'exit':
          XtermInterop.write('\r\n[shell exited]\r\n');
          break;
        case 'session-removed':
          XtermInterop.write('\r\n[session deleted]\r\n');
          break;
      }
    });

    // Connect WebSocket
    final size = XtermInterop.getSize();
    wsService.connect(
      session: widget.sessionName,
      cols: size.cols,
      rows: size.rows,
    );

    XtermInterop.focus();
  }

  @override
  void dispose() {
    _msgSub?.cancel();
    XtermInterop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Re-apply theme on changes
    ref.listen(themeProvider, (prev, next) {
      if (_initialized) {
        XtermInterop.setTheme(next.xtermTheme);
      }
    });

    return HtmlElementView(
      viewType: _viewType,
      onPlatformViewCreated: _onPlatformViewCreated,
    );
  }
}
