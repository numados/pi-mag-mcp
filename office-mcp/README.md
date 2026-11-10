# office-mcp

A Pi-specific MCP server exposing two PDF tools over stdio: build a PDF from
images, and clean up an existing PDF.

It touches no remote service and needs no credentials. Everything happens
locally through installed binaries, and every answer says in a machine-readable
way what happened.

## Tools

| Tool | What it does |
| --- | --- |
| `create_pdf` | One compressed PDF from images via ImageMagick |
| `pdf_clean` | `auto` / `grayscale` / `bw` / `clean-scan` / `ocr` / `optimize` / `info` |

## Contract

Both tools advertise an input schema and an output schema. Invalid arguments are
rejected as protocol errors before any filesystem or subprocess work: wrong
types, empty paths, unknown fields, out-of-range numbers and unknown enum values
are never silently coerced.

Every result carries `status`, `reason` and `notes`:

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `unavailable` or `cancelled` |
| `reason` | structured cause (`conflict`, `missing-tools`, `timeout`, `busy`, …) or `null` |
| `notes` | one actionable sentence per confirmed cause |

`isError` is set only for `unavailable` and `cancelled`.

## Write safety

Both tools write files, so they are not read-only and `pdf_clean` is marked
destructive. Three rules are enforced server-side, not by convention:

- the input file is never overwritten — an output path equal to the input is
  refused;
- an existing output is refused unless `overwrite: true` is passed explicitly;
- each job writes a unique temporary file next to the target and publishes it
  only after it exists and is non-empty: a hard link when not overwriting (which
  fails atomically if the target appeared meanwhile) and a rename when
  `overwrite: true` was passed.

A failed, cancelled or timed-out job leaves no partial output and no temporary
file. The non-overwriting publish needs hard-link support on the destination
filesystem; where it is unavailable the job reports the failure instead of
falling back to an overwrite.

At most 2 PDF jobs run at once; further calls get an honest `busy` reason. Image
expansion is capped at 500 pages per job.

## Local toolchain

```bash
brew install imagemagick ghostscript ocrmypdf poppler
```

Each operation reports its own missing dependency with the install command
instead of failing mid-run:

| Operation | Requires |
| --- | --- |
| `create_pdf`, `bw` | ImageMagick (+ ghostscript for the PDF delegate) |
| `grayscale`, `optimize` | ghostscript |
| `clean-scan`, `ocr` | OCRmyPDF |
| `info`, `auto` | poppler (`pdfinfo`, `pdffonts`) |

`clean-scan` does not pass `--remove-background` (unimplemented in current
OCRmyPDF builds); use `bw` when the background must become white.

`auto` inspects first and refuses to guess: if the inspection cannot complete, it
returns `unavailable` rather than applying a cleanup to the wrong document type.

Relative paths resolve against the server process cwd, which Pi sets to the
session directory.

## Limits

| Limit | Value |
| --- | --- |
| inputs per `create_pdf` call | 200 |
| expanded images per job | 500 |
| remote response bodies | none — this server makes no requests |
| `create_pdf` runtime | 5 min |
| `pdf_clean` runtime | 9 min |
| concurrent PDF jobs | 2 |
| subprocess output | 16 MB per stream |

## Install

From the repository root:

```bash
./install.sh list                  # readiness report; changes nothing
./install.sh office --dry-run      # show the plan; changes nothing
./install.sh office                # npm ci, build, test, register
```

`office` registers with `timeout: 600` and `exposure: codemode` by default. The
merge preserves fields the script does not own (`enabled`, `toolExposure`, an
existing custom `timeout`, unrelated `env` keys) and backs the file up first. A
`timeout` already present in the entry is never overwritten.

Register by hand instead:

```jsonc
// ~/.pi/agent/mcp.json → mcpServers
{
  "office": {
    "command": "/opt/homebrew/bin/node",
    "args": ["/absolute/path/to/pi-mag-mcp/office-mcp/dist/server.js"],
    "timeout": 600,
    "exposure": "codemode",
    "description": "office: create_pdf from images, pdf_clean (grayscale/bw/clean-scan/ocr/optimize/info)"
  }
}
```

Do not set `cwd`: relative PDF paths must keep resolving against the Pi session
directory.

## Trust boundary

The server makes no network calls and holds no secrets. It runs local binaries
with an allowlisted child environment (`PATH`, `HOME`, locale, temp and proxy
variables), so a tool cannot read unrelated credentials from the server
environment. Arguments are passed as an argv array with no shell, so a filename
cannot become a command.

File paths are whatever the caller names: this is a local file tool, not a
sandbox. It refuses to overwrite, but it will read and write anywhere the Pi
process may.

## Tests

```bash
npm test           # build + contract, subprocess, PDF and Pi-client tests
```

The Pi-client test drives the real `McpClient` from the installed Pi over stdio:
two advertised tools, argument rejection, a structured `not-found` and an
overwrite refusal. Set `PI_MCP_ROOT` when Pi lives somewhere unusual; the test
skips with a message if it cannot find Pi at all.

No test runs OCR. The one real conversion uses a 1×1 PNG in a temporary
directory and degrades to an honest `missing-tools` check when ImageMagick is
absent.

## Design notes

- `src/contract.ts` is the only owner of schemas, limits, enums and the failure
  vocabulary; the advertised schemas, runtime validation and output schemas all
  derive from it.
- `src/subprocess.ts` owns argv-only execution, the child environment allowlist,
  output caps and process-group termination.
- `src/pdf.ts` owns both tools and the publish rules; `src/render.ts` is the only
  text projection.
- `src/server.ts` registers the tools with `McpServer`/`serveStdio`, validates
  each output against its own schema before sending it, and keeps stdout
  protocol-only.
