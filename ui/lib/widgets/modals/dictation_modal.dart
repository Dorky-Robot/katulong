import 'package:flutter/material.dart';
import '../../theme/design_tokens.dart';

class DictationModal extends StatefulWidget {
  final void Function(String text)? onSubmit;

  const DictationModal({super.key, this.onSubmit});

  @override
  State<DictationModal> createState() => _DictationModalState();
}

class _DictationModalState extends State<DictationModal> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: DesignTokens.modalWidthMd),
        child: Padding(
          padding: const EdgeInsets.all(DesignTokens.spaceLg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Dictation', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: DesignTokens.spaceMd),
              TextField(
                controller: _controller,
                maxLines: 5,
                decoration: const InputDecoration(
                  hintText: 'Type or paste text to send to the terminal...',
                ),
                autofocus: true,
              ),
              const SizedBox(height: DesignTokens.spaceLg),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: DesignTokens.spaceSm),
                  FilledButton(
                    onPressed: () {
                      final text = _controller.text;
                      if (text.isNotEmpty) {
                        widget.onSubmit?.call(text);
                      }
                      Navigator.pop(context);
                    },
                    child: const Text('Send'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
