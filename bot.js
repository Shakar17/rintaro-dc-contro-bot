const path = require('node:path');
const fs = require('node:fs');
const dotenvPath = fs.existsSync(path.join(__dirname, '.env')) ? '.env' : '.evn';
require('dotenv').config({ path: dotenvPath });

const { spawn } = require('node:child_process');
const express = require('express');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');
const {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const rootDir = __dirname;
const audioDir = path.join(rootDir, 'audio');
const port = Number(process.env.PORT) || 10000;
const adminKey = process.env.WEB_ADMIN_KEY;
const guildId = /^\d{17,20}$/.test(process.env.GUILD_ID || '') ? process.env.GUILD_ID : undefined;
const logs = [];
fs.mkdirSync(audioDir, { recursive: true });

function addLog(level, message) {
  const entry = { time: new Date().toISOString(), level, message };
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}] ${message}`);
}

function configuredBots() {
  return Array.from({ length: 5 }, (_, index) => ({
    number: index + 1,
    token: normalizeToken(process.env[`DISCORD_TOKEN_${index + 1}`]),
    status: normalizeToken(process.env[`DISCORD_TOKEN_${index + 1}`]) ? 'connecting' : 'missing-token',
  }));
}

function normalizeToken(value) {
  return String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

const sessions = new Map();
const bots = [];

function getAudioPath(filename) {
  if (!filename || path.basename(filename) !== filename) return null;
  const filePath = path.join(audioDir, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

async function playInDiscord(bot, session, filename, loop = false, volume = 100) {
  const audioPath = getAudioPath(filename);
  if (!audioPath) throw new Error(`Audio file ${filename} was not found.`);
  if (session.audioProcess) session.audioProcess.kill();
  const ffmpegArgs = [
    '-hide_banner', '-loglevel', 'error', '-re',
  ];
  if (loop) ffmpegArgs.push('-stream_loop', '-1');
  ffmpegArgs.push(
    '-i', audioPath,
    '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le',
    '-af', `volume=${volume / 100}`,
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  );
  const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
  session.audioProcess = ffmpeg;
  let ffmpegError = '';
  ffmpeg.stderr.on('data', (data) => {
    if (session.suppressAudioErrorsUntil > Date.now()) return;
    ffmpegError += data.toString();
    addLog('error', `Bot ${bot.number} audio: ${data.toString().trim()}`);
  });
  ffmpeg.on('error', (error) => {
    if (session.suppressAudioErrorsUntil > Date.now()) return;
    addLog('error', `Bot ${bot.number} audio process failed: ${error.message}`);
  });
  ffmpeg.on('close', () => {
    if (session.audioProcess === ffmpeg) session.audioProcess = null;
  });
  ffmpeg.stdout.on('error', (error) => {
    addLog('error', `Bot ${bot.number} audio stream failed: ${error.message}`);
  });
  const playerError = (error) => {
    addLog('error', `Bot ${bot.number} audio player failed: ${error.message}`);
  };
  session.player.once('error', playerError);
  session.player.play(createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw }));
  let onPlayerError;
  const started = new Promise((resolve, reject) => {
    if (session.player.state.status === AudioPlayerStatus.Playing) resolve();
    else session.player.once(AudioPlayerStatus.Playing, resolve);
    onPlayerError = (error) => reject(error);
    session.player.once('error', onPlayerError);
  });
  try {
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error(`Audio did not start${ffmpegError ? `: ${ffmpegError.trim()}` : '.'}`)), 15_000))]);
    addLog('info', `Bot ${bot.number} started playing ${filename}${loop ? ' in loop mode' : ''} at ${volume}% volume.`);
  } finally {
    session.player.removeListener('error', onPlayerError);
  }
}

function stopSessionAudio(session) {
  if (!session) return;
  session.suppressAudioErrorsUntil = Date.now() + 2_000;
  session.player.stop(true);
  if (session.audioProcess) {
    const process = session.audioProcess;
    session.audioProcess = null;
    process.kill();
  }
}

async function connectToChannel(bot, guild, channel, attempt = 0) {
  if (!channel.isVoiceBased()) throw new Error(`Channel ${channel.id} is not a voice channel.`);
  const botMember = guild.members.me || await guild.members.fetchMe();
  const permission = channel.permissionsFor(botMember);
  const missingPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
    .filter((permissionFlag) => !permission?.has(permissionFlag));
  if (missingPermissions.length) {
    throw new Error(`Missing permissions: ${missingPermissions.join(', ')}.`);
  }

  const key = `${bot.number}:${guild.id}`;
  const existing = sessions.get(key);
  if (existing && existing.channelId === channel.id) {
    if (existing.connection.state.status === VoiceConnectionStatus.Ready) return existing;
    if (existing.connection.state.status !== VoiceConnectionStatus.Destroyed
      && existing.connection.state.status !== VoiceConnectionStatus.Disconnected) {
      await entersState(existing.connection, VoiceConnectionStatus.Ready, 30_000);
      return existing;
    }
  }
  if (existing) {
    stopSessionAudio(existing);
    safelyDestroy(existing.connection);
    sessions.delete(key);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    // Each bot is a separate Discord client, so it needs its own voice connection group.
    group: `bot-${bot.number}`,
    selfDeaf: false,
    selfMute: false,
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  connection.on('error', (error) => addLog('error', `Bot ${bot.number} voice error: ${error.message}`));
  connection.on('debug', (message) => addLog('info', `Bot ${bot.number} voice debug: ${message}`));
  const session = { channelId: channel.id, connection, player };
  sessions.set(key, session);
  connection.on('stateChange', (oldState, newState) => {
    addLog('info', `Bot ${bot.number} voice state: ${oldState.status} -> ${newState.status}.`);
    if (newState.status === VoiceConnectionStatus.Disconnected && sessions.get(key) === session) {
      setTimeout(() => {
        if (sessions.get(key) !== session || session.connection.state.status !== VoiceConnectionStatus.Disconnected) return;
        sessions.delete(key);
        safelyDestroy(session.connection);
      }, 2_000);
    }
    if (newState.status === VoiceConnectionStatus.Destroyed && sessions.get(key) === session) {
      sessions.delete(key);
      addLog('info', `Bot ${bot.number} voice session ended.`);
    }
  });
  addLog('info', `Bot ${bot.number} is joining voice channel ${channel.id}.`);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    await confirmVoicePresence(bot, guild, channel.id);
    addLog('info', `Bot ${bot.number} confirmed in voice channel ${channel.id}.`);
    return session;
  } catch (error) {
    addLog('error', `Bot ${bot.number} voice handshake attempt ${attempt + 1} failed in state ${connection.state.status}: ${error.message}.`);
    safelyDestroy(connection);
    sessions.delete(key);
    if (attempt >= 2) {
      throw new Error(error.code === 'ABORT_ERR'
        ? 'Discord voice UDP handshake timed out after 3 fresh attempts. Check Render outbound UDP support and the bot voice permissions.'
        : error.message);
    }
    const backoffMs = 3_000 * (attempt + 1);
    addLog('info', `Bot ${bot.number} will create a fresh voice connection in ${backoffMs / 1000}s.`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    try {
      return await connectToChannel(bot, guild, channel, attempt + 1);
    } catch (retryError) {
      addLog('error', `Bot ${bot.number} fresh voice attempt ${attempt + 2} failed: ${retryError.message}.`);
      throw retryError;
    }
  }
}

async function confirmVoicePresence(bot, guild, channelId) {
  const userId = bot.client.user.id;
  const confirmed = () => {
    const cachedVoiceState = guild.voiceStates.cache.get(userId);
    return cachedVoiceState?.channelId === channelId;
  };

  if (confirmed()) return;

  let stopListening;
  const stateEvent = new Promise((resolve) => {
    const onVoiceState = (oldState, newState) => {
      if (newState.id === userId && newState.guild.id === guild.id && newState.channelId === channelId) {
        stopListening();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      stopListening();
      resolve();
    }, 30_000);
    stopListening = () => {
      clearTimeout(timer);
      bot.client.removeListener('voiceStateUpdate', onVoiceState);
    };
    bot.client.on('voiceStateUpdate', onVoiceState);
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (confirmed()) {
      stopListening();
      return;
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member?.voice?.channelId === channelId) {
      stopListening();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await stateEvent;
  if (confirmed()) return;
  throw new Error(`Discord did not confirm Bot ${bot.number} in voice channel ${channelId}. Check the bot's server membership and channel permissions.`);
}

