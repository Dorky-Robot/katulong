import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../services/xterm_interop.dart';
import '../../theme/design_tokens.dart';

class ScrollToBottomButton extends StatelessWidget {
  const ScrollToBottomButton({super.key});

  @override
  Widget build(BuildContext context) {
    return Positioned(
      bottom: DesignTokens.spaceLg,
      left: DesignTokens.spaceLg,
      child: FloatingActionButton.small(
        onPressed: () {
          XtermInterop.scrollToBottom();
          XtermInterop.focus();
        },
        tooltip: 'Scroll to bottom',
        child: Icon(PhosphorIcons.caretDown()),
      ),
    );
  }
}
