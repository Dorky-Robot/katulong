#!/bin/bash
# Test wrapper script (simulates Homebrew formula wrapper)

export KATULONG_DATA_DIR="${HOME}/.katulong"
exec node "$(pwd)/bin/katulong" "$@"