function safelyDestroy(connection) {
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
  try {
    connection.destroy();
  } catch (error) {
    if (!/already been destroyed/i.test(error.message)) throw error;
  }
}

async function runWebControl(action, guildIdToControl, channelIdToControl, filename, loop = false, volume = 100) {
  const activeBots = bots.filter((bot) => bot.status === 'online');
  if (!activeBots.length) {
    const details = bots.map((bot) => `Bot ${bot.number}: ${bot.statusMessage || bot.status}`).join(' | ');
    throw new Error(`No bots are online. ${details || 'Add DISCORD_TOKEN_1 through DISCORD_TOKEN_5 in Render.'}`);
  }
  const results = await Promise.all(activeBots.map(async (bot) => {
    try {
      if (action === 'join') {
        // Stagger only gateway handshakes; playback must start concurrently.
        await new Promise((resolve) => setTimeout(resolve, (bot.number - 1) * 1_000));
      }
      const requestedChannel = channelIdToControl
        ? await bot.client.channels.fetch(channelIdToControl).catch(() => null)
        : null;
      const activeSession = action === 'play' && !channelIdToControl
        ? [...sessions.entries()].find(([key, session]) => key.startsWith(`${bot.number}:`)
          && session.connection.state.status === VoiceConnectionStatus.Ready)
        : null;
      const activeGuildId = activeSession?.[0].split(':')[1];
      const guild = (requestedChannel?.guild)
        || bot.client.guilds.cache.get(guildIdToControl)
        || bot.client.guilds.cache.get(activeGuildId);
      if (action === 'disconnect' && !guildIdToControl && !requestedChannel) {
        const guildIds = new Set([
          ...[...sessions.keys()]
            .filter((key) => key.startsWith(`${bot.number}:`))
            .map((key) => key.split(':')[1]),
        ]);
        const completed = [...guildIds]
          .map((guildId) => disconnect(bot.number, guildId))
          .some(Boolean);
        return { bot: bot.number, completed };
      }
      if (action === 'stop' && !guildIdToControl && !requestedChannel) {
        const completed = [...sessions.entries()]
          .filter(([key]) => key.startsWith(`${bot.number}:`))
          .map(([, session]) => { stopSessionAudio(session); return true; }).length > 0;
        return { bot: bot.number, completed };
      }
      if (!guild) throw new Error(`Cannot access channel ${channelIdToControl}. Invite Bot ${bot.number} to the channel's server.`);
      if (action === 'disconnect') {
        return { bot: bot.number, completed: disconnect(bot.number, guild.id) };
      }
      const session = sessions.get(`${bot.number}:${guild.id}`);
      if (action === 'stop') {
        stopSessionAudio(session);
        return { bot: bot.number, completed: Boolean(session) };
      }
      const channel = requestedChannel
        || (activeSession && guild.channels.cache.get(activeSession[1].channelId))
        || guild.channels.cache.get(channelIdToControl);
      if (!channel) throw new Error('Choose a voice channel or join a voice channel first.');
      const connected = await connectToChannel(bot, guild, channel);
      if (action === 'play') await playInDiscord(bot, connected, filename, loop, volume);
      return { bot: bot.number, completed: true, state: sessions.get(`${bot.number}:${guild.id}`)?.connection.state.status };
    } catch (error) {
      return { bot: bot.number, completed: false, error: error.message };
    }
  }));
  const failed = results.filter((result) => result.error);
  const summary = {
    completed: results.filter((result) => result.completed).length,
    total: results.length,
    errors: failed.map((result) => `Bot ${result.bot}: ${result.error}`),
    results,
  };
  const detail = summary.errors.length ? ` Errors: ${summary.errors.join(' | ')}` : '';
  addLog(failed.length ? 'error' : 'info', `Web control ${action}: ${summary.completed}/${summary.total} bots completed.${detail}`);
  return summary;
}

