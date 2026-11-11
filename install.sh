#!/usr/bin/env bash
#
# Build and register pi-mag-mcp servers with Pi.
#
#   ./install.sh list                 # readiness report; changes nothing
#   ./install.sh web-search           # build, test, register
#   ./install.sh web-search --dry-run # print the plan; changes nothing
#   ./install.sh web-search --no-pi   # build and test only
#   ./install.sh --help
#
# An explicit server name is always required. Without it nothing is built and
# nothing is written: a bare invocation must never install whatever happens to
# be in the repository.
#
# Registration merges into ~/.pi/agent/mcp.json instead of replacing an entry,
# so fields this script does not own (timeout, enabled, toolExposure, extra env)
# survive a re-run. A timestamped backup is written before the file is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
MCP_JSON="${PI_MCP_JSON:-$HOME/.pi/agent/mcp.json}"

DRY_RUN=false
REGISTER=true
EXPOSURE=""
ENV_PAIRS=()
TARGET=""
LOCAL=false
SKIP_BUILD=false
REPO_PATH=""
INSTALLATION=""

# --------------------------------------------------------------- server registry
# One line per server: name|directory|description|timeout|toolExpose. The
# description drives Pi's tool search and the system-prompt summary, so it states
# what the server offers rather than repeating its name. The timeout is a default
# seeded only into a new entry; a timeout already present in mcp.json is never
# overridden. The optional fifth field lists per-tool exposure as
# `tool:mode,tool:mode` and is merged into the entry's `toolExposure`, so the
# tools a server means to expose directly survive a fresh install.
REGISTRY=(
  "web-search|web-search-mcp|web_search: DuckDuckGo free by default, Tavily deep mode only on explicit quota opt-in; structured results with provenance and explicit failure status||"
  "office|office-mcp|office: create_pdf from images and pdf_clean (grayscale/bw/clean-scan/ocr/optimize/info); local files only, explicit failure causes and no silent overwrite|600|"
  "teams|teams-mcp|teams_message: one Teams channel message by share URL, browser token or Azure CLI fallback, structured failure causes|120|"
  "knowledge|knowledge-mcp|knowledge: Obsidian-style Markdown vault owner — one source may span several directories, qmd BM25→rg search, bounded read, link graph, two-phase validated writes with format/convention checks, plus the numados-task-* workspace protocol; status/doctor report readiness and setup creates the config|120|knowledge_status:direct,knowledge_search:direct,knowledge_read:direct,knowledge_task:direct"
  "search|search-mcp|search: local search router — text, files, structure, docs, semantic, machine and crossrepo over swappable providers (rg, fd, mdfind, ast-grep, rga, auggie, serena, zoekt) with ordered fallback, availability probing and a doctor report; hits are untrusted file content||search:direct,providers:direct"
  "devwork|devwork-mcp|devwork: work items and pull requests across GitHub, Jira Cloud and Azure DevOps behind one routing table; one installation per repository binds credentials, scope and write policy, reads are direct and every write returns a preview first|120|devwork_status:direct,devwork_get:direct,devwork_query:direct"
  "repo|repo-mcp|repo: explicit Git tools — read checks, fetch/pull --ff-only, staged-only commit with a size preflight, token-bound previews for branch/merge/rebase/reset/restore/switch/clean, and branch/commit generation; no push/send-pack tool exists|300|"
)

server_field() { # server_field <name> <1|2|3|4|5>
  local entry
  for entry in "${REGISTRY[@]}"; do
    IFS='|' read -r name _dir _desc _timeout _tool_expose <<<"$entry"
    if [ "$name" = "$1" ]; then
      case "$2" in
        2) printf '%s' "$_dir" ;;
        3) printf '%s' "$_desc" ;;
        4) printf '%s' "$_timeout" ;;
        5) printf '%s' "$_tool_expose" ;;
      esac
      return 0
    fi
  done
  return 1
}

server_names() {
  local entry
  for entry in "${REGISTRY[@]}"; do printf '%s\n' "${entry%%|*}"; done
}

