'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const ADMIN_PASSWORD = "4942894y"; // <-- İstediğin admin şifresini buraya yaz

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

// ---------- Saha ve oyun sabitleri (Huge ölçeğinde 6v6 saha) ----------
const W = 1200, H = 600;                 // oyun alanı
const GD = 45;                           // kale ağı derinliği
const GY1 = H / 2 - 110, GY2 = H / 2 + 110; // kale ağzı (220 px)
const POST = 7;                          // direk yarıçapı
const PR = 15, BR = 10;                  // oyuncu / top yarıçapı
const MAX = 6;                           // takım başı oyuncu
const LIMIT = 5;                         // gol limiti
const MATCH_TICKS = 5 * 60 * 60;         // 5 dakika (60 tick/sn)
const STEP = 1000 / 60;
const KICK = 7, KICK_RANGE = 6, E = 0.5; // şut gücü, şut menzili, sekme katsayısı
const POSTS = [[0, GY1], [0, GY2], [W, GY1], [W, GY2]];
const SX = [W / 2 - 110, W / 2 - 210, W / 2 - 210, W / 2 - 330, W / 2 - 330, 110];
const SY = [H / 2, H / 2 - 110, H / 2 + 110, H / 2 - 200, H / 2 + 200, H / 2];

// ---------- Oyun durumu ----------
const players = new Map();
const ball = { x: W / 2, y: H / 2, vx: 0, vy: 0, r: BR, im: 1, d: 0.99 };
let nid = 0, ord = 0, cnt = [0, 0, 0];
let sc = [0, 0], tl = MATCH_TICKS, ot = false;
let ph = 0, pt = 0, winner = 0;          // ph: 0 oyun, 1 gol, 2 maç sonu

const list = t => [...players.values()].filter(p => p.t === t).sort((a, b) => a.ord - b.ord);

function slot(p) {
  const i = list(p.t).indexOf(p);
  if (i < 0 || i >= MAX) return;
  p.x = p.t === 1 ? SX[i] : W - SX[i];
  p.y = SY[i];
  p.vx = p.vy = 0;
}

function kickoff() {
  ball.x = W / 2; ball.y = H / 2; ball.vx = ball.vy = 0;
  players.forEach(p => { if (p.t) slot(p); });
}

function roster() {
  cnt = [0, 0, 0];
  players.forEach(p => cnt[p.t]++);
  io.emit('r', [...players.values()].map(p => [p.id, p.n, p.t]));
}

function move(p, t) { p.t = t; slot(p); }

// Boş yer varsa izleyiciyi sıraya göre takıma al, takımlar arası farkı 1'e indir
function rebalance() {
  for (let guard = 0; guard < 40; guard++) {
    const r = list(1).length, b = list(2).length;
    const small = r <= b ? 1 : 2, smallCount = small === 1 ? r : b;
    const spec = list(0)[0];
    if (spec && smallCount < MAX) move(spec, small);
    else if (Math.abs(r - b) >= 2) {
      const big = list(r > b ? 1 : 2);
      move(big[big.length - 1], small);
    } else break;
  }
}

// ---------- Fizik ----------
function bounds(d) {
  const r = d.r, inGoal = d.y > GY1 && d.y < GY2;
  const x0 = inGoal ? -GD + r : r, x1 = inGoal ? W + GD - r : W - r;
  if (d.x < x0) { d.x = x0; if (d.vx < 0) d.vx *= -E; }
  else if (d.x > x1) { d.x = x1; if (d.vx > 0) d.vx *= -E; }
  const net = d.x < 0 || d.x > W;
  const y0 = net ? GY1 + r : r, y1 = net ? GY2 - r : H - r;
  if (d.y < y0) { d.y = y0; if (d.vy < 0) d.vy *= -E; }
  else if (d.y > y1) { d.y = y1; if (d.vy > 0) d.vy *= -E; }
  for (const [px, py] of POSTS) {
    const dx = d.x - px, dy = d.y - py, dist = Math.hypot(dx, dy), m = d.r + POST;
    if (dist < m && dist > 0) {
      const nx = dx / dist, ny = dy / dist;
      d.x = px + nx * m; d.y = py + ny * m;
      const vn = d.vx * nx + d.vy * ny;
      if (vn < 0) { d.vx -= (1 + E) * vn * nx; d.vy -= (1 + E) * vn * ny; }
    }
  }
}

function collide(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy), min = a.r + b.r;
  if (dist >= min || dist === 0) return;
  const nx = dx / dist, ny = dy / dist, im = a.im + b.im, o = min - dist;
  a.x -= nx * o * a.im / im; a.y -= ny * o * a.im / im;
  b.x += nx * o * b.im / im; b.y += ny * o * b.im / im;
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) {
    const j = -(1 + E) * rv / im;
    a.vx -= j * a.im * nx; a.vy -= j * a.im * ny;
    b.vx += j * b.im * nx; b.vy += j * b.im * ny;
  }
}

