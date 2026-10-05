# Deploy runbook (~10 minutes, once)

You need Node 18+ and a free Cloudflare account.

## 1. Relay (Cloudflare, free)

```bash
cd backend
npm install
npx wrangler login                     # opens the browser
openssl rand -hex 16                   # copy this: it's your TEAM_TOKEN
npx wrangler secret put TEAM_TOKEN     # paste the token
npx wrangler deploy                    # prints https://hybrid-audio-relay.<account>.workers.dev
```

Check: open `https://hybrid-audio-relay.<account>.workers.dev/health`. It should say `ok`.

## 2. Build the team copy of the extension

From the repo root:

```bash
node tools/package-extension.mjs --url https://hybrid-audio-relay.<account>.workers.dev --token <TEAM_TOKEN>
```

This creates `dist/hybrid-audio/` and `dist/hybrid-audio.zip` with the relay URL and token baked in.
- `dist/` is git-ignored. **Share the zip only with the team** (for example, a private Drive folder). It contains the token.

## 3. Install on each in-room laptop (1 minute each)

1. Unzip `hybrid-audio.zip`.
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the `hybrid-audio` folder.
3. Pin the extension (puzzle icon → pin).

To update later, rebuild the zip, replace the folder, and click ↻ on the extension card.

## 4. Use

In a Meet call, click the extension → **Join room audio**. That's all. The first laptop to join is the Hub, the only speaker.
- To make a louder laptop the Hub, click **Make this the Hub** on it.

## 5. First real meeting

Run section **M1** of [`TEST_CHECKLIST.md`](./TEST_CHECKLIST.md) (10 minutes), then the rest as time allows. Send back the Debug → **Copy log** files.

## Operations

| Task | How |
|---|---|
| Rotate the token | `npx wrangler secret put TEAM_TOKEN`, rebuild the zip, reinstall |
| Change the daily cap (team minutes/day, default 240) | Edit `MAX_MINUTES_PER_DAY` in `backend/wrangler.toml`, then `npx wrangler deploy` |
| Check usage | Cloudflare dashboard → Workers → hybrid-audio-relay → Metrics |
| Live logs | `cd backend && npx wrangler tail` |
| Run the relay without Cloudflare | `cd backend && TEAM_TOKEN=<token> PORT=8787 node dev-server.js`, and use `ws://<host>:8787` |