function disconnect(botNumber, guildIdToDisconnect) {
  const key = `${botNumber}:${guildIdToDisconnect}`;
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  stopSessionAudio(session);
  safelyDestroy(session.connection);
  return true;
}

function attachBot(bot) {
  if (!bot.token || bot.token.startsWith('replace-with-')) {
    bots.push({ ...bot, client: null, status: 'missing-token', statusMessage: 'Add this bot token in Render.' });
    addLog('error', `Bot ${bot.number} is not started: DISCORD_TOKEN_${bot.number} is missing in Render.`);
    return;
  }
  addLog('info', `Bot ${bot.number} token configured. Attempting Discord login.`);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const botState = { ...bot, client, status: bot.status };
  bots.push(botState);

  client.once('ready', (readyClient) => {
    botState.status = 'online';
    botState.statusMessage = 'Connected to Discord';
    botState.tag = readyClient.user.tag;
    addLog('info', `Bot ${bot.number} login successful as ${readyClient.user.tag}. Servers: ${readyClient.guilds.cache.size}.`);
  });

  const markLoginError = (error) => {
    if (botState.status === 'online') return;
    botState.status = 'error';
    botState.statusMessage = error.code === 4004 ? 'Invalid token' : error.message || 'Discord gateway error';
    addLog('error', `Bot ${bot.number} login failed: ${botState.statusMessage}.`);
  };

  client.on('error', markLoginError);
  client.on('shardError', markLoginError);

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user?.id) return;
    addLog('info', `Bot ${bot.number} Discord voice state: ${oldState.channelId || 'none'} -> ${newState.channelId || 'none'}.`);
  });

  const login = client.login(bot.token);
  Promise.race([
    login,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Discord login timed out after 30 seconds. Check the token and Render network logs.')), 30_000)),
  ]).catch(markLoginError);
}

