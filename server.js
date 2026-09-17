const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_PIN = String(process.env.ADMIN_PIN || '');
const DEMO_MODE = String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true';

const NAMES = ['София', 'Вика', 'Саша', 'Яромир', 'Мария', 'Матвей'];
const PRIZES = [
  '🥇 Суперприз',
  '🥈 Большой приз',
  '🥉 Средний приз',
  '🎮 Малый приз',
  '🎁 Финальный бонус A',
  '🎉 Финальный бонус B'
];

const rooms = new Map();

function freshRoom() {
  return {
    students: NAMES.map((name, i) => ({
      id: `s${i + 1}`,
      name,
      stars: 0,
      boundUserId: null,
      boundUserName: null,
      prizeIndex: null,      // скрыто до вращения
      revealed: false
    })),
    distributionLocked: false,
    currentStudentId: null,
    spinning: false,
    history: [],
    completed: false
  };
}

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, freshRoom());
  return rooms.get(id);
}

function safeStars(v) {
  return Math.max(0, Math.min(999, Math.floor(Number(v) || 0)));
}

function totalStars(r) {
  return r.students.reduce((sum, s) => sum + safeStars(s.stars), 0);
}

const WEIGHT_BASE = 5;

function weightedValue(s, candidates) {
  const minStars = Math.min(...candidates.map(x => safeStars(x.stars)));
  return safeStars(s.stars) - minStars + WEIGHT_BASE;
}

function initialSuperChance(r, s) {
  const candidates = r.students;
  const totalWeight = candidates.reduce((sum, x) => sum + weightedValue(x, candidates), 0);
  return weightedValue(s, candidates) * 100 / totalWeight;
}

function publicState(r) {
  const current = r.students.find(s => s.id === r.currentStudentId) || null;
  return {
    prizes: PRIZES,
    students: r.students.map(s => ({
      id: s.id,
      name: s.name,
      stars: safeStars(s.stars),
      bound: !!s.boundUserId,
      boundName: s.boundUserName || '',
      revealed: !!s.revealed,
      revealedPrizeIndex: s.revealed ? s.prizeIndex : null,
      superChance: initialSuperChance(r, s)
    })),
    totalStars: totalStars(r),
    distributionLocked: r.distributionLocked,
    currentStudentId: r.currentStudentId,
    currentStudentName: current?.name || null,
    spinning: r.spinning,
    history: r.history,
    completed: r.completed
  };
}

function displayName(u) {
  if (!u) return 'Участник';
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || 'Участник';
}

function verifyTelegram(initData) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан на сервере');
  const p = new URLSearchParams(initData || '');
  const hash = p.get('hash');
  if (!hash) throw new Error('Нет подписи Telegram');
  p.delete('hash');

  const check = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Подпись Telegram не прошла проверку');

  const authDate = Number(p.get('auth_date') || 0);
  if (!authDate || Math.abs(Math.floor(Date.now() / 1000) - authDate) > 86400) {
    throw new Error('Открой приложение из Telegram заново');
  }

  const chatInstance = p.get('chat_instance');
  if (!chatInstance) throw new Error('Открой Mini App именно из общей группы Telegram');

  let user = null;
  try { user = JSON.parse(p.get('user') || 'null'); } catch {}
  return { roomId: `tg:${chatInstance}`, user };
}

