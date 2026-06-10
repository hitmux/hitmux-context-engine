#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

PACKAGE_NAME="@hitmux/hitmux-context-engine-mcp"
COMMAND_NAME="${COMMAND_NAME:-hitmux-context-engine-mcp}"

if (( EUID == 0 )); then
    DEFAULT_BIN_DIR="/usr/local/bin"
    INSTALL_SCOPE="global"
else
    DEFAULT_BIN_DIR="${HOME}/.local/bin"
    INSTALL_SCOPE="user"
fi

BIN_DIR="${BIN_DIR:-${DEFAULT_BIN_DIR}}"

MCP_DIST="${REPO_ROOT}/packages/mcp/dist/index.js"
INSTALL_PATH="${BIN_DIR}/${COMMAND_NAME}"

log() {
    printf '[hitmux-install] %s\n' "$*"
}

fail() {
    printf '[hitmux-install] ERROR: %s\n' "$*" >&2
    exit 1
}

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

check_versions() {
    need_cmd node
    need_cmd pnpm

    local node_major
    node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
    if (( node_major < 20 )); then
        fail "Node.js >= 20 is required. Current version: $(node --version)"
    fi

    local pnpm_major
    pnpm_major="$(pnpm --version | awk -F. '{print $1}')"
    if (( pnpm_major < 10 )); then
        fail "pnpm >= 10 is required. Current version: $(pnpm --version)"
    fi
}

create_wrapper() {
    local wrapper_file="$1"

    cat > "${wrapper_file}" <<EOF
#!/usr/bin/env sh
exec node "${MCP_DIST}" "\$@"
EOF
    chmod 0755 "${wrapper_file}"
}

main() {
    cd "${REPO_ROOT}"

    log "Repository: ${REPO_ROOT}"
    check_versions

    log "Installing workspace dependencies"
    pnpm install --frozen-lockfile

    log "Building ${PACKAGE_NAME} and dependencies"
    pnpm --filter "${PACKAGE_NAME}..." build

    [[ -f "${MCP_DIST}" ]] || fail "Build output not found: ${MCP_DIST}"
    chmod 0755 "${MCP_DIST}"

    local wrapper_file
    wrapper_file="$(mktemp)"
    create_wrapper "${wrapper_file}"

    log "Installing ${INSTALL_SCOPE} command: ${INSTALL_PATH}"
    if ! install -d -m 0755 "${BIN_DIR}"; then
        fail "Cannot create install directory: ${BIN_DIR}. Run with sudo for global install or set BIN_DIR to a writable directory."
    fi
    if ! install -m 0755 "${wrapper_file}" "${INSTALL_PATH}"; then
        fail "Cannot install command to: ${INSTALL_PATH}. Run with sudo for global install or set BIN_DIR to a writable directory."
    fi
    rm -f "${wrapper_file}"

    log "Installed. Use this MCP command in clients: ${COMMAND_NAME}"
    if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
        log "Note: ${BIN_DIR} is not on PATH. Add it to PATH or use the full command path: ${INSTALL_PATH}"
    fi
    log "Example: claude mcp add hitmux-context-engine -- ${COMMAND_NAME}"
    log "Example: codex mcp add hitmux-context-engine -- ${COMMAND_NAME}"
}

main "$@"
