import 'package:flutter/material.dart';

/// Pull-to-refresh gesture that sends Ctrl-L (clear) to the terminal.
class PullToRefresh extends StatefulWidget {
  final void Function(String sequence)? onSend;
  final Widget child;

  const PullToRefresh({super.key, this.onSend, required this.child});

  @override
  State<PullToRefresh> createState() => _PullToRefreshState();
}

class _PullToRefreshState extends State<PullToRefresh> {
  double _pullDistance = 0;
  static const _threshold = 80.0;
  static const _ctrlL = '\x0c'; // Ctrl-L

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onVerticalDragUpdate: (d) {
        if (d.delta.dy > 0) {
          setState(() => _pullDistance += d.delta.dy);
        }
      },
      onVerticalDragEnd: (_) {
        if (_pullDistance >= _threshold) {
          widget.onSend?.call(_ctrlL);
        }
        setState(() => _pullDistance = 0);
      },
      onVerticalDragCancel: () {
        setState(() => _pullDistance = 0);
      },
      child: Stack(
        children: [
          widget.child,
          if (_pullDistance > 10)
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(
                      value: (_pullDistance / _threshold).clamp(0, 1),
                      strokeWidth: 2,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
