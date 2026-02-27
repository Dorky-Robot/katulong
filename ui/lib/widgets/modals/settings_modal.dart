import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:web/web.dart' as web;
import '../../providers/theme_provider.dart';
import '../../providers/config_provider.dart';
import '../../providers/token_store.dart';
import '../../services/api_client.dart';
import '../../services/csrf_service.dart';
import '../../theme/design_tokens.dart';
import '../../theme/toolbar_colors.dart';
import 'icon_picker_modal.dart';

class SettingsModal extends ConsumerStatefulWidget {
  const SettingsModal({super.key});

  @override
  ConsumerState<SettingsModal> createState() => _SettingsModalState();
}

class _SettingsModalState extends ConsumerState<SettingsModal>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: DesignTokens.modalWidthMd,
          maxHeight: 500,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(DesignTokens.spaceLg),
              child: Row(
                children: [
                  Text('Settings', style: Theme.of(context).textTheme.titleLarge),
                  const Spacer(),
                  IconButton(
                    icon: Icon(PhosphorIcons.x()),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            TabBar(
              controller: _tabController,
              tabs: const [
                Tab(text: 'Theme'),
                Tab(text: 'Remote'),
              ],
            ),
            Expanded(
              child: TabBarView(
                controller: _tabController,
                children: const [
                  _ThemeTab(),
                  _RemoteTab(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ThemeTab extends ConsumerWidget {
  const _ThemeTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeState = ref.watch(themeProvider);
    final config = ref.watch(configProvider);
    final currentIcon = config.valueOrNull?.instanceIcon ?? 'terminal-window';
    final theme = Theme.of(context);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(DesignTokens.spaceLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Appearance', style: theme.textTheme.titleSmall),
          const SizedBox(height: DesignTokens.spaceSm),
          SegmentedButton<ThemePreference>(
            segments: const [
              ButtonSegment(value: ThemePreference.auto, label: Text('Auto')),
              ButtonSegment(value: ThemePreference.light, label: Text('Light')),
              ButtonSegment(value: ThemePreference.dark, label: Text('Dark')),
            ],
            selected: {themeState.preference},
            onSelectionChanged: (value) {
              ref.read(themeProvider.notifier).setPreference(value.first);
            },
          ),
          const SizedBox(height: DesignTokens.spaceXl),
          Text('Instance Icon', style: theme.textTheme.titleSmall),
          const SizedBox(height: DesignTokens.spaceSm),
          Row(
            children: [
              Semantics(
                label: 'Instance icon: $currentIcon',
                child: Icon(
                  getInstanceIconData(currentIcon) ?? PhosphorIconsRegular.terminalWindow,
                  size: 32,
                ),
              ),
              const SizedBox(width: DesignTokens.spaceSm),
              FilledButton.tonal(
                onPressed: () => showDialog(
                  context: context,
                  builder: (_) => const IconPickerModal(),
                ),
                child: const Text('Change'),
              ),
            ],
          ),
          const SizedBox(height: DesignTokens.spaceXl),
          Text('Toolbar Color', style: theme.textTheme.titleSmall),
          const SizedBox(height: DesignTokens.spaceSm),
          Wrap(
            spacing: DesignTokens.spaceSm,
            runSpacing: DesignTokens.spaceSm,
            children: toolbarColors.map((tc) {
              final isSelected = tc.id == themeState.toolbarColorId;
              return Semantics(
                label: 'Toolbar color: ${tc.name}',
                button: true,
                selected: isSelected,
                child: GestureDetector(
                  onTap: () {
                    ref.read(themeProvider.notifier).setToolbarColor(tc.id);
                    ref.read(configProvider.notifier).setToolbarColor(tc.id);
                  },
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: tc.color,
                      borderRadius: BorderRadius.circular(DesignTokens.radiusSm),
                      border: isSelected
                          ? Border.all(color: theme.colorScheme.primary, width: 2)
                          : null,
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
        ],
      ),
    );
  }
}

class _RemoteTab extends ConsumerStatefulWidget {
  const _RemoteTab();

  @override
  ConsumerState<_RemoteTab> createState() => _RemoteTabState();
}

class _RemoteTabState extends ConsumerState<_RemoteTab> {
  bool _showCreateForm = false;
  String? _newlyCreatedToken;
  String? _newlyCreatedLabel;
  final _nameController = TextEditingController();

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _createToken() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) return;
    try {
      final token = await ref.read(tokenStoreProvider.notifier).create(label: name);
      setState(() {
        _showCreateForm = false;
        _newlyCreatedToken = token;
        _newlyCreatedLabel = name;
        _nameController.clear();
      });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to create token: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final tokens = ref.watch(tokenStoreProvider);
    final theme = Theme.of(context);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(DesignTokens.spaceLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Setup Tokens', style: theme.textTheme.titleSmall),
              const Spacer(),
              if (!_showCreateForm && _newlyCreatedToken == null)
                FilledButton.tonal(
                  onPressed: () => setState(() => _showCreateForm = true),
                  child: const Text('Generate New Token'),
                ),
            ],
          ),
          const SizedBox(height: DesignTokens.spaceSm),

          // Token creation form
          if (_showCreateForm)
            Semantics(
              label: 'Create token form',
              container: true,
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(DesignTokens.spaceMd),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                        controller: _nameController,
                        decoration: const InputDecoration(
                          labelText: 'Token name',
                          hintText: 'e.g., My Laptop',
                          isDense: true,
                        ),
                        autofocus: true,
                        onSubmitted: (_) => _createToken(),
                      ),
                      const SizedBox(height: DesignTokens.spaceSm),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: () => setState(() {
                              _showCreateForm = false;
                              _nameController.clear();
                            }),
                            child: const Text('Cancel'),
                          ),
                          const SizedBox(width: DesignTokens.spaceXs),
                          FilledButton(
                            onPressed: _createToken,
                            child: const Text('Create'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),

          // Newly created token display
          if (_newlyCreatedToken != null)
            Semantics(
              label: 'New token',
              container: true,
              child: Card(
                color: theme.colorScheme.primaryContainer,
                child: Padding(
                  padding: const EdgeInsets.all(DesignTokens.spaceMd),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(_newlyCreatedLabel ?? 'New Token',
                          style: theme.textTheme.titleSmall),
                      const SizedBox(height: DesignTokens.spaceXs),
                      const Text('Save this token now — it will not be shown again.'),
                      const SizedBox(height: DesignTokens.spaceSm),
                      Row(
                        children: [
                          Expanded(
                            child: SelectableText(
                              _newlyCreatedToken!,
                              style: const TextStyle(
                                fontFamily: 'monospace',
                                fontSize: DesignTokens.textSm,
                              ),
                            ),
                          ),
                          _CopyButton(text: _newlyCreatedToken!),
                        ],
                      ),
                      const SizedBox(height: DesignTokens.spaceSm),
                      Align(
                        alignment: Alignment.centerRight,
                        child: FilledButton(
                          onPressed: () => setState(() {
                            _newlyCreatedToken = null;
                            _newlyCreatedLabel = null;
                          }),
                          child: const Text('Done'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),

          // Token list
          tokens.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Text('Error: $e'),
            data: (list) => list.isEmpty
                ? Text('No tokens',
                    style: TextStyle(
                        color: theme.colorScheme.onSurface.withValues(alpha: 0.5)))
                : Semantics(
                    label: 'Tokens list',
                    container: true,
                    child: Column(
                      children: list.map((t) {
                        final displayName = t.label ?? t.id;
                        return Semantics(
                          label: 'Token: $displayName',
                          container: true,
                          child: ListTile(
                            title: Text(displayName,
                                style: const TextStyle(fontSize: DesignTokens.textSm)),
                            subtitle: t.used
                                ? const Text('Active device')
                                : Text(t.id,
                                    style: TextStyle(
                                        fontFamily: 'monospace',
                                        fontSize: DesignTokens.textXs,
                                        color: theme.colorScheme.onSurface
                                            .withValues(alpha: 0.5))),
                            trailing: IconButton(
                              icon: Icon(PhosphorIcons.trash()),
                              tooltip: 'Revoke token',
                              onPressed: () async {
                                final confirm = await showDialog<bool>(
                                  context: context,
                                  builder: (ctx) => AlertDialog(
                                    title: const Text('Revoke Token'),
                                    content: Text(t.used
                                        ? 'This token has a linked device. '
                                          'Revoking it will cause that device to lose access. Continue?'
                                        : 'Revoke token "$displayName"?'),
                                    actions: [
                                      TextButton(
                                          onPressed: () => Navigator.pop(ctx, false),
                                          child: const Text('Cancel')),
                                      FilledButton(
                                          onPressed: () => Navigator.pop(ctx, true),
                                          child: const Text('Revoke')),
                                    ],
                                  ),
                                );
                                if (confirm == true) {
                                  ref.read(tokenStoreProvider.notifier).delete(t.id);
                                }
                              },
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ),
          ),
          const SizedBox(height: DesignTokens.spaceXl),
          const Divider(),
          const SizedBox(height: DesignTokens.spaceMd),
          Semantics(
            label: 'End Session',
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: theme.colorScheme.error,
              ),
              onPressed: () => _logout(context),
              child: const Text('End Session'),
            ),
          ),
          const SizedBox(height: DesignTokens.spaceSm),
          OutlinedButton(
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.colorScheme.error,
            ),
            onPressed: () => _revokeAll(context),
            child: const Text('Revoke All Sessions'),
          ),
        ],
      ),
    );
  }

  Future<void> _logout(BuildContext context) async {
    try {
      await ApiClient.post('/auth/logout');
      CsrfService.invalidate();
      web.window.location.href = '/login';
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Logout failed: $e')),
        );
      }
    }
  }

  Future<void> _revokeAll(BuildContext context) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Revoke All Sessions'),
        content: const Text('This will log out all devices. Continue?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Revoke')),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await ApiClient.post('/auth/revoke-all');
      CsrfService.invalidate();
      web.window.location.href = '/login';
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Revoke failed: $e')),
        );
      }
    }
  }
}

class _CopyButton extends StatefulWidget {
  final String text;

  const _CopyButton({required this.text});

  @override
  State<_CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<_CopyButton> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.text));
    setState(() => _copied = true);
    await Future.delayed(const Duration(seconds: 2));
    if (mounted) setState(() => _copied = false);
  }

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: _copy,
      icon: Icon(_copied ? PhosphorIcons.check() : PhosphorIcons.copy()),
      label: Text(_copied ? 'Copied!' : 'Copy'),
    );
  }
}
