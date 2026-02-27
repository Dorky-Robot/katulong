import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../services/xterm_interop.dart';
import '../../theme/design_tokens.dart';

class SearchOverlay extends StatefulWidget {
  final VoidCallback onClose;

  const SearchOverlay({super.key, required this.onClose});

  @override
  State<SearchOverlay> createState() => _SearchOverlayState();
}

class _SearchOverlayState extends State<SearchOverlay> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    _focusNode.requestFocus();
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    XtermInterop.clearSearch();
    super.dispose();
  }

  void _search() {
    final query = _controller.text;
    if (query.isNotEmpty) {
      XtermInterop.search(query);
    }
  }

  void _searchPrevious() {
    final query = _controller.text;
    if (query.isNotEmpty) {
      XtermInterop.searchPrevious(query);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Positioned(
      top: DesignTokens.heightBar + DesignTokens.spaceSm,
      right: DesignTokens.spaceSm,
      child: Material(
        elevation: 4,
        borderRadius: BorderRadius.circular(DesignTokens.radiusMd),
        color: theme.colorScheme.surfaceContainerHighest,
        child: Padding(
          padding: const EdgeInsets.all(DesignTokens.spaceXs),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 200,
                height: DesignTokens.heightBtnSm,
                child: TextField(
                  controller: _controller,
                  focusNode: _focusNode,
                  decoration: const InputDecoration(
                    hintText: 'Find...',
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(
                      horizontal: DesignTokens.spaceSm,
                      vertical: DesignTokens.spaceXs,
                    ),
                    border: InputBorder.none,
                  ),
                  style: const TextStyle(fontSize: DesignTokens.textSm),
                  onSubmitted: (_) => _search(),
                  onChanged: (_) => _search(),
                ),
              ),
              IconButton(
                icon: Icon(PhosphorIcons.caretUp(), size: 16),
                onPressed: _searchPrevious,
                tooltip: 'Previous',
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              ),
              IconButton(
                icon: Icon(PhosphorIcons.caretDown(), size: 16),
                onPressed: _search,
                tooltip: 'Next',
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              ),
              IconButton(
                icon: Icon(PhosphorIcons.x(), size: 16),
                onPressed: widget.onClose,
                tooltip: 'Close',
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
