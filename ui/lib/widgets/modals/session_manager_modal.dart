import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:web/web.dart' as web;
import '../../providers/session_store.dart';
import '../../theme/design_tokens.dart';

class SessionManagerModal extends ConsumerStatefulWidget {
  final String currentSession;

  const SessionManagerModal({super.key, required this.currentSession});

  @override
  ConsumerState<SessionManagerModal> createState() => _SessionManagerModalState();
}

class _SessionManagerModalState extends ConsumerState<SessionManagerModal> {
  final _newSessionController = TextEditingController();

  @override
  void dispose() {
    _newSessionController.dispose();
    super.dispose();
  }

  void _switchSession(String name) {
    Navigator.pop(context);
    final url = Uri.parse(web.window.location.href).replace(queryParameters: {'s': name});
    web.window.location.href = url.toString();
  }

  @override
  Widget build(BuildContext context) {
    final sessions = ref.watch(sessionStoreProvider);
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
                  Text('Sessions', style: theme.textTheme.titleLarge),
                  const Spacer(),
                  IconButton(
                    icon: Icon(PhosphorIcons.x()),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            // Create new session
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: DesignTokens.spaceLg),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _newSessionController,
                      decoration: const InputDecoration(
                        hintText: 'New session name',
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: DesignTokens.spaceSm),
                  FilledButton(
                    onPressed: () async {
                      final name = _newSessionController.text.trim();
                      if (name.isEmpty) return;
                      try {
                        await ref.read(sessionStoreProvider.notifier).create(name);
                        _newSessionController.clear();
                        _switchSession(name);
                      } catch (e) {
                        if (mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text('$e')),
                          );
                        }
                      }
                    },
                    child: const Text('Create'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: DesignTokens.spaceMd),
            Flexible(
              child: sessions.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Center(child: Text('Error: $e')),
                data: (list) => ListView.builder(
                  shrinkWrap: true,
                  itemCount: list.length,
                  itemBuilder: (context, i) {
                    final s = list[i];
                    final isCurrent = s.name == widget.currentSession;
                    return ListTile(
                      leading: Icon(
                        isCurrent ? PhosphorIcons.terminal() : PhosphorIcons.terminalWindow(),
                        color: isCurrent ? theme.colorScheme.primary : null,
                      ),
                      title: Text(
                        s.name,
                        style: TextStyle(
                          fontWeight: isCurrent ? FontWeight.bold : null,
                        ),
                      ),
                      subtitle: s.active ? const Text('active') : null,
                      onTap: () => _switchSession(s.name),
                      trailing: isCurrent
                          ? null
                          : IconButton(
                              icon: Icon(PhosphorIcons.trash(), size: 18),
                              onPressed: () async {
                                try {
                                  await ref.read(sessionStoreProvider.notifier).delete(s.name);
                                } catch (e) {
                                  if (mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(content: Text('$e')),
                                    );
                                  }
                                }
                              },
                            ),
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