usage() {
  cat <<'EOF'
Usage:
  ./install.sh list [--json]        readiness report, changes nothing
  ./install.sh <server> [options]   build and register one server
  ./install.sh devwork --local --repo <path> --installation <id>
                                    register devwork for one repository only

Options:
  --dry-run             print what would happen; write nothing
  --no-pi               build and test only, skip Pi registration
  --exposure <mode>     codemode (default), deferred, direct or hidden
  --env <KEY=VALUE>     extra environment entry for the server (repeatable)
  --local               project-scoped registration (devwork only)
  --repo <path>         repository root for --local
  --installation <id>   installation profile name for --local
  --skip-build          reuse an existing dist/ instead of building (tests)
  -h, --help            this message

Servers: see ./install.sh list

Environment:
  PI_MCP_JSON           registration file, default ~/.pi/agent/mcp.json
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# ------------------------------------------------------------------- commands
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --dry-run) DRY_RUN=true; shift ;;
      --no-pi) REGISTER=false; shift ;;
      --exposure)
        [ "$#" -ge 2 ] || die "--exposure needs a value"
        EXPOSURE="$2"; shift 2 ;;
      --env)
        [ "$#" -ge 2 ] || die "--env needs KEY=VALUE"
        case "$2" in *=*) ENV_PAIRS+=("$2") ;; *) die "--env expects KEY=VALUE, got '$2'" ;; esac
        shift 2 ;;
      --local) LOCAL=true; shift ;;
      --skip-build) SKIP_BUILD=true; shift ;;
      --repo)
        [ "$#" -ge 2 ] || die "--repo needs a path"
        REPO_PATH="$2"; shift 2 ;;
      --installation)
        [ "$#" -ge 2 ] || die "--installation needs an id"
        INSTALLATION="$2"; shift 2 ;;
      -*) die "unknown option: $1 (see --help)" ;;
      *)
        [ -z "$TARGET" ] || die "only one server per run; got '$TARGET' and '$1'"
        TARGET="$1"; shift ;;
    esac
  done
}

require_known_server() {
  server_field "$TARGET" 2 >/dev/null 2>&1 \
    || die "unknown server: $TARGET (available: $(server_names | paste -sd ' ' -))"
}

read_engines_node() { # read_engines_node <package.json>
  jq -r '.engines.node // empty' "$1" 2>/dev/null || true
}

check_node() { # check_node <server-dir>
  command -v node >/dev/null 2>&1 \
    || die "node is not installed; Pi needs it to run the server"

  local required minimum actual
  required="$(read_engines_node "$ROOT/$1/package.json")"
  actual="$(node -p 'process.versions.node.split(".")[0]')"

  # Honor a ">=N" engines constraint; ignore forms this script cannot parse
  # rather than guessing at their meaning.
  case "$required" in
    ">= "*|">="*)
      minimum="${required#>=}"
      minimum="${minimum# }"
      minimum="${minimum%%.*}"
      case "$minimum" in
        ''|*[!0-9]*) : ;;
        *) [ "$actual" -ge "$minimum" ] \
             || die "node $required required (found $(node --version))" ;;
      esac
      ;;
  esac

  note "node $(node --version)"
}

# The entry's server path, so a stale registration can be told apart from a
# current one. Read from args[0]; a command-only entry yields nothing.
registered_path() { # registered_path <name>
  [ -f "$MCP_JSON" ] || return 1
  jq -r --arg n "$1" '.mcpServers[$n].args[0] // empty' "$MCP_JSON" 2>/dev/null
}

