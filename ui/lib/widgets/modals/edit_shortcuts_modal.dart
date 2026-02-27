import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../providers/shortcuts_store.dart';
import '../../theme/design_tokens.dart';

class EditShortcutsModal extends ConsumerWidget {
  final VoidCallback? onAdd;

  const EditShortcutsModal({super.key, this.onAdd});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shortcuts = ref.watch(shortcutsStoreProvider);
    final theme = Theme.of(context);

    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: DesignTokens.modalWidthSm,
          maxHeight: 500,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(DesignTokens.spaceLg),
              child: Row(
                children: [
                  Text('Edit Shortcuts', style: theme.textTheme.titleLarge),
                  const Spacer(),
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
                        child: Text('No shortcuts yet.'),
                      )
                    : ListView.builder(
                        shrinkWrap: true,
                        itemCount: list.length,
                        itemBuilder: (context, i) {
                          final s = list[i];
                          return ListTile(
                            title: Text(s.label),
                            subtitle: Text(s.keys),
                            trailing: IconButton(
                              icon: Icon(PhosphorIcons.trash(), color: theme.colorScheme.error),
                              onPressed: () =>
                                  ref.read(shortcutsStoreProvider.notifier).remove(i),
                            ),
                          );
                        },
                      ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(DesignTokens.spaceLg),
              child: Row(
                children: [
                  OutlinedButton.icon(
                    onPressed: () {
                      Navigator.pop(context);
                      onAdd?.call();
                    },
                    icon: Icon(PhosphorIcons.plus()),
                    label: const Text('Add'),
                  ),
                  const Spacer(),
                  FilledButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Done'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
