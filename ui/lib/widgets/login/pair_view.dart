import 'package:flutter/material.dart';
import '../../theme/design_tokens.dart';

class PairView extends StatelessWidget {
  const PairView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Pair This Device',
          style: theme.textTheme.headlineSmall,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: DesignTokens.spaceMd),
        Text(
          'WebAuthn requires HTTPS or localhost.\n\n'
          'To register this device:\n'
          '1. Open this URL on a device with HTTPS access\n'
          '2. Generate a setup token in Settings > Remote\n'
          '3. Use the token to register a passkey on this device',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
          ),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}
