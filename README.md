# web-tty

A real, working terminal in your browser. A small Node.js server spawns an
actual shell process (`node-pty`) and streams it over a WebSocket to
[xterm.js](https://xtermjs.org/) running in the page. Type in the browser,
it runs on the host — same idea as [ttyd](https://github.com/tsl0922/ttyd) or
[GoTTY](https://github.com/yudai/gotty), rebuilt from scratch in JS so it's
easy to read, fork, and extend.

![status](https://img.shields.io/badge/status-personal--project-f2a541)

## ⚠️ Read this before you run it

**This gives whoever logs in a real shell on the machine it runs on.** That's
the entire point, and also the entire risk. Treat it accordingly:

- Set a long, random `TTY_PASSWORD` (`.env.example` has the field — 20+
  random characters, not a word you'd remember).
- Don't expose it directly to the open internet. Put it behind a VPN, an SSH
  tunnel, or a reverse proxy with its own auth layer if you need remote
  access.
- Run it as a low-privilege user, not root, unless you specifically want
  root-in-a-browser.
- The login page is served over plain HTTP by default. Terminate TLS in
  front of it (Caddy, nginx, Cloudflare Tunnel) before putting it anywhere
  reachable outside `localhost`.
- The built-in auth (single shared password, in-memory session tokens,
  simple per-IP rate limiting) is enough for a personal tool, not a
  multi-tenant or production auth system.

If any of that is unfamiliar, that's a good reason to start by running this
only on `localhost` while you get comfortable with it.

## How it works

```
 browser (xterm.js)  <-- WebSocket -->  server.js  <-- pty -->  real shell
        |                                  |
        +-- POST /login (password) -->  issues an httpOnly session cookie
```

- `server.js` — Express app for the login flow + static files, plus a raw
  `ws` WebSocket server on `/pty`. Every WebSocket connection spawns its own
  shell via `node-pty` and pipes data in both directions. Terminal resize
  events are sent as small JSON control messages alongside raw keystroke
  data.
- `public/` — the frontend: a login page styled as a boot sequence + shell
  prompt, and the terminal page itself (xterm.js loaded from a CDN, no build
  step).
- Auth is a single shared password (`TTY_PASSWORD`) checked with a
  timing-safe comparison, backed by random session tokens kept in memory
  with a 12-hour expiry. Login attempts are rate-limited per IP.

## Setup

Requires Node 18+. `node-pty` compiles a small native addon on install, so
you'll also need a C++ toolchain:

- **macOS**: `xcode-select --install`
- **Debian/Ubuntu**: `sudo apt-get install -y python3 make g++`
- **Windows**: install the "Desktop development with C++" workload via
  Visual Studio Build Tools, or run this inside WSL instead.

```bash
git clone https://github.com/kazim-45/Drago-tty.git
cd Drago-tty
cp .env.example .env
# edit .env and set TTY_PASSWORD to something long and random
npm install
npm start
```

Then open `http://localhost:3000`.

### Docker

The native build tools live inside the image, so this sidesteps local
toolchain setup:

```bash
cp .env.example .env   # set TTY_PASSWORD
docker compose up --build
```

## Configuration

All via `.env` (see `.env.example`):

| Variable                | Default                 | Purpose                                    |
|--------------------------|--------------------------|---------------------------------------------|
| `TTY_PASSWORD`           | *(required, 8+ chars)*  | Password gating access to a session          |
| `PORT`                   | `3000`                  | HTTP/WebSocket port                          |
| `TTY_SHELL`              | `$SHELL` / PowerShell   | Shell binary spawned per session             |
| `TTY_CWD`                | `$HOME`                 | Working directory a new session starts in    |
| `MAX_CONCURRENT_SESSIONS`| `5`                     | Caps simultaneous shells (basic DoS guard)   |

## Extending it

Ideas if you want to take this further:

- Swap the single shared password for per-user accounts + TOTP.
- Add a session list / kill-switch UI so you can see and end active shells.
- Log commands for audit purposes (careful: that's also everything typed,
  including anything sensitive).
- Multiplex multiple terminal tabs over one WebSocket connection.
- Add reconnection with scrollback replay (currently a reconnect gets a
  fresh shell, not the old one's output history).

## License

MIT — do whatever you want with it, just keep the security warnings in mind
for anyone else who ends up running it.
