# AGENTS.md

## Cursor Cloud specific instructions

### Product

Single Node.js app (**tg-durak-play**): a Russian-language 2-player **Durak** card game. One process serves the static client (`index.html`) and Socket.IO game logic on port **10000** (override with `PORT`). Game state is in-memory only; no database.

### Running the server

From the repo root:

```bash
npm start
```

Server binds `0.0.0.0`. Open `http://localhost:10000` (or `http://localhost:$PORT`).

Use a **tmux** session for a long-lived dev server (see cloud agent tmux conventions). Example session name: `durak-server`.

### Multiplayer / E2E testing

- Room IDs come from the URL hash (e.g. `http://localhost:10000#abc12`). Share the same hash with a second client.
- **Two separate browser contexts** are required for two players: a normal tab plus an **incognito** window, or two different browsers. Two tabs in the same non-incognito window often share one Socket.IO connection and both stay on “Ожидаем второго игрока...”.
- The client loads Socket.IO from `https://cdn.socket.io/4.7.5/socket.io.min.js`; outbound network is needed for that script in the browser.

### Lint / test / build

This repo has no lint, test, or build scripts—only `npm start` in `package.json`. Verify changes by running the server and exercising join + play with two clients, or a small Socket.IO client script against `http://localhost:10000`.

### Dependencies

- Install: `npm install` (see VM update script).
- `node-telegram-bot-api` is listed in `package.json` but is **not used** in the current codebase.