function endMatch() { ph = 2; pt = 420; winner = sc[0] > sc[1] ? 1 : 2; }

function step() {
  const act = [];
  players.forEach(p => {
    if (!p.t) return;
    act.push(p);
    let ix = (p.in & 8 ? 1 : 0) - (p.in & 4 ? 1 : 0);
    let iy = (p.in & 2 ? 1 : 0) - (p.in & 1 ? 1 : 0);
    const l = Math.hypot(ix, iy);
    if (l) { ix /= l; iy /= l; }
    const a = p.in & 16 ? 0.09 : 0.14;    // şut tuşuna basılıyken ivme düşer
    p.vx += ix * a; p.vy += iy * a;
  });

  [ball, ...act].forEach(d => { d.x += d.vx; d.y += d.vy; d.vx *= d.d; d.vy *= d.d; });

  act.forEach(p => {
    if (p.in & 16) {
      if (!p.lock) {
        const dx = ball.x - p.x, dy = ball.y - p.y, d = Math.hypot(dx, dy);
        if (d > 0 && d < PR + BR + KICK_RANGE) {
          ball.vx += dx / d * KICK; ball.vy += dy / d * KICK;
          p.lock = true;
          io.emit('k', p.id);
        }
      }
    } else p.lock = false;
  });

  for (let i = 0; i < act.length; i++) {
    collide(act[i], ball);
    for (let j = i + 1; j < act.length; j++) collide(act[i], act[j]);
  }
  act.forEach(bounds);
  bounds(ball);

  if (ph === 0) {
    if (!ot && cnt[1] && cnt[2] && --tl <= 0) {
      tl = 0;
      if (sc[0] !== sc[1]) endMatch(); else ot = true;
    }
    if (ph === 0) {
      const g = ball.x < 0 ? 2 : ball.x > W ? 1 : 0;
      if (g) {
        sc[g - 1]++; winner = g;
        if (ot || sc[g - 1] >= LIMIT) endMatch(); else { ph = 1; pt = 150; }
      }
    }
  } else if (--pt <= 0) {
    if (ph === 2) { sc = [0, 0]; tl = MATCH_TICKS; ot = false; }
    ph = 0; kickoff();
  }
}

const r1 = v => Math.round(v * 10) / 10;
function snapshot() {
  const p = [];
  players.forEach(q => { if (q.t) p.push([q.id, r1(q.x), r1(q.y), q.in & 16 ? 1 : 0]); });
  io.volatile.emit('s', { p, b: [r1(ball.x), r1(ball.y)], s: sc, t: Math.ceil(tl / 60), ph, w: winner, ot });
}

let last = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now();
  acc = Math.min(acc + now - last, 100); last = now;
  let n = 0;
  while (acc >= STEP) { step(); acc -= STEP; n++; }
  if (n) snapshot();
}, 4);

// ---------- Bağlantılar ----------
io.on('connection', socket => {
  // Admin Giriş İsteği
  socket.on('admin_login', pass => {
    if (pass === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      socket.emit('admin_auth', true);
    } else {
      socket.emit('admin_auth', false);
    }
  });

  // Admin Komutları (Sadece doğrulanan adminler çalıştırabilir)
  socket.on('admin_cmd', data => {
    if (!socket.isAdmin) return;

    if (data.type === 'reset_ball') {
      ball.x = W / 2; ball.y = H / 2; ball.vx = 0; ball.vy = 0;
    } else if (data.type === 'add_score') {
      if (data.team === 1) sc[0]++;
      if (data.team === 2) sc[1]++;
    } else if (data.type === 'reset_time') {
      tl = MATCH_TICKS;
    } else if (data.type === 'kick') {
      const targetSocket = io.sockets.sockets.get(data.targetId);
      if (targetSocket) targetSocket.disconnect(true);
    }
  });
  const p = {
    id: ++nid, n: 'Oyuncu' + (1000 + Math.floor(Math.random() * 9000)), t: 0, ord: ++ord,
    x: 0, y: 0, vx: 0, vy: 0, r: PR, im: 0.5, d: 0.96, in: 0, lock: false
  };
  players.set(socket.id, p);
  socket.emit('init', { id: p.id, W, H, GD, GY1, GY2, POST, PR, BR, LIMIT });
  rebalance();
  roster();

  socket.on('in', v => { p.in = (Number(v) | 0) & 31; });
  socket.on('nick', n => {
    if (typeof n !== 'string') return;
    n = n.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 14);
    if (n) { p.n = n; roster(); }
  });
  socket.on('disconnect', () => {
    players.delete(socket.id);
    rebalance();
    roster();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Piksel Futbol çalışıyor: http://localhost:' + PORT));