cmd_list() {
  local want_json=false
  [ "${1:-}" = "--json" ] && want_json=true

  local rows=() name dir entry_path built deps registered exposure note status=0
  for name in $(server_names); do
    dir="$(server_field "$name" 2)"
    entry_path="$ROOT/$dir/dist/server.js"
    [ -d "$ROOT/$dir/node_modules" ] && deps="ok" || deps="missing"
    [ -f "$entry_path" ] && built="ok" || built="missing"

    exposure="-"
    note="-"
    registered="no"
    if [ -f "$MCP_JSON" ] && ! jq -e . "$MCP_JSON" >/dev/null 2>&1; then
      registered="invalid-json"
      note="$MCP_JSON is not valid JSON"
      status=1
    elif jq -e --arg n "$name" '.mcpServers[$n] != null' "$MCP_JSON" >/dev/null 2>&1; then
      registered="yes"
      exposure="$(jq -r --arg n "$name" '.mcpServers[$n].exposure // "codemode"' "$MCP_JSON")"
      local registered_args0
      registered_args0="$(registered_path "$name")"
      if [ -n "$registered_args0" ] && [ "$registered_args0" != "$entry_path" ]; then
        note="stale path: $registered_args0"
        status=1
      elif [ ! -f "$entry_path" ]; then
        note="registered but not built"
        status=1
      fi
    else
      note="not registered"
    fi

    rows+=("$(printf '%s\t%s\t%s\t%s\t%s\t%s' "$name" "$deps" "$built" "$registered" "$exposure" "$note")")
  done

  if [ "$want_json" = true ]; then
    printf '%s\n' "${rows[@]}" | jq -R -s -c '
      split("\n") | map(select(length > 0) | split("\t") |
        {server: .[0], deps: .[1], build: .[2], registered: .[3], exposure: .[4], note: .[5]})'
    return "$status"
  fi

  printf '%-14s %-8s %-8s %-12s %-10s %s\n' SERVER DEPS BUILD REGISTERED EXPOSURE NOTE
  printf '%s\n' "${rows[@]}" | while IFS=$'\t' read -r name deps built registered exposure note; do
    printf '%-14s %-8s %-8s %-12s %-10s %s\n' "$name" "$deps" "$built" "$registered" "$exposure" "$note"
  done

  # Machine requirements: the server owns the table (requirements.json) and the
  # verdict rules, so `list` asks its own doctor instead of restating them in
  # bash. A server that is not built yet has nothing to ask.
  local req_name req_dir report
  for req_name in $(server_names); do
    req_dir="$(server_field "$req_name" 2)"
    [ -f "$ROOT/$req_dir/requirements.json" ] || continue
    printf '\nrequirements (%s):\n' "$req_name"
    if [ -f "$ROOT/$req_dir/dist/server.js" ]; then
      # A non-zero exit means a required binary is missing; the report is still valid.
      report="$(cd "$ROOT/$req_dir" && node dist/server.js --doctor 2>/dev/null)" || true
      printf '%s\n' "$report" | sed 's/^/  /'
    else
      printf '  not built yet — build it to see the machine report\n'
    fi
    print_setup_hint "$req_dir"
  done

  printf '\nregistration file: %s\n' "$MCP_JSON"
  return "$status"
}

# A server may declare a one-time configuration step in requirements.json
# (`setup: {command, reason}`). The installer never runs it: it prints the
# command so the configuration stays an explicit, reversible act.
print_setup_hint() { # print_setup_hint <directory>
  local file="$ROOT/$1/requirements.json" command reason
  [ -f "$file" ] || return 0
  command="$(jq -r '.setup.command // empty' "$file" 2>/dev/null)"
  [ -n "$command" ] || return 0
  reason="$(jq -r '.setup.reason // empty' "$file" 2>/dev/null)"
  printf '\nnext (%s): %s\n' "$1" "$command"
  [ -n "$reason" ] && printf '  %s\n' "$reason"
}

build_env_json() {
  [ "${#ENV_PAIRS[@]}" -eq 0 ] && { printf 'null'; return 0; }
  local pair
  for pair in "${ENV_PAIRS[@]}"; do printf '%s\n' "$pair"; done \
    | jq -R -s 'split("\n") | map(select(length > 0)) |
        reduce .[] as $pair ({}; ($pair | index("=")) as $at |
          .[$pair[0:$at]] = $pair[$at + 1:])'
}

