import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../providers/auth_provider.dart';
import '../../theme/design_tokens.dart';

class SetupView extends ConsumerStatefulWidget {
  const SetupView({super.key});

  @override
  ConsumerState<SetupView> createState() => _SetupViewState();
}

class _SetupViewState extends ConsumerState<SetupView> {
  final _tokenController = TextEditingController();

  @override
  void dispose() {
    _tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);
    final theme = Theme.of(context);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Welcome to Katulong',
          style: theme.textTheme.headlineSmall,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: DesignTokens.spaceSm),
        Text(
          'Register your passkey to get started.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: DesignTokens.spaceXl),
        TextField(
          controller: _tokenController,
          decoration: const InputDecoration(
            labelText: 'Setup Token (optional for localhost)',
            hintText: 'Paste your setup token',
          ),
        ),
        if (auth.error != null) ...[
          const SizedBox(height: DesignTokens.spaceSm),
          Text(
            auth.error!,
            style: TextStyle(color: theme.colorScheme.error),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: DesignTokens.spaceLg),
        FilledButton(
          onPressed: auth.isProcessing
              ? null
              : () => ref.read(authProvider.notifier).register(
                    setupToken: _tokenController.text.trim(),
                  ),
          child: auth.isProcessing
              ? const SizedBox(
                  height: 20,
                  width: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Register Passkey'),
        ),
      ],
    );
  }
}
