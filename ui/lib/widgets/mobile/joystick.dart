import 'dart:async';
import 'package:flutter/material.dart';
import '../../theme/design_tokens.dart';

/// Mobile joystick: swipe zones for arrow keys + long-press center for Enter.
class Joystick extends StatefulWidget {
  final void Function(String sequence)? onSend;

  const Joystick({super.key, this.onSend});

  @override
  State<Joystick> createState() => _JoystickState();
}

class _JoystickState extends State<Joystick> {
  static const _arrowUp = '\x1b[A';
  static const _arrowDown = '\x1b[B';
  static const _arrowRight = '\x1b[C';
  static const _arrowLeft = '\x1b[D';
  static const _enter = '\r';

  Timer? _longPressTimer;
  double _enterProgress = 0;
  bool _longPressTriggered = false;

  void _onPanUpdate(DragUpdateDetails d) {
    const threshold = 15.0;
    if (d.delta.dx.abs() > d.delta.dy.abs()) {
      if (d.delta.dx > threshold) widget.onSend?.call(_arrowRight);
      if (d.delta.dx < -threshold) widget.onSend?.call(_arrowLeft);
    } else {
      if (d.delta.dy > threshold) widget.onSend?.call(_arrowDown);
      if (d.delta.dy < -threshold) widget.onSend?.call(_arrowUp);
    }
  }

  void _onLongPressStart() {
    _longPressTriggered = false;
    const duration = Duration(milliseconds: 600);
    const tick = Duration(milliseconds: 16);
    final total = duration.inMilliseconds;

    _longPressTimer = Timer.periodic(tick, (timer) {
      final elapsed = timer.tick * tick.inMilliseconds;
      setState(() => _enterProgress = (elapsed / total).clamp(0, 1));
      if (elapsed >= total && !_longPressTriggered) {
        _longPressTriggered = true;
        widget.onSend?.call(_enter);
        timer.cancel();
        setState(() => _enterProgress = 0);
      }
    });
  }

  void _onLongPressEnd() {
    _longPressTimer?.cancel();
    _longPressTimer = null;
    setState(() => _enterProgress = 0);
  }

  @override
  void dispose() {
    _longPressTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      bottom: DesignTokens.spaceLg,
      right: DesignTokens.spaceLg,
      child: GestureDetector(
        onPanUpdate: _onPanUpdate,
        onLongPressStart: (_) => _onLongPressStart(),
        onLongPressEnd: (_) => _onLongPressEnd(),
        onLongPressCancel: _onLongPressEnd,
        child: Container(
          width: 80,
          height: 80,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.7),
            border: Border.all(color: Theme.of(context).dividerColor),
          ),
          child: CustomPaint(
            painter: _ProgressRingPainter(
              progress: _enterProgress,
              color: Theme.of(context).colorScheme.primary,
            ),
            child: Center(
              child: Icon(
                Icons.open_with,
                color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
                size: 28,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ProgressRingPainter extends CustomPainter {
  final double progress;
  final Color color;

  _ProgressRingPainter({required this.progress, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0) return;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;

    final rect = Rect.fromLTWH(2, 2, size.width - 4, size.height - 4);
    canvas.drawArc(rect, -1.5708, progress * 6.2832, false, paint);
  }

  @override
  bool shouldRepaint(_ProgressRingPainter old) => old.progress != progress;
}
