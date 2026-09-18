# Discord Bot Starter

A five-bot Discord voice system using Node.js and discord.js. Every configured bot is controlled from the web dashboard.

## Setup

1. Revoke every token previously shared in chat and generate a new token for each bot.
2. Create a `.env` file by copying `.evn` (the app also accepts the existing `.evn` filename).
3. Create up to five separate bot applications in the Discord Developer Portal, reset each bot token, and fill in `DISCORD_TOKEN_1` through `DISCORD_TOKEN_5`. Never commit or share these tokens. Client IDs are not required for this bot runtime.
4. Set a private `WEB_ADMIN_KEY` for the voice-control dashboard. Leave `GUILD_ID` empty unless it is a real numeric server ID. The bot startup staggers gateway logins and retries temporary Discord connection failures automatically.
5. Install dependencies:

   ```powershell
   npm install
   ```

6. Start the bot:

   ```powershell
   npm start
   ```

For local testing, set `DISCORD_TOKEN_1` through `DISCORD_TOKEN_5` and `WEB_ADMIN_KEY` in `.env` (or `.evn`), then run `npm install` followed by `npm start`. Tokens must be the raw values from Discord Developer Portal; do not include `Bot ` and do not commit either environment file.

## Web controls

Open the dashboard at the service URL and log in with `WEB_ADMIN_KEY`. Select a server and voice channel, then use the web controls to join all bots, stop all audio, leave all bots, or play an uploaded audio file on all bots.

The bot needs the `View Channel`, `Connect`, and `Speak` permissions in the voice channel. All controls are available only in the web dashboard. Volume can be adjusted from `0%` to `1000%`; levels above `100%` may distort the audio.

## Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bb4357367-collab/YAMAN-BOTS-)

GitHub stores the project files; it does not run the Discord bot or Node.js dashboard. Use the button above to create the public web service on Render. Render will give you a web URL such as `https://your-service.onrender.com`.

Create a **Web Service** from this repository. Set **Root Directory** to blank (the repository root), **Build Command** to `npm install`, and **Start Command** to `npm start`. Do not use `node src/index.js` as the Render start command. Use Node.js 22.x. Add these Render environment variables: `DISCORD_TOKEN_1`, `DISCORD_TOKEN_2`, `DISCORD_TOKEN_3`, `DISCORD_TOKEN_4`, `DISCORD_TOKEN_5`, and `WEB_ADMIN_KEY`. `GUILD_ID` is optional and should only be set to a real numeric server ID. `DISCORD_START_DELAY_MS` is optional and defaults to 20000 milliseconds. Do not add a manual Discord login-timeout variable: discord.js owns gateway reconnect and resume handling. Client IDs are not required. The project uses the JavaScript Opus fallback, so native Opus build tools are not required. The application does not make an extra `/gateway` probe; discord.js performs the required authenticated Gateway discovery for each bot, and this process serializes those five discovery requests to avoid a shared Render IP rate-limit storm.

The dashboard is available at the deployed service URL. Open it and log in with the exact `WEB_ADMIN_KEY` from Render. The page shows the status of all five bot slots before enabling controls. If a bot says `missing-token`, add its matching `DISCORD_TOKEN_1` through `DISCORD_TOKEN_5` environment variable in Render. Choose a server and voice channel, then click **Join all bots**. Every online bot will join that channel. Upload an audio file, then click **Play on all bots** beside it to send that audio to every bot in the channel. **Stop all audio** stops Discord playback and **Leave all bots** ends every active voice session. The bot accounts must already be invited to the channel's server and have `Connect`, `Speak`, and `View Channel` permissions.

The included `render.yaml` contains the same Web Service configuration for Blueprint deploys.

## Create and invite the bots

Create one application per bot at [discord.com/developers/applications](https://discord.com/developers/applications). Open **Bot**, add a bot user, and use **Reset Token** to generate a new token. Under **OAuth2 > URL Generator**, select the `bot` scope, then grant `View Channel`, `Connect`, and `Speak`. Open the generated URL and invite each bot to the same server.

The old tokens in the workspace were exposed and must not be reused; revoke them before starting these bots.

## Invite the bots

In the Developer Portal, create an OAuth2 invite URL with the `bot` scope and the `View Channel`, `Connect`, and `Speak` permissions.

