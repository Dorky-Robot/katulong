import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../providers/shortcuts_store.dart';
import '../../theme/design_tokens.dart';

class ShortcutsPopup extends ConsumerWidget {
  final void Function(String keys)? onSendKeys;
  final VoidCallback? onEdit;

  const ShortcutsPopup({super.key, this.onSendKeys, this.onEdit});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shortcuts = ref.watch(shortcutsStoreProvider);
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
                  Text('Shortcuts', style: theme.textTheme.titleLarge),
                  const Spacer(),
                  IconButton(
                    icon: Icon(PhosphorIcons.pencilSimple()),
                    tooltip: 'Edit shortcuts',
                    onPressed: () {
                      Navigator.pop(context);
                      onEdit?.call();
                    },
                  ),
                  IconButton(
                    icon: Icon(PhosphorIcons.x()),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Flexible(
              child: shortcuts.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Center(child: Text('Error: $e')),
                data: (list) => list.isEmpty
                    ? const Padding(
                        padding: EdgeInsets.all(DesignTokens.spaceLg),
                        child: Text('No custom shortcuts. Tap edit to add some.'),
                      )
                    : ListView.builder(
                        shrinkWrap: true,
                        itemCount: list.length,
                        itemBuilder: (context, i) {
                          final s = list[i];
                          return ListTile(
                            title: Text(s.label),
                            subtitle: Text(s.keys,
                                style: TextStyle(
                                  fontSize: DesignTokens.textXs,
                                  color: theme.colorScheme.onSurface.withValues(alpha: 0.5),
                                )),
                            onTap: () {
                              Navigator.pop(context);
                              onSendKeys?.call(s.keys);
                            },
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
