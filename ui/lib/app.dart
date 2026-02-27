import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'providers/theme_provider.dart';
import 'screens/login_screen.dart';
import 'screens/terminal_screen.dart';

final _router = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const TerminalScreen(),
    ),
    GoRoute(
      path: '/login',
      builder: (context, state) => const LoginScreen(),
    ),
  ],
);

class KatulongApp extends ConsumerWidget {
  const KatulongApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeState = ref.watch(themeProvider);

    return MaterialApp.router(
      title: 'Katulong',
      debugShowCheckedModeBanner: false,
      theme: themeState.themeData,
      routerConfig: _router,
    );
  }
}