function requireAdmin(request, response, next) {
  if (!adminKey) return response.status(503).json({ error: 'WEB_ADMIN_KEY is not configured in Render.' });
  if (request.get('x-admin-key') !== adminKey) return response.status(401).json({ error: 'Invalid dashboard key. Enter the exact WEB_ADMIN_KEY from Render.' });
  next();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));
app.get('/health', (request, response) => response.json({ status: 'ok', bots: bots.map((bot) => ({ number: bot.number, status: bot.status })) }));
app.get('/api/bots', requireAdmin, (request, response) => response.json(bots.map((bot) => ({ number: bot.number, status: bot.status, message: bot.statusMessage || null, tag: bot.tag || null }))));
app.get('/api/logs', requireAdmin, (request, response) => response.json(logs));
app.get('/api/audio', requireAdmin, (request, response) => {
  const files = fs.readdirSync(audioDir).filter((file) => /\.(mp3|wav|ogg|m4a|webm)$/i.test(file));
  response.json(files.map((file) => ({ name: file, url: `/audio/${encodeURIComponent(file)}` })));
});
app.delete('/api/audio', requireAdmin, (request, response) => {
  sessions.forEach((session) => stopSessionAudio(session));
  const files = fs.readdirSync(audioDir).filter((file) => /\.(mp3|wav|ogg|m4a|webm)$/i.test(file));
  files.forEach((file) => fs.unlinkSync(path.join(audioDir, file)));
  addLog('info', `Audio library cleared: ${files.length} file(s) removed.`);
  response.json({ removed: files.length });
});
app.use('/audio', express.static(audioDir));
app.get('/api/discord-context', requireAdmin, (request, response) => {
  const controller = bots.find((bot) => bot.status === 'online');
  if (!controller) return response.json({ guilds: [] });
  const guilds = [...controller.client.guilds.cache.values()].map((guild) => ({
    id: guild.id,
    name: guild.name,
    channels: [...guild.channels.cache.values()]
      .filter((channel) => channel.isVoiceBased())
      .map((channel) => ({ id: channel.id, name: channel.name }))
  }));
  response.json({ guilds });
});
app.post('/api/control', requireAdmin, async (request, response) => {
  const { action, guildId: targetGuildId, channelId: targetChannelId, filename, loop, volume } = request.body || {};
  if (!['join', 'stop', 'disconnect', 'play'].includes(action)) {
    return response.status(400).json({ error: 'Choose a valid server and action.' });
  }
  if (action === 'join' && !/^\d{17,20}$/.test(targetChannelId || '')) {
    return response.status(400).json({ error: 'Choose a voice channel.' });
  }
  if (action === 'play' && !getAudioPath(filename)) return response.status(400).json({ error: 'Choose a valid uploaded audio file.' });
  const safeVolume = Number.isFinite(Number(volume)) ? Math.max(0, Math.min(1000, Number(volume))) : 100;
  try {
    response.json(await runWebControl(action, targetGuildId, targetChannelId, filename, loop === true, safeVolume));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

const upload = multer({
  dest: audioDir,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (request, file, callback) => callback(null, /^audio\//.test(file.mimetype) || /\.(mp3|wav|ogg|m4a|webm)$/i.test(file.originalname)),
});
app.post('/api/audio/upload', requireAdmin, upload.single('audio'), (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Choose an audio file.' });
  const extension = path.extname(request.file.originalname).toLowerCase() || '.mp3';
  const safeName = `${Date.now()}-${path.basename(request.file.originalname, extension).replace(/[^a-z0-9_-]/gi, '-')}${extension}`;
  fs.renameSync(request.file.path, path.join(audioDir, safeName));
  addLog('info', `Audio uploaded: ${safeName}.`);
  response.json({ name: safeName, url: `/audio/${encodeURIComponent(safeName)}` });
});

app.listen(port, '0.0.0.0', () => console.log(`Web dashboard listening on port ${port}`));

const configured = configuredBots();
const tokenCount = configured.filter((bot) => bot.token && !bot.token.startsWith('replace-with-')).length;
addLog('info', `Configured ${tokenCount}/5 Discord bot token(s).`);
if (!tokenCount) addLog('error', 'No Discord bot tokens configured. Add DISCORD_TOKEN_1 through DISCORD_TOKEN_5 in Render.');
configured.forEach(attachBot);
