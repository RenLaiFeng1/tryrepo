# tryrepo

**Paste a GitHub URL. Your own coding agent gets the project running in a local Docker sandbox.**

```bash
npx tryrepo owner/repo --open
```

tryrepo clones the repository into a fresh Docker container and hands it to a coding agent (Claude Code, or any
OpenAI-compatible model). The agent reads the README and manifests, installs what is needed, writes a start script,
and has to prove the app answers HTTP after a clean restart before it may report success. Web apps open on
`http://127.0.0.1:<port>`; command-line projects get a shell inside the sandbox.

The finished container is saved as a local image, so running the same repository again starts in seconds without
the agent.

> Status: early (v0.1). Expect projects that don't work yet; `tryrepo bench` measures how many do.

## Requirements

- Docker Desktop or Docker Engine, running
- Node.js 20+
- One agent:
  - [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on PATH), or
  - an OpenAI-compatible API: `OPENAI_API_KEY`, plus `--model` (or `OPENAI_MODEL`) and optionally `--base-url`

## Usage

```bash
tryrepo <repo> [options]      set up (or reuse) a sandbox for <repo> and start it
tryrepo list                  saved builds and running containers
tryrepo stop [name] [--all]   stop running apps
tryrepo rm <repo> | --all     delete saved builds
tryrepo bench <file>          set up every repo listed in <file> and report which ones work
```

`<repo>` can be `owner/repo`, `owner/repo#ref`, a GitHub URL (including `/tree/<ref>/<dir>` links), another
https git URL, or a local `./directory` (copied into the sandbox, never mounted).

| Option | |
|---|---|
| `--agent claude\|openai` | default: `claude` if installed, otherwise `openai` |
| `--model <name>` | model for the agent |
| `--base-url <url>` | OpenAI-compatible endpoint (default `OPENAI_BASE_URL` or api.openai.com) |
| `-e, --env NAME[=VALUE]` | pass a variable into the sandbox (see Security) |
| `--ref <ref>` | branch, tag or commit |
| `--port <n>` | host port for web apps (default: random free port) |
| `--open` | open the app in the browser |
| `-d, --detach` | leave the app running in the background |
| `--refresh` | ignore the saved build and set up again |
| `--timeout <min>` | agent time budget, default 30 |
| `--memory <size>` | sandbox memory limit, default 75% of Docker's memory (max 8g) |
| `--image <image>` | base image, default `node:22-bookworm` |
| `--keep` | keep the build container for debugging |
| `--json` | machine-readable result on stdout (implies `--detach`) |

Examples:

```bash
tryrepo some/ai-app -e OPENAI_API_KEY          # value taken from your environment
tryrepo owner/repo --agent openai --base-url https://api.deepseek.com/v1 --model <model>
tryrepo bench repos.txt --parallel 2           # one repo per line
```

## How it works

1. A container starts from the base image (Debian 12 with Node 22, Python 3.11, git and build tools) with a memory
   and process limit. The repository is cloned inside it.
2. The agent gets six tools, all of which act only inside that container: `exec`, `start_background`, `write_file`,
   `verify_start`, `report_success`, `report_failure`.
3. For web apps the agent writes `/tryrepo/start.sh`. `verify_start` kills every process in the container, runs the
   script, and polls the app on the container's network address, which catches servers that only listen on localhost.
   A web app can't be reported as working until this passes.
4. tryrepo saves the container as an image, starts it with the port published on `127.0.0.1`, and checks it again
   from your machine before printing the URL.

With Claude Code, tryrepo runs `claude -p` with built-in tools disabled (`--tools ""`), only tryrepo's MCP server
(`--strict-mcp-config`), and `--permission-mode dontAsk`. The MCP server forwards calls over a token-protected
loopback socket to the tryrepo process, which owns the container.

## Security

- The project's code runs only inside the container. No host directory is mounted, and published ports are bound
  to `127.0.0.1`.
- The agent process runs on your machine, but its only tools are the sandbox tools above. It can't read your files
  or run commands on your host.
- Your agent's own credentials (Claude Code login, `OPENAI_API_KEY` for `--agent openai`) are not passed into the
  container.
- Values you pass with `-e` **do** go into the sandbox, where the project's code can read them. Only pass keys you
  would give that project anyway.
- Command output from the sandbox becomes part of the agent conversation, so it is sent to your model provider.
- Docker is not a perfect security boundary. Containers have internet access, and on Docker Desktop they can reach
  services on your host through `host.docker.internal`. Don't use tryrepo on code you believe is malicious.

## Limitations

- No GPU, desktop GUI, mobile emulator or Docker-in-Docker. The agent reports these projects as "unsupported".
- Public repositories only (nothing is configured to authenticate the clone).
- The first run downloads the base image, which can take a long time on slow connections.
- Saved builds are full container snapshots and can be large. `tryrepo list` shows them; `tryrepo rm` deletes them.

## Files

Everything lives in `~/.tryrepo` (override with `TRYREPO_HOME`): `recipes/` (saved builds), `runs/` (prompt, tool-call
log and result of every setup), `agent/` (working directory for agent sessions).

## License

MIT