# `tool:mode,tool:mode` from the registry -> {"tool":"mode",...} or null.
build_tool_exposure_json() { # build_tool_exposure_json <csv>
  [ -z "${1:-}" ] && { printf 'null'; return 0; }
  printf '%s\n' "$1" | tr ',' '\n' \
    | jq -R -s 'split("\n") | map(select(length > 0)) |
        reduce .[] as $pair ({}; ($pair | index(":")) as $at |
          if $at == null then . else .[$pair[0:$at]] = $pair[$at + 1:] end)'
}

cmd_install() {
  if [ "$LOCAL" = true ]; then cmd_install_local; return 0; fi
  require_known_server
  # devwork serves one installation per repository. A user-level entry would
  # have no installation and therefore no tools, so refuse instead of writing a
  # misleading registration.
  if [ "$TARGET" = "devwork" ] && [ "$REGISTER" = true ]; then
    die "devwork is installation-scoped: run ./install.sh devwork --local --repo <repository root> --installation <id> (or add --no-pi to only build it)"
  fi
  local dir desc timeout tool_expose package entry_path node_bin
  dir="$(server_field "$TARGET" 2)"
  desc="$(server_field "$TARGET" 3)"
  timeout="$(server_field "$TARGET" 4)"
  tool_expose="$(server_field "$TARGET" 5)"
  package="$ROOT/$dir/package.json"
  entry_path="$ROOT/$dir/dist/server.js"
  node_bin="$(command -v node || true)"

  [ -f "$package" ] || die "missing $package"
  [ -n "$EXPOSURE" ] || EXPOSURE="codemode"
  case "$EXPOSURE" in codemode|deferred|direct|hidden) ;; *) die "--exposure must be codemode, deferred, direct or hidden" ;; esac

  step "plan"
  note "server: $TARGET ($dir)"
  note "entry:  $entry_path"
  note "pi:     $MCP_JSON"
  note "exposure: $EXPOSURE"
  [ -n "$tool_expose" ] && note "tool exposure: $tool_expose (merged, other tools untouched)"
  [ "${#ENV_PAIRS[@]}" -gt 0 ] && note "env:    $(printf '%s\n' "${ENV_PAIRS[@]}" | cut -d= -f1 | paste -sd ',' -) (values not shown)"
  [ -n "$timeout" ] && note "timeout: ${timeout}s (seed for a new entry only)"

  local previous_path=""
  previous_path="$(registered_path "$TARGET" || true)"
  if [ -n "$previous_path" ] && [ "$previous_path" != "$entry_path" ]; then
    note "note: replaces a registration pointing at $previous_path"
  fi

  if [ "$DRY_RUN" = true ]; then
    step "dry run — nothing is built, tested or written"
    note "would run: npm ci && npm run build && npm test in $dir"
    [ "$REGISTER" = true ] && note "would merge the entry into $MCP_JSON (backup first)"
    [ "$REGISTER" = false ] && note "would skip registration (--no-pi)"
    print_setup_hint "$dir"
    return 0
  fi

  step "toolchain"
  check_node "$dir"
  command -v jq >/dev/null 2>&1 || die "jq is required to merge the registration safely (brew install jq)"

  step "install dependencies ($dir)"
  # Always from the lockfile: an existing node_modules does not prove it matches.
  ( cd "$ROOT/$dir" && npm ci --ignore-scripts )

  step "build"
  ( cd "$ROOT/$dir" && npm run build )
  [ -f "$entry_path" ] || die "build did not produce $entry_path"

  step "test"
  # Registration is gated on the tests: a successful compile does not prove the
  # server speaks MCP and still behaves as documented.
  ( cd "$ROOT/$dir" && npm test )

  if [ "$REGISTER" != true ]; then
    print_setup_hint "$dir"
    step "done"
    note "registration skipped (--no-pi)"
    return 0
  fi

  register "$TARGET" "$desc" "$node_bin" "$entry_path" "$timeout" "$tool_expose"
  print_setup_hint "$dir"
}

