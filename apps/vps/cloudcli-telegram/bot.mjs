// Telegram-бот поверх API CloudCLI. Node 24, без зависимостей.
// Каждый чат Telegram привязан к одной сессии CloudCLI. Агента запускает сам CloudCLI,
// бот только пересылает сообщения и кнопки разрешений.

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Не задана переменная ${name}`);
  return value;
}

const TELEGRAM_BOT_TOKEN = env('TELEGRAM_BOT_TOKEN');
const ALLOWED_USERS = env('ALLOWED_USERS').split(',').map((id) => id.trim());
const CLOUDCLI_URL = env('CLOUDCLI_URL', 'http://localhost:3001');
const CLOUDCLI_USERNAME = env('CLOUDCLI_USERNAME');
const CLOUDCLI_PASSWORD = env('CLOUDCLI_PASSWORD');
const PROJECT_PATH = env('PROJECT_PATH');
const PERMISSION_MODE = env('PERMISSION_MODE', 'default');

const sessionByChat = new Map(); // chatId -> sessionId CloudCLI
const chatBySession = new Map(); // sessionId -> chatId
const lastSeq = new Map(); // sessionId -> последний полученный seq, нужен при переподключении
let ws;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Telegram ----------

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

async function sendText(chatId, text, extra = {}) {
  for (let i = 0; i < text.length; i += 4096) {
    await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4096), ...extra });
  }
}

async function poll() {
  await tg('setMyCommands', {
    commands: [
      { command: 'sessions', description: 'Сессии: переключить или начать новую' },
      { command: 'stop', description: 'Остановить агента' },
    ],
  });

  let offset = 0;
  for (;;) {
    const updates = await tg('getUpdates', { offset, timeout: 50 }).catch((error) => {
      console.error(`Telegram getUpdates: ${error.message}`);
    });
    if (!updates) {
      await sleep(5000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      await onUpdate(update).catch((error) => {
        console.error(error);
        const chatId = update.message?.chat.id;
        if (chatId) return sendText(chatId, `Ошибка: ${error.message}`);
      });
    }
  }
}

async function onUpdate(update) {
  if (update.callback_query) return onButton(update.callback_query);

  const message = update.message;
  if (!message?.text) return;
  const chatId = message.chat.id;

  if (!ALLOWED_USERS.includes(String(message.from.id))) {
    return sendText(chatId, `Нет доступа. Ваш id: ${message.from.id}`);
  }

  if (message.text === '/start') {
    return sendText(chatId, 'Пишите задачу. /sessions — переключить сессию или начать новую, /stop — остановить агента.');
  }
  if (message.text === '/sessions') {
    return showSessions(chatId);
  }
  if (message.text === '/stop') {
    return send(chatId, { type: 'chat.abort', sessionId: sessionByChat.get(chatId) });
  }

  let content = message.text;
  if (content.startsWith('/')) {
    const command = await expandCommand(content, sessionByChat.get(chatId));
    if (command.reply) return sendText(chatId, command.reply);
    content = command.prompt;
  }

  let sessionId = sessionByChat.get(chatId);
  if (!sessionId) {
    const created = await api('POST', '/api/providers/sessions', {
      provider: 'claude',
      projectPath: PROJECT_PATH,
      initialMessage: message.text,
    });
    sessionId = created.data.sessionId;
    bindChat(chatId, sessionId);
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  await send(chatId, {
    type: 'chat.send',
    sessionId,
    content,
    options: {
      permissionMode: PERMISSION_MODE,
      // Вопросы с вариантами и выход из режима плана в Telegram не рисуем —
      // без этих инструментов агент спрашивает обычным текстом.
      toolsSettings: {
        allowedTools: [],
        disallowedTools: ['AskUserQuestion', 'ExitPlanMode'],
        skipPermissions: false,
      },
    },
  });
}

async function showSessions(chatId) {
  const projects = await api('GET', '/api/projects?skipSync=1&sessionsLimit=8');
  const sessions = projects.find((project) => project.fullPath === PROJECT_PATH)?.sessions ?? [];
  const current = sessionByChat.get(chatId);

  const keyboard = [[{ text: 'Новая сессия', callback_data: 'new' }]];
  for (const session of sessions) {
    const title = (session.summary || session.id).slice(0, 60);
    keyboard.push([{ text: session.id === current ? `• ${title}` : title, callback_data: `switch:${session.id}` }]);
  }
  await sendText(chatId, 'Сессии:', { reply_markup: { inline_keyboard: keyboard } });
}

async function onButton(query) {
  if (!ALLOWED_USERS.includes(String(query.from.id))) return;

  const [action, id] = query.data.split(':');
  const chatId = query.message.chat.id;
  let result;

  if (action === 'allow' || action === 'deny') {
    await send(chatId, { type: 'chat.permission-response', requestId: id, allow: action === 'allow' });
    result = action === 'allow' ? 'Разрешено' : 'Запрещено';
  } else if (action === 'new') {
    bindChat(chatId, undefined);
    result = 'Новая сессия: напишите задачу.';
  } else if (action === 'switch') {
    bindChat(chatId, id);
    // Если в сессии сейчас идёт прогон, подключаемся к нему
    await send(chatId, { type: 'chat.subscribe', sessions: [{ sessionId: id, lastSeq: 0 }] });
    const button = query.message.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === query.data);
    result = `Сессия: ${button.text.replace(/^• /, '')}`;
  }

  await tg('answerCallbackQuery', { callback_query_id: query.id });
  // Без reply_markup кнопки исчезают
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: query.message.message_id,
    text: `${query.message.text}\n\n${result}`,
  });
}

function bindChat(chatId, sessionId) {
  const previous = sessionByChat.get(chatId);
  chatBySession.delete(previous);
  lastSeq.delete(previous);
  sessionByChat.delete(chatId);
  if (sessionId) {
    sessionByChat.set(chatId, sessionId);
    chatBySession.set(sessionId, chatId);
  }
}

// ---------- CloudCLI ----------

async function login() {
  const res = await fetch(`${CLOUDCLI_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: CLOUDCLI_USERNAME, password: CLOUDCLI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`вход в CloudCLI: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function api(method, path, body) {
  const res = await fetch(`${CLOUDCLI_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await login()}` },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CloudCLI ${path}: HTTP ${res.status}`);
  return res.json();
}

