import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../providers/auth_provider.dart';
import '../theme/design_tokens.dart';
import '../widgets/login/loading_view.dart';
import '../widgets/login/setup_view.dart';
import '../widgets/login/login_view.dart';
import '../widgets/login/pair_view.dart';

class LoginScreen extends ConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);

    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: DesignTokens.modalWidthSm),
          child: Padding(
            padding: const EdgeInsets.all(DesignTokens.spaceXl),
            child: switch (auth.view) {
              AuthViewState.loading => const LoadingView(),
              AuthViewState.setup => const SetupView(),
              AuthViewState.login => const LoginView(),
              AuthViewState.pair => const PairView(),
            },
          ),
        ),
      ),
    );
  }
}
