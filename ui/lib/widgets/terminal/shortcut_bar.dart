import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../theme/design_tokens.dart';
import '../../theme/toolbar_colors.dart';
import '../../providers/theme_provider.dart';

class ShortcutBar extends ConsumerWidget {
  final String sessionName;
  final VoidCallback? onSessionTap;
  final VoidCallback? onShortcutsTap;
  final VoidCallback? onSettingsTap;
  final void Function(String sequence)? onSendSequence;

  const ShortcutBar({
    super.key,
    required this.sessionName,
    this.onSessionTap,
    this.onShortcutsTap,
    this.onSettingsTap,
    this.onSendSequence,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeState = ref.watch(themeProvider);
    final toolbarColor = getToolbarColor(themeState.toolbarColorId);
    final theme = Theme.of(context);

    final isColoredToolbar = toolbarColor.id != 'default';
    final barColor = toolbarColor.color;
    final textColor = isColoredToolbar
        ? (ThemeData.estimateBrightnessForColor(barColor) == Brightness.dark
            ? Colors.white
            : Colors.black)
        : theme.colorScheme.onSurface;

    return Semantics(
      label: 'Shortcut bar',
      container: true,
      child: Container(
        height: DesignTokens.heightBar,
        color: barColor,
        padding: const EdgeInsets.symmetric(horizontal: DesignTokens.space1_5),
        child: Row(
          children: [
            // Session button
            Semantics(
              label: 'Session: $sessionName',
              button: true,
              child: _BarButton(
                onTap: onSessionTap,
                textColor: textColor,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(PhosphorIcons.terminalWindow(), size: 16, color: textColor),
                    const SizedBox(width: DesignTokens.spaceXs),
                    Text(
                      sessionName,
                      style: TextStyle(
                        fontSize: DesignTokens.textSm,
                        color: textColor,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          const Spacer(),

          // Pinned keys: Esc, Tab
          _PinnedKey(label: 'Esc', sequence: '\x1b', textColor: textColor, onSend: onSendSequence),
          const SizedBox(width: DesignTokens.spaceXs),
          _PinnedKey(label: 'Tab', sequence: '\t', textColor: textColor, onSend: onSendSequence),
          const SizedBox(width: DesignTokens.spaceXs),

          // Shortcuts button
          _BarIconButton(
            icon: PhosphorIcons.keyboard(),
            tooltip: 'Open shortcuts',
            textColor: textColor,
            onTap: onShortcutsTap,
          ),

          // Settings button
          _BarIconButton(
            icon: PhosphorIcons.gear(),
            tooltip: 'Settings',
            textColor: textColor,
            onTap: onSettingsTap,
          ),
        ],
      ),
    ),
    );
  }
}

class _BarButton extends StatelessWidget {
  final VoidCallback? onTap;
  final Widget child;
  final Color textColor;

  const _BarButton({this.onTap, required this.child, required this.textColor});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(DesignTokens.radiusSm),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: DesignTokens.spaceSm,
            vertical: DesignTokens.spaceXs,
          ),
          child: child,
        ),
      ),
    );
  }
}

class _PinnedKey extends StatelessWidget {
  final String label;
  final String sequence;
  final Color textColor;
  final void Function(String)? onSend;

  const _PinnedKey({
    required this.label,
    required this.sequence,
    required this.textColor,
    this.onSend,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Send $label',
      button: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () => onSend?.call(sequence),
          borderRadius: BorderRadius.circular(DesignTokens.radiusSm),
          child: Container(
            padding: const EdgeInsets.symmetric(
              horizontal: DesignTokens.spaceSm,
              vertical: DesignTokens.spaceXs,
            ),
            decoration: BoxDecoration(
              border: Border.all(color: textColor.withValues(alpha: 0.3)),
              borderRadius: BorderRadius.circular(DesignTokens.radiusSm),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: DesignTokens.textXs,
                color: textColor,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _BarIconButton extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final Color textColor;
  final VoidCallback? onTap;

  const _BarIconButton({
    required this.icon,
    required this.tooltip,
    required this.textColor,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 20, color: textColor),
      tooltip: tooltip,
      onPressed: onTap,
      splashRadius: 18,
      padding: const EdgeInsets.all(DesignTokens.spaceXs),
      constraints: const BoxConstraints(
        minWidth: DesignTokens.heightBtnSm,
        minHeight: DesignTokens.heightBtnSm,
      ),
    );
  }
}
