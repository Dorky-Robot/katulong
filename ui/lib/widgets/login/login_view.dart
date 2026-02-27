import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../providers/auth_provider.dart';
import '../../theme/design_tokens.dart';

class LoginView extends ConsumerStatefulWidget {
  const LoginView({super.key});

  @override
  ConsumerState<LoginView> createState() => _LoginViewState();
}

class _LoginViewState extends ConsumerState<LoginView> {
  final _tokenController = TextEditingController();
  bool _showRegisterFields = false;

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
          'Katulong',
          style: theme.textTheme.headlineSmall,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: DesignTokens.spaceSm),
        Text(
          'Authenticate with your passkey.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
          ),
          textAlign: TextAlign.center,
        ),
        if (auth.infoMessage != null) ...[
          const SizedBox(height: DesignTokens.spaceMd),
          Container(
            padding: const EdgeInsets.all(DesignTokens.spaceMd),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(DesignTokens.radiusMd),
            ),
            child: Text(
              auth.infoMessage!,
              style: TextStyle(color: theme.colorScheme.primary),
              textAlign: TextAlign.center,
            ),
          ),
        ],
        if (auth.error != null) ...[
          const SizedBox(height: DesignTokens.spaceSm),
          Text(
            auth.error!,
            style: TextStyle(color: theme.colorScheme.error),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: DesignTokens.spaceXl),
        if (auth.hasExistingPasskeys)
          FilledButton(
            onPressed: auth.isProcessing
                ? null
                : () => ref.read(authProvider.notifier).login(),
            child: auth.isProcessing
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Login with Passkey'),
          ),
        const SizedBox(height: DesignTokens.spaceMd),
        TextButton(
          onPressed: () => setState(() {
            _showRegisterFields = !_showRegisterFields;
          }),
          child: Text(_showRegisterFields
              ? 'Hide Registration'
              : 'Register New Passkey'),
        ),
        if (_showRegisterFields || !auth.hasExistingPasskeys) ...[
          const SizedBox(height: DesignTokens.spaceMd),
          TextField(
            controller: _tokenController,
            decoration: const InputDecoration(
              labelText: 'Setup Token',
              hintText: 'Required for new device registration',
            ),
          ),
          const SizedBox(height: DesignTokens.spaceMd),
          OutlinedButton(
            onPressed: auth.isProcessing
                ? null
                : () => ref.read(authProvider.notifier).registerNew(
                      setupToken: _tokenController.text.trim(),
                    ),
            child: const Text('Register New Passkey'),
          ),
        ],
      ],
    );
  }
}
