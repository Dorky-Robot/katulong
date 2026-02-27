import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web/web.dart' as web;
import '../services/api_client.dart';
import '../services/webauthn_interop.dart';

enum AuthViewState { loading, setup, login, pair }

class AuthState {
  final AuthViewState view;
  final String? error;
  final String? infoMessage;
  final bool hasExistingPasskeys;
  final bool isProcessing;

  const AuthState({
    this.view = AuthViewState.loading,
    this.error,
    this.infoMessage,
    this.hasExistingPasskeys = true,
    this.isProcessing = false,
  });

  AuthState copyWith({
    AuthViewState? view,
    String? error,
    String? infoMessage,
    bool? hasExistingPasskeys,
    bool? isProcessing,
    bool clearError = false,
    bool clearInfo = false,
  }) {
    return AuthState(
      view: view ?? this.view,
      error: clearError ? null : (error ?? this.error),
      infoMessage: clearInfo ? null : (infoMessage ?? this.infoMessage),
      hasExistingPasskeys: hasExistingPasskeys ?? this.hasExistingPasskeys,
      isProcessing: isProcessing ?? this.isProcessing,
    );
  }
}

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier() : super(const AuthState()) {
    _checkStatus();
  }

  Future<void> _checkStatus() async {
    try {
      final res = await ApiClient.get('/auth/status');
      final data = res.json;
      final isSetup = data['setup'] as bool? ?? false;

      final hasWebAuthn = WebAuthnInterop.isSupported() &&
          (web.window.location.protocol == 'https:' ||
           web.window.location.hostname == 'localhost' ||
           web.window.location.hostname == '127.0.0.1');

      if (isSetup) {
        if (hasWebAuthn) {
          state = state.copyWith(view: AuthViewState.login, clearError: true);
          await _checkExistingPasskeys();
        } else {
          state = state.copyWith(view: AuthViewState.pair, clearError: true);
        }
      } else {
        state = state.copyWith(view: AuthViewState.setup, clearError: true);
      }

      // Check for revocation redirect
      final params = Uri.parse(web.window.location.href).queryParameters;
      if (params['reason'] == 'revoked') {
        state = state.copyWith(
          infoMessage: 'Your access was revoked. Please register a new passkey to continue.',
        );
        web.window.history.replaceState(
          null,
          '',
          web.window.location.pathname,
        );
      }
    } catch (e) {
      state = state.copyWith(
        view: AuthViewState.login,
        error: 'Failed to check auth status: $e',
      );
    }
  }

  Future<void> _checkExistingPasskeys() async {
    try {
      final res = await ApiClient.post('/auth/login/options');
      if (res.ok) {
        final opts = res.json;
        final creds = opts['allowCredentials'] as List?;
        if (creds == null || creds.isEmpty) {
          state = state.copyWith(
            hasExistingPasskeys: false,
            infoMessage: 'No passkey registered yet. Please register your fingerprint/Touch ID below.',
          );
        }
      }
    } catch (_) {
      // Silently fail — user can still try login
    }
  }

  /// First-time registration (setup view).
  Future<void> register({String? setupToken}) async {
    final isLocalhost = web.window.location.hostname == 'localhost' ||
        web.window.location.hostname == '127.0.0.1';

    if ((setupToken == null || setupToken.isEmpty) && !isLocalhost) {
      state = state.copyWith(
        error: 'Setup token is required for remote registration.',
      );
      return;
    }

    await _performRegistration(setupToken ?? '');
  }

  /// Register new passkey on already-setup instance (login view).
  Future<void> registerNew({required String setupToken}) async {
    if (setupToken.isEmpty) {
      state = state.copyWith(
        error: 'Setup token is required.',
      );
      return;
    }

    await _performRegistration(setupToken);
  }

  Future<void> _performRegistration(String setupToken) async {
    state = state.copyWith(isProcessing: true, clearError: true);

    try {
      final optsRes = await ApiClient.post('/auth/register/options', {
        'setupToken': setupToken,
      });
      if (!optsRes.ok) {
        final err = optsRes.json as Map<String, dynamic>;
        throw Exception(err['error'] ?? 'Failed to get registration options');
      }

      final credential = await WebAuthnInterop.startRegistration(optsRes.json);

      final verifyRes = await ApiClient.post('/auth/register/verify', {
        'credential': credential,
        'setupToken': setupToken,
        'deviceName': _generateDeviceName(),
        'userAgent': web.window.navigator.userAgent,
      });
      if (!verifyRes.ok) {
        final err = verifyRes.json as Map<String, dynamic>;
        throw Exception(err['error'] ?? 'Registration failed');
      }

      web.window.location.href = '/';
    } catch (e) {
      state = state.copyWith(
        isProcessing: false,
        error: _formatWebAuthnError(e),
      );
    }
  }

  /// Login with existing passkey.
  Future<void> login() async {
    state = state.copyWith(isProcessing: true, clearError: true, clearInfo: true);

    try {
      final optsRes = await ApiClient.post('/auth/login/options');
      if (!optsRes.ok) {
        final err = optsRes.json;
        throw Exception(err['error'] ?? 'Failed to get login options');
      }
      final opts = optsRes.json;

      final creds = opts['allowCredentials'] as List?;
      if (creds == null || creds.isEmpty) {
        state = state.copyWith(
          isProcessing: false,
          error: 'No passkeys registered for this device. Please register a new passkey below.',
        );
        return;
      }

      final credential = await WebAuthnInterop.startAuthentication(opts);

      final verifyRes = await ApiClient.post('/auth/login/verify', {
        'credential': credential,
      });
      if (!verifyRes.ok) {
        final err = verifyRes.json;
        throw Exception(err['error'] ?? 'Login failed');
      }

      web.window.location.href = '/';
    } catch (e) {
      state = state.copyWith(
        isProcessing: false,
        error: _formatWebAuthnError(e),
      );
    }
  }

  String _generateDeviceName() {
    final ua = web.window.navigator.userAgent;
    if (ua.contains('iPhone')) return 'iPhone';
    if (ua.contains('iPad')) return 'iPad';
    if (ua.contains('Android')) return 'Android';
    if (ua.contains('Mac')) return 'Mac';
    if (ua.contains('Windows')) return 'Windows';
    if (ua.contains('Linux')) return 'Linux';
    return 'Unknown Device';
  }

  String _formatWebAuthnError(Object error) {
    final msg = error.toString();
    if (msg.contains('NotAllowedError')) {
      return 'Authentication was cancelled or not allowed.';
    }
    if (msg.contains('SecurityError')) {
      return 'Security error — ensure you are using HTTPS or localhost.';
    }
    if (msg.contains('InvalidStateError')) {
      return 'This passkey is already registered.';
    }
    // Strip "Exception: " prefix
    return msg.replaceFirst('Exception: ', '');
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>(
  (ref) => AuthNotifier(),
);