# ------------------------------------------------------------ local (devwork)
# devwork serves one installation per repository: the profile carries endpoints,
# scope and write policy, the repository only selects it. This mode therefore
# writes <repo>/.pi/mcp.json and never touches the user-level file.
cmd_install_local() {
  [ "$TARGET" = "devwork" ] || die "--local is supported for devwork only (it is the installation-scoped server)"
  [ -n "$REPO_PATH" ] || die "--local needs --repo <repository root>"
  [ -n "$INSTALLATION" ] || die "--local needs --installation <id> (the profile name for this repository)"

  local repo dir desc entry_path profile_dir profile node_bin
  repo="$(cd "$REPO_PATH" 2>/dev/null && pwd -P)" || die "no such directory: $REPO_PATH"
  dir="$(server_field devwork 2)" || die "devwork is missing from the registry"
  desc="$(server_field devwork 3)"
  entry_path="$ROOT/$dir/dist/server.js"
  profile_dir="${XDG_CONFIG_HOME:-$HOME/.config}/devwork-mcp/installations"
  profile="$profile_dir/$INSTALLATION.json"
  node_bin="$(command -v node || true)"

  step "local plan"
  note "repository:   $repo"
  note "server:       devwork ($dir)"
  note "entry:        $entry_path"
  note "profile:      $profile (mode 600, excluded from the repository)"
  note "project file: $repo/.pi/mcp.json (a full entry; the user-level mcp.json is not touched)"
  note "environment:  DEVWORK_INSTALLATION=$INSTALLATION"

  if [ "$DRY_RUN" = true ]; then
    step "dry run — nothing is built, tested or written"
    [ "$SKIP_BUILD" = true ] && note "would reuse $entry_path (--skip-build)" || note "would run: npm ci && npm run build && npm test in $dir"
    [ -f "$profile" ] && note "profile exists, would be left untouched" || note "would create the profile from installation.example.json"
    note "would merge the devwork entry into $repo/.pi/mcp.json (backup first)"
    return 0
  fi

  if [ "$SKIP_BUILD" != true ]; then
    step "toolchain"
    check_node "$dir"
    step "install dependencies ($dir)"
    ( cd "$ROOT/$dir" && npm ci --ignore-scripts )
    step "build"
    ( cd "$ROOT/$dir" && npm run build )
    step "test"
    ( cd "$ROOT/$dir" && npm test )
  fi
  [ -f "$entry_path" ] || die "missing $entry_path — build it first or drop --skip-build"
  command -v jq >/dev/null 2>&1 || die "jq is required to write the profile and the registration safely (brew install jq)"

  step "installation profile"
  if [ -f "$profile" ]; then
    local mode
    mode="$(stat -f %Lp "$profile" 2>/dev/null || stat -c %a "$profile" 2>/dev/null || true)"
    note "exists (left untouched): $profile"
    # The profile is the credential boundary: the server refuses a group- or
    # world-readable file, so say it here instead of at the first tool call.
    case "$mode" in
      ""|600|400) : ;;
      *) note "WARNING: mode is $mode — the server refuses it; run: chmod 600 $profile" ;;
    esac
  else
    mkdir -p "$profile_dir"
    jq --arg id "$INSTALLATION" --arg root "$repo" \
       '.installationId = $id | .repositoryRoot = $root' \
       "$ROOT/$dir/installation.example.json" > "$profile" || die "could not write $profile"
    chmod 600 "$profile"
    note "written: $profile (mode 600)"
    note "fill it in: endpoints, allowed projects/repositories, write policy, credential references"
  fi

  step "project registration ($repo/.pi/mcp.json)"
  mkdir -p "$repo/.pi"
  local target="$repo/.pi/mcp.json" backup tmp
  if [ ! -f "$target" ]; then
    printf '{\n  "mcpServers": {}\n}\n' > "$target"
  fi
  jq -e . "$target" >/dev/null 2>&1 || die "$target is not valid JSON; fix it before registering (no changes made)"
  backup="$target.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$target" "$backup"
  note "backup: $backup"

  tmp="$(mktemp "$repo/.pi/.mcp.json.tmp.XXXXXX")"
  if ! jq --arg cmd "$node_bin" --arg path "$entry_path" --arg id "$INSTALLATION" --arg desc "$desc" '
        .mcpServers //= {} |
        .mcpServers["devwork"] = {
          command: $cmd,
          args: [$path],
          cwd: ".",
          env: { DEVWORK_INSTALLATION: $id },
          description: $desc,
          exposure: "codemode",
          timeout: 120,
          toolExposure: { devwork_status: "direct", devwork_get: "direct", devwork_query: "direct" }
        }
      ' "$target" >"$tmp"; then
    rm -f "$tmp"
    die "could not merge the entry; $target is unchanged"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$target"
  jq -e --arg path "$entry_path" '.mcpServers.devwork.args[0] == $path and .mcpServers.devwork.command != null' "$target" >/dev/null 2>&1 \
    || die "registration wrote an unexpected entry; restore $backup"
  note "devwork: registered for $repo (project scope)"

  step "done"
  note "the repository is now bound to installation \"$INSTALLATION\""
  note "set the variables the profile references, then run: pi mcp list"
  note "a repository without this entry gets no devwork tools at all"
}