// Слэш-команды как в веб-интерфейсе CloudCLI: встроенные (/help, /models, /cost, /status,
// /memory, /config) и свои из .claude/commands разбирает сервер, всё остальное
// (скиллы, /compact и прочее) уходит агенту как есть.
async function expandCommand(text, sessionId) {
  const [name, ...args] = text.trim().split(/\s+/);
  const list = await api('POST', '/api/commands/list', { projectPath: PROJECT_PATH });
  const command = [...list.builtIn, ...list.custom].find((c) => c.name === name);
  if (!command) return { prompt: text };

  const result = await api('POST', '/api/commands/execute', {
    commandName: name,
    commandPath: command.path,
    args,
    context: { projectPath: PROJECT_PATH, sessionId: sessionId ?? null, provider: 'claude' },
  });
  if (result.type === 'custom') return { prompt: result.content };
  return { reply: result.data?.content ?? JSON.stringify(result.data, null, 2) };
}

async function send(chatId, frame) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return sendText(chatId, 'Нет связи с CloudCLI, попробуйте через минуту.');
  }
  ws.send(JSON.stringify(frame));
}

async function connect() {
  try {
    ws = new WebSocket(`${CLOUDCLI_URL.replace(/^http/, 'ws')}/ws?token=${await login()}`);
  } catch (error) {
    console.error(error.message);
    setTimeout(connect, 5000);
    return;
  }

  ws.onopen = () => {
    console.log('CloudCLI: подключено');
    // После обрыва забираем пропущенные события идущих прогонов
    const sessions = [...chatBySession.keys()].map((sessionId) => ({
      sessionId,
      lastSeq: lastSeq.get(sessionId) ?? 0,
    }));
    if (sessions.length) ws.send(JSON.stringify({ type: 'chat.subscribe', sessions }));
  };
  ws.onmessage = (message) => onEvent(JSON.parse(message.data)).catch((error) => console.error(error));
  ws.onclose = () => {
    console.error('CloudCLI: соединение закрыто, переподключаюсь');
    setTimeout(connect, 5000);
  };
}

async function onEvent(event) {
  const chatId = chatBySession.get(event.sessionId);
  if (!chatId) return; // чужие сессии и служебные события
  if (event.seq) lastSeq.set(event.sessionId, event.seq);

  switch (event.kind) {
    case 'text':
      if (event.role === 'assistant' && event.content) await sendText(chatId, event.content);
      break;

    case 'permission_request': {
      const input = JSON.stringify(event.input, null, 2);
      await sendText(chatId, `Агент просит: ${event.toolName}\n${input.slice(0, 1000)}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Разрешить', callback_data: `allow:${event.requestId}` },
            { text: 'Запретить', callback_data: `deny:${event.requestId}` },
          ]],
        },
      });
      break;
    }

    case 'permission_cancelled':
      await sendText(chatId, 'Запрос разрешения снят: время ответа вышло.');
      break;

    case 'error':
      await sendText(chatId, `Ошибка: ${event.content}`);
      break;

    case 'protocol_error':
      await sendText(chatId, event.code === 'RUN_IN_PROGRESS'
        ? 'Агент ещё работает. Дождитесь ответа или отправьте /stop.'
        : `Ошибка: ${event.error}`);
      break;

    case 'complete':
      // У следующего прогона seq начинается заново
      lastSeq.delete(event.sessionId);
      break;
  }
}

connect();
poll();
