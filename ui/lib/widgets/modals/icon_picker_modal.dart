import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../providers/config_provider.dart';
import '../../theme/design_tokens.dart';

/// Subset of Phosphor icons commonly used for instance identification.
const iconOptions = <({String name, IconData icon})>[
  (name: 'terminal-window', icon: PhosphorIconsRegular.terminalWindow),
  (name: 'terminal', icon: PhosphorIconsRegular.terminal),
  (name: 'desktop', icon: PhosphorIconsRegular.desktop),
  (name: 'laptop', icon: PhosphorIconsRegular.laptop),
  (name: 'device-mobile', icon: PhosphorIconsRegular.deviceMobile),
  (name: 'cloud', icon: PhosphorIconsRegular.cloud),
  (name: 'globe', icon: PhosphorIconsRegular.globe),
  (name: 'house', icon: PhosphorIconsRegular.house),
  (name: 'code', icon: PhosphorIconsRegular.code),
  (name: 'gear', icon: PhosphorIconsRegular.gear),
  (name: 'robot', icon: PhosphorIconsRegular.robot),
  (name: 'lightning', icon: PhosphorIconsRegular.lightning),
  (name: 'rocket', icon: PhosphorIconsRegular.rocket),
  (name: 'heart', icon: PhosphorIconsRegular.heart),
  (name: 'star', icon: PhosphorIconsRegular.star),
  (name: 'fire', icon: PhosphorIconsRegular.fire),
  (name: 'skull', icon: PhosphorIconsRegular.skull),
  (name: 'shield', icon: PhosphorIconsRegular.shield),
  (name: 'key', icon: PhosphorIconsRegular.key),
  (name: 'lock', icon: PhosphorIconsRegular.lock),
  (name: 'database', icon: PhosphorIconsRegular.database),
  (name: 'hard-drives', icon: PhosphorIconsRegular.hardDrives),
  (name: 'cpu', icon: PhosphorIconsRegular.cpu),
  (name: 'tree-structure', icon: PhosphorIconsRegular.treeStructure),
];

/// Look up icon data by name. Returns null if not found.
IconData? getInstanceIconData(String name) {
  for (final opt in iconOptions) {
    if (opt.name == name) return opt.icon;
  }
  return null;
}

class IconPickerModal extends ConsumerWidget {
  const IconPickerModal({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(configProvider);
    final currentIcon = config.valueOrNull?.instanceIcon ?? 'terminal-window';
    final theme = Theme.of(context);

    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: DesignTokens.modalWidthSm,
          maxHeight: 400,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(DesignTokens.spaceLg),
              child: Row(
                children: [
                  Text('Choose Icon', style: theme.textTheme.titleLarge),
                  const Spacer(),
                  IconButton(
                    icon: Icon(PhosphorIcons.x()),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Flexible(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: DesignTokens.spaceLg),
                child: Wrap(
                  spacing: DesignTokens.spaceSm,
                  runSpacing: DesignTokens.spaceSm,
                  children: iconOptions.map((opt) {
                    final isSelected = opt.name == currentIcon;
                    return Semantics(
                      label: 'Icon: ${opt.name}',
                      button: true,
                      selected: isSelected,
                      child: InkWell(
                        borderRadius: BorderRadius.circular(DesignTokens.radiusMd),
                        onTap: () {
                          ref.read(configProvider.notifier).setInstanceIcon(opt.name);
                          Navigator.pop(context);
                        },
                        child: Container(
                          width: 48,
                          height: 48,
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(DesignTokens.radiusMd),
                            border: isSelected
                                ? Border.all(color: theme.colorScheme.primary, width: 2)
                                : Border.all(color: theme.dividerColor),
                            color: isSelected
                                ? theme.colorScheme.primary.withValues(alpha: 0.1)
                                : null,
                          ),
                          child: Icon(opt.icon, size: 24),
                        ),
                      ),
                    );
                  }).toList(),
                ),
              ),
            ),
            const SizedBox(height: DesignTokens.spaceLg),
          ],
        ),
      ),
    );
  }
}
