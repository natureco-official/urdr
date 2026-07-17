#!/usr/bin/env bash
# Initialize one English or Turkish Urðr tree without overwriting existing data.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$REPO_ROOT/templates"
PROTOCOLS_DIR="$REPO_ROOT/protocols"

TARGET_DIR=""
LANG="en"
AGENT_NAME=""
USER_NAME=""

die() { printf 'init: %s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: ./scripts/init.sh [options]
  --path <dir>          Target directory (default: ./memory)
  --lang <en|tr>        Naming language (default: en; "both" is not supported)
  --agent-name <name>   Agent name for agent-personality.md
  --user-name <name>    User name for agent-personality.md
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path|--lang|--agent-name|--user-name)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      case "$1" in
        --path) TARGET_DIR="$2" ;;
        --lang) LANG="$2" ;;
        --agent-name) AGENT_NAME="$2" ;;
        --user-name) USER_NAME="$2" ;;
      esac
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$LANG" == "en" || "$LANG" == "tr" ]] || die "--lang must be 'en' or 'tr'"
command -v node >/dev/null 2>&1 || die "node is required"
command -v git >/dev/null 2>&1 || die "git is required"

if [[ -z "$TARGET_DIR" ]]; then
  read -rp "Memory directory [./memory]: " TARGET_DIR
  TARGET_DIR="${TARGET_DIR:-./memory}"
fi
if [[ -z "$AGENT_NAME" ]]; then
  read -rp "Agent name [Agent]: " AGENT_NAME
  AGENT_NAME="${AGENT_NAME:-Agent}"
fi
if [[ -z "$USER_NAME" ]]; then
  read -rp "Your name [User]: " USER_NAME
  USER_NAME="${USER_NAME:-User}"
fi

# Resolve without creating the target. Node handles .. and platform-specific separators.
TARGET_DIR="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$TARGET_DIR")"
TARGET_PARENT="$(dirname "$TARGET_DIR")"

if [[ "$LANG" == "en" ]]; then
  ROOT_SOURCES=(root-0-index.md root-1-topics.md root-2-technical.md root-3-decisions.md)
else
  ROOT_SOURCES=(kök-0-indeks.md kök-1-konular.md kök-2-teknik.md kök-3-kararlar.md)
fi
SOURCES=("${ROOT_SOURCES[@]}" agent-personality.md)

# Preflight every input and every destination before the first write.
for name in "${SOURCES[@]}"; do
  [[ -f "$TEMPLATES_DIR/$name" ]] || die "required template not found: $TEMPLATES_DIR/$name"
done
[[ -d "$PROTOCOLS_DIR" ]] || die "protocol directory not found: $PROTOCOLS_DIR"
shopt -s nullglob
PROTOCOL_SOURCES=("$PROTOCOLS_DIR"/*.md)
shopt -u nullglob
[[ ${#PROTOCOL_SOURCES[@]} -gt 0 ]] || die "no protocol Markdown files found in $PROTOCOLS_DIR"

TARGET_WAS_EMPTY=0
if [[ -e "$TARGET_DIR" ]]; then
  [[ -d "$TARGET_DIR" ]] || die "target exists and is not a directory: $TARGET_DIR"
  shopt -s nullglob dotglob
  EXISTING=("$TARGET_DIR"/*)
  shopt -u nullglob dotglob
  [[ ${#EXISTING[@]} -eq 0 ]] || die "target directory is not empty; refusing to overwrite: $TARGET_DIR"
  TARGET_WAS_EMPTY=1
fi

# Detect an enclosing repository even when .git is a file or lives above the direct parent.
PROBE="$TARGET_PARENT"
while [[ ! -d "$PROBE" && "$PROBE" != "$(dirname "$PROBE")" ]]; do PROBE="$(dirname "$PROBE")"; done
if GIT_TOP="$(git -C "$PROBE" rev-parse --show-toplevel 2>/dev/null)"; then
  die "target would create a nested git repository inside: $GIT_TOP"
fi
# Everything below is the commit phase. Prepare a complete sibling tree, then rename it.
mkdir -p "$TARGET_PARENT"
STAGE_DIR="$(mktemp -d "$TARGET_PARENT/.urdr-init.XXXXXX")"
cleanup() { [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]] && rm -rf -- "$STAGE_DIR"; }
trap cleanup EXIT

for name in "${SOURCES[@]}"; do cp -- "$TEMPLATES_DIR/$name" "$STAGE_DIR/$name"; done
mkdir "$STAGE_DIR/protocols"
for source in "${PROTOCOL_SOURCES[@]}"; do cp -- "$source" "$STAGE_DIR/protocols/"; done

# Use literal JavaScript replacement, not sed replacement syntax, so &, /, \, $, and Unicode are safe.
node - "$STAGE_DIR/agent-personality.md" "$AGENT_NAME" "$USER_NAME" <<'NODE'
const fs = require('fs');
const [file, agent, user] = process.argv.slice(2);
let content = fs.readFileSync(file, 'utf8');
content = content.replaceAll('[Agent Name]', agent).replaceAll('[User Name]', user);
fs.writeFileSync(file, content, 'utf8');
NODE

# Birth the staged tree with an authoritative event log. Any failure remains
# confined to STAGE_DIR and the EXIT trap removes it before the target is touched.
node "$SCRIPT_DIR/lib/transaction.mjs" import "$STAGE_DIR" >/dev/null

git -C "$STAGE_DIR" init -q
git -C "$STAGE_DIR" add -A
git -C "$STAGE_DIR" -c user.name=Urdr -c user.email=urdr@localhost commit -m "initial: Urðr memory tree initialized" -q

if [[ $TARGET_WAS_EMPTY -eq 1 ]]; then rmdir -- "$TARGET_DIR"; fi
mv -- "$STAGE_DIR" "$TARGET_DIR"
STAGE_DIR=""
trap - EXIT

printf 'Urðr memory tree initialized\nLocation: %s\nLanguage: %s\nRoots: %s\n' \
  "$TARGET_DIR" "$LANG" "${#ROOT_SOURCES[@]}"