register() { # register <name> <description> <node-bin> <entry-path> <timeout> <tool-expose>
  local name="$1" desc="$2" node_bin="$3" entry_path="$4" timeout="$5" tool_expose="${6:-}"
  step "Pi registration ($MCP_JSON)"

  local dir; dir="$(dirname "$MCP_JSON")"
  mkdir -p "$dir"

  if [ ! -f "$MCP_JSON" ]; then
    note "creating $MCP_JSON"
    printf '{\n  "mcpServers": {}\n}\n' > "$MCP_JSON"
    chmod 600 "$MCP_JSON"
  fi

  # A file we cannot parse is never overwritten: failing here loses nothing.
  jq -e . "$MCP_JSON" >/dev/null 2>&1 \
    || die "$MCP_JSON is not valid JSON; fix it before registering (no changes made)"

  local backup env_json tool_exposure_json tmp
  backup="$MCP_JSON.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$MCP_JSON" "$backup"
  note "backup: $backup"

  env_json="$(build_env_json)"
  tool_exposure_json="$(build_tool_exposure_json "$tool_expose")"

  tmp="$(mktemp "$dir/.mcp.json.tmp.XXXXXX")"
  if ! jq --arg n "$name" --arg cmd "$node_bin" --arg path "$entry_path" \
          --arg desc "$desc" --arg exposure "$EXPOSURE" --arg timeout "$timeout" \
          --argjson env "$env_json" --argjson toolExposure "$tool_exposure_json" '
        .mcpServers //= {} |
        .mcpServers[$n] = (
          ((.mcpServers[$n] // {}) + {
            command: $cmd,
            args: [$path],
            description: $desc,
            exposure: $exposure
          })
          | if ($timeout != "" and (.timeout == null)) then .timeout = ($timeout | tonumber) else . end
          | if $env == null then . else .env = ((.env // {}) + $env) end
          | if $toolExposure == null then . else .toolExposure = ((.toolExposure // {}) + $toolExposure) end
        )
      ' "$MCP_JSON" >"$tmp"; then
    rm -f "$tmp"
    die "could not merge the entry; $MCP_JSON is unchanged"
  fi

  chmod 600 "$tmp"
  mv "$tmp" "$MCP_JSON"

  # Verify the written file instead of trusting the merge.
  jq -e --arg n "$name" --arg path "$entry_path" \
     '.mcpServers[$n].args[0] == $path and .mcpServers[$n].command != null' \
     "$MCP_JSON" >/dev/null 2>&1 \
    || die "registration wrote an unexpected entry; restore $backup"

  note "$name: registered ($EXPOSURE) → $entry_path"

  step "done"
  note "start a new Pi session, or run /reload in a running one"
  note "check with: pi mcp list"
}

# ----------------------------------------------------------------------- main
[ "$#" -eq 0 ] && { usage; exit 2; }

case "$1" in
  list)
    shift
    cmd_list "$@"
    ;;
  *)
    parse_args "$@"
    [ -n "$TARGET" ] || { usage >&2; exit 2; }
    cmd_install
    ;;
esac