function chooseWeightedStudent(candidates) {
  const weights = candidates.map(s => weightedValue(s, candidates));
  const total = weights.reduce((sum, w) => sum + w, 0);

  let x = crypto.randomInt(total);
  for (let i = 0; i < candidates.length; i += 1) {
    x -= weights[i];
    if (x < 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// Для четырёх нижних уровней повторы разрешены.
// Чем больше звёзд у ученика относительно остальных оставшихся,
// тем сильнее его распределение смещено к Среднему и Малому призу.
// t = 0 у ученика с минимумом звёзд, t = 1 у ученика с максимумом.
// Вероятности [Средний, Малый, Бонус А, Бонус Б]:
// при t=0 -> [25%, 30%, 25%, 20%]
// при t=1 -> [40%, 35%, 20%, 5%]
function chooseLowerPrizeIndex(student, candidates) {
  const stars = candidates.map(s => safeStars(s.stars));
  const minStars = Math.min(...stars);
  const maxStars = Math.max(...stars);
  const t = maxStars === minStars
    ? 0.5
    : (safeStars(student.stars) - minStars) / (maxStars - minStars);

  const probs = [
    25 + 15 * t,
    30 + 5 * t,
    25 - 5 * t,
    20 - 15 * t
  ];

  // 10000 долей дают стабильную точность без float в crypto.randomInt.
  const weights = probs.map(p => Math.max(1, Math.round(p * 100)));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = crypto.randomInt(total);
  for (let i = 0; i < weights.length; i += 1) {
    x -= weights[i];
    if (x < 0) return i + 2; // индексы 2..5 в PRIZES
  }
  return 5;
}

function nextStudentByStars(r) {
  return r.students
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.revealed)
    .sort((a, b) => safeStars(b.s.stars) - safeStars(a.s.stars) || a.i - b.i)[0]?.s || null;
}

// Скрытое распределение фиксируется один раз до начала вращений.
// 1) Суперприз — ровно один: выбор по weight = stars - min + 5.
// 2) Большой приз — ровно один среди оставшихся: те же веса пересчитываются.
// 3) Остальные четыре ученика получают один из четырёх нижних уровней;
//    эти уровни могут повторяться, а звёзды смещают шанс к более сильным призам.
function lockDistribution(r) {
  if (r.distributionLocked) return;

  r.students.forEach(s => {
    s.prizeIndex = null;
    s.revealed = false;
  });

  const remaining = [...r.students];

  const superWinner = chooseWeightedStudent(remaining);
  superWinner.prizeIndex = 0;
  remaining.splice(remaining.findIndex(s => s.id === superWinner.id), 1);

  const bigWinner = chooseWeightedStudent(remaining);
  bigWinner.prizeIndex = 1;
  remaining.splice(remaining.findIndex(s => s.id === bigWinner.id), 1);

  const lowerCandidates = [...remaining];
  for (const s of lowerCandidates) {
    s.prizeIndex = chooseLowerPrizeIndex(s, lowerCandidates);
  }

  r.distributionLocked = true;
  // Порядок вращений автоматический: сначала больше звёзд, затем меньше.
  // При равенстве звёзд сохраняется исходный порядок списка.
  r.currentStudentId = nextStudentByStars(r)?.id || null;
}

function studentForUser(r, userId) {
  const uid = String(userId ?? '');
  return r.students.find(s => s.boundUserId && String(s.boundUserId) === uid) || null;
}

async function emitPersonal(roomId) {
  const r = getRoom(roomId);
  const sockets = await io.in(roomId).fetchSockets();
  for (const sk of sockets) {
    const uid = String(sk.data.user?.id ?? '');
    const mine = studentForUser(r, uid);
    const canSpin = !!mine &&
      r.distributionLocked &&
      !r.completed &&
      !r.spinning &&
      r.currentStudentId === mine.id &&
      !mine.revealed;

    sk.emit('personal', {
      admin: !!sk.data.admin,
      userName: displayName(sk.data.user),
      studentId: mine?.id || null,
      studentName: mine?.name || null,
      canSpin
    });
  }
}

async function emitAdminOnline(roomId) {
  const r = getRoom(roomId);
  const sockets = await io.in(roomId).fetchSockets();
  const seen = new Map();

  for (const sk of sockets) {
    const u = sk.data.user || {};
    const uid = String(u.id ?? sk.id);
    if (!seen.has(uid)) {
      const mine = studentForUser(r, uid);
      seen.set(uid, {
        userId: uid,
        name: displayName(u),
        username: u.username || '',
        studentId: mine?.id || null,
        studentName: mine?.name || null
      });
    }
  }

  const list = [...seen.values()];
  for (const sk of sockets) {
    if (sk.data.admin) sk.emit('online-users', list);
  }
}

function emitState(roomId) {
  io.to(roomId).emit('state', publicState(getRoom(roomId)));
  emitPersonal(roomId);
  emitAdminOnline(roomId);
}

io.use((socket, next) => {
  try {
    const initData = socket.handshake.auth?.initData || '';
    if (DEMO_MODE && !initData) {
      const demoId = socket.handshake.auth?.demoUser || `demo-${crypto.randomUUID()}`;
      socket.data.roomId = `demo:${socket.handshake.auth?.demoRoom || 'main'}`;
      socket.data.user = { id: demoId, first_name: socket.handshake.auth?.demoName || 'Участник' };
      return next();
    }

    const verified = verifyTelegram(initData);
    socket.data.roomId = verified.roomId;
    socket.data.user = verified.user;
    next();
  } catch (e) {
    next(new Error(e.message));
  }
});

io.on('connection', socket => {
  const roomId = socket.data.roomId;
  if (socket.data.user && socket.data.user.id == null) socket.data.user.id = `anon-${socket.id}`;
  socket.data.admin = false;
  socket.join(roomId);

  emitState(roomId);
  io.to(roomId).emit('presence', { count: io.sockets.adapter.rooms.get(roomId)?.size || 1 });

  socket.on('admin-login', (pin, cb = () => {}) => {
    if (!ADMIN_PIN || String(pin) !== ADMIN_PIN) return cb({ ok: false, error: 'Неверный PIN' });
    socket.data.admin = true;
    cb({ ok: true });
    socket.emit('admin', { ok: true });
    emitPersonal(roomId);
    emitAdminOnline(roomId);
  });

  socket.on('claim-student', (payload, cb = () => {}) => {
    const r = getRoom(roomId);
    if (r.spinning) return cb({ ok: false, error: 'Сейчас идёт вращение' });

    const uid = String(socket.data.user?.id ?? '');
    if (!uid) return cb({ ok: false, error: 'Не удалось определить Telegram-аккаунт' });

    const existing = studentForUser(r, uid);
    if (existing) return cb({ ok: true, studentId: existing.id, studentName: existing.name });

    const s = r.students.find(x => x.id === String(payload?.studentId || ''));
    if (!s) return cb({ ok: false, error: 'Ученик не найден' });
    if (s.boundUserId) return cb({ ok: false, error: `${s.name} уже выбрал(а) себя` });

    s.boundUserId = uid;
    s.boundUserName = displayName(socket.data.user);
    emitState(roomId);
    cb({ ok: true, studentId: s.id, studentName: s.name });
  });

  socket.on('save-stars', (payload, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok: false, error: 'Только преподаватель' });
    const r = getRoom(roomId);
    if (r.spinning) return cb({ ok: false, error: 'Сейчас идёт вращение' });
    if (r.distributionLocked) return cb({ ok: false, error: 'Распределение уже зафиксировано. Сначала нажми «Пересчитать распределение».' });
    if (!Array.isArray(payload?.students) || payload.students.length !== 6) return cb({ ok: false, error: 'Нужно 6 участников' });

    r.students.forEach((s, i) => {
      const p = payload.students[i] || {};
      s.name = String(p.name || s.name).trim().slice(0, 24) || s.name;
      s.stars = safeStars(p.stars);
    });

    emitState(roomId);
    cb({ ok: true });
  });

  socket.on('lock-distribution', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok: false, error: 'Только преподаватель' });
    const r = getRoom(roomId);
    if (r.spinning) return cb({ ok: false, error: 'Сейчас идёт вращение' });
    if (r.history.length) return cb({ ok: false, error: 'Розыгрыш уже начался' });
    if (r.distributionLocked) return cb({ ok: true });

    lockDistribution(r);
    emitState(roomId);
    cb({ ok: true });
  });

  socket.on('set-current-student', (payload, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok: false, error: 'Только преподаватель' });
    const r = getRoom(roomId);
    if (!r.distributionLocked) return cb({ ok: false, error: 'Сначала зафиксируй распределение призов' });
    if (r.spinning) return cb({ ok: false, error: 'Сейчас колесо вращается' });
    if (r.completed) return cb({ ok: false, error: 'Все призы уже открыты' });

    const s = r.students.find(x => x.id === String(payload?.studentId || ''));
    if (!s) return cb({ ok: false, error: 'Ученик не найден' });
    if (s.revealed) return cb({ ok: false, error: `${s.name} уже открыл(а) свой приз` });
    if (!s.boundUserId) return cb({ ok: false, error: `${s.name} ещё не выбрал(а) себя в приложении` });

    r.currentStudentId = s.id;
    emitState(roomId);
    cb({ ok: true, name: s.name });
  });

  socket.on('spin', (_, cb = () => {}) => {
    const r = getRoom(roomId);
    if (!r.distributionLocked) return cb({ ok: false, error: 'Преподаватель ещё не зафиксировал распределение' });
    if (r.spinning) return cb({ ok: false, error: 'Колесо уже вращается' });
    if (r.completed) return cb({ ok: false, error: 'Все призы уже открыты' });

    const uid = String(socket.data.user?.id ?? '');
    const mine = studentForUser(r, uid);
    if (!mine) return cb({ ok: false, error: 'Сначала выбери своё имя' });
    if (mine.revealed) return cb({ ok: false, error: 'Ты уже открыл(а) свой приз' });
    if (r.currentStudentId !== mine.id) {
      const current = r.students.find(s => s.id === r.currentStudentId);
      return cb({ ok: false, error: current ? `Сейчас крутит ${current.name}` : 'Очередь ещё не определена' });
    }
    if (mine.prizeIndex == null) return cb({ ok: false, error: 'Внутренняя ошибка распределения' });

    const duration = 5200;
    r.spinning = true;
    io.to(roomId).emit('spin-start', {
      duration,
      studentId: mine.id,
      studentName: mine.name,
      prizeIndex: mine.prizeIndex
    });
    emitPersonal(roomId);
    cb({ ok: true });

    setTimeout(() => {
      mine.revealed = true;
      r.history.push({ studentId: mine.id, name: mine.name, prizeIndex: mine.prizeIndex });
      r.spinning = false;
      r.completed = r.students.every(s => s.revealed);
      r.currentStudentId = r.completed ? null : (nextStudentByStars(r)?.id || null);

      io.to(roomId).emit('spin-result', {
        studentId: mine.id,
        studentName: mine.name,
        prizeIndex: mine.prizeIndex,
        prize: PRIZES[mine.prizeIndex],
        completed: r.completed
      });
      emitState(roomId);
    }, duration + 250);
  });

  // Пересчитать скрытое распределение с теми же звёздами. История открытий стирается.
  socket.on('reset-distribution', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok: false, error: 'Только преподаватель' });
    const r = getRoom(roomId);
    if (r.spinning) return cb({ ok: false, error: 'Сейчас колесо вращается' });

    r.students.forEach(s => {
      s.prizeIndex = null;
      s.revealed = false;
    });
    r.distributionLocked = false;
    r.currentStudentId = null;
    r.history = [];
    r.completed = false;
    emitState(roomId);
    cb({ ok: true });
  });

  socket.on('reset-bindings', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok: false, error: 'Только преподаватель' });
    const r = getRoom(roomId);
    if (r.spinning) return cb({ ok: false, error: 'Сейчас колесо вращается' });

    r.students.forEach(s => {
      s.boundUserId = null;
      s.boundUserName = null;
    });
    r.currentStudentId = null;
    emitState(roomId);
    cb({ ok: true });
  });

  socket.on('new-month', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok: false, error: 'Только преподаватель' });
    const old = getRoom(roomId);
    if (old.spinning) return cb({ ok: false, error: 'Сейчас колесо вращается' });

    const nr = freshRoom();
    nr.students.forEach((s, i) => {
      const prev = old.students[i];
      s.name = prev?.name || s.name;
      // Сохраняем привязку Telegram к имени на следующий месяц.
      s.boundUserId = prev?.boundUserId || null;
      s.boundUserName = prev?.boundUserName || null;
    });
    rooms.set(roomId, nr);
    emitState(roomId);
    cb({ ok: true });
  });

  socket.on('disconnect', () => setTimeout(() => {
    io.to(roomId).emit('presence', { count: io.sockets.adapter.rooms.get(roomId)?.size || 0 });
    emitAdminOnline(roomId);
  }, 80));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
