#!/bin/sh
# Installs the plaintext-data guard as this clone's git pre-commit hook.
set -e
root=$(git rev-parse --show-toplevel)
cat > "$root/.git/hooks/pre-commit" <<'HOOK'
#!/bin/sh
exec python3 "$(git rev-parse --show-toplevel)/tools/check_staged.py"
HOOK
chmod +x "$root/.git/hooks/pre-commit"
echo "pre-commit hook installed"
