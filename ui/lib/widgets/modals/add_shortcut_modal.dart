import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../providers/shortcuts_store.dart';
import '../../theme/design_tokens.dart';

class AddShortcutModal extends ConsumerStatefulWidget {
  const AddShortcutModal({super.key});

  @override
  ConsumerState<AddShortcutModal> createState() => _AddShortcutModalState();
}

class _AddShortcutModalState extends ConsumerState<AddShortcutModal> {
  final _labelController = TextEditingController();
  final _keysController = TextEditingController();

  @override
  void dispose() {
    _labelController.dispose();
    _keysController.dispose();
    super.dispose();
  }

  bool get _isValid =>
      _labelController.text.trim().isNotEmpty &&
      _keysController.text.trim().isNotEmpty;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: DesignTokens.modalWidthSm),
        child: Padding(
          padding: const EdgeInsets.all(DesignTokens.spaceLg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Add Shortcut', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: DesignTokens.spaceLg),
              TextField(
                controller: _labelController,
                decoration: const InputDecoration(
                  labelText: 'Label',
                  hintText: 'e.g., Clear Screen',
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: DesignTokens.spaceMd),
              TextField(
                controller: _keysController,
                decoration: const InputDecoration(
                  labelText: 'Keys',
                  hintText: 'e.g., ctrl+l',
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: DesignTokens.spaceXs),
              Text(
                'ctrl, cmd, alt, shift, a-z, 0-9, esc, tab, enter, space, backspace, up, down, left, right',
                style: TextStyle(
                  fontSize: DesignTokens.textXs,
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
                ),
              ),
              const SizedBox(height: DesignTokens.spaceLg),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: DesignTokens.spaceSm),
                  FilledButton(
                    onPressed: _isValid
                        ? () async {
                            await ref.read(shortcutsStoreProvider.notifier).add(
                                  ShortcutItem(
                                    label: _labelController.text.trim(),
                                    keys: _keysController.text.trim(),
                                  ),
                                );
                            if (mounted) Navigator.pop(context);
                          }
                        : null,
                    child: const Text('Add'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
