/*
Single-file demo: Tài Xỉu + Cổ Phiếu (server + client in one)
Run:
  npm init -y
  npm install express socket.io uuid
  node app.js
Open http://localhost:3000

Notes:
- Lightweight demo: data persisted in data.json (created in same folder).
- Simple token auth (no bcrypt) for quick testing.
- Admin step1: "0987654321" -> returns show:true
- Admin step2: "zxcvbnm" -> unlock admin actions
- Secret trigger to show admin input in UI is "admindzvailon" (client side)
- Change timing constants below as you like.
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, 'data.json');

// Timing / config (for demo use shorter intervals)
// Set DICE_ROLL_SECONDS = 180 for 3 minutes in production
const DICE_ROLL_SECONDS = 30; // demo 30s
const STOCK_UPDATE_SECONDS = 60; // demo 60s
const STOCK_AI_INTERVAL_SECONDS = 90; // demo 90s
const AI_BET_INTERVAL_SECONDS = 20; // demo 20s

const ADMIN_STEP1 = "0987654321";
const ADMIN_STEP2 = "zxcvbnm";
const ADMIN_SHOW_TRIGGER = "admindzvailon";

const STARTING_BALANCE = 10000000; // starting 10,000,000

// --- simple persistence ---
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      users: [],
      tokens: {}, // token -> userId
      ais: [],
      stocks: [],
      depositCodes: [],
      games: [], // pending bets / history entries
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  }
  const raw = fs.readFileSync(DATA_FILE);
  return JSON.parse(raw);
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
let DB = loadData();

// --- helpers ---
function findUserByUsername(u) { return DB.users.find(x => x.username === u); }
function findUserById(id) { return DB.users.find(x => x.id === id); }
function weightedChoice() {
  const r = Math.random() * 100;
  if (r < 39) return 'playerWin';
  if (r < 90) return 'playerLose';
  return 'push';
}
function rollForOutcome(outcome, betSide) {
  function makeDiceSum(sum) {
    for (let i=0;i<400;i++){
      const d1 = 1 + Math.floor(Math.random()*6)
      const d2 = 1 + Math.floor(Math.random()*6)
      const d3 = sum - d1 - d2
      if (d3 >=1 && d3 <=6) return [d1,d2,d3]
    }
    return [1+Math.floor(Math.random()*6),1+Math.floor(Math.random()*6),1+Math.floor(Math.random()*6)]
  }
  let targetSum;
  if (outcome === 'playerWin') {
    if (betSide === 'tai') targetSum = [11,12,13,14,15,16,17][Math.floor(Math.random()*7)]
    else targetSum = [4,5,6,7,8,9,10][Math.floor(Math.random()*7)]
  } else if (outcome === 'playerLose') {
    if (betSide === 'tai') targetSum = [4,5,6,7,8,9,10][Math.floor(Math.random()*7)]
    else targetSum = [11,12,13,14,15,16,17][Math.floor(Math.random()*7)]
  } else {
    targetSum = Math.random() < 0.5 ? 3 : 18
  }
  const dice = makeDiceSum(targetSum)
  return { dice, sum: dice.reduce((a,b)=>a+b,0), outcome }
}

// --- initial seed if empty ---
function seedIfEmpty() {
  if (!DB.stocks || DB.stocks.length < 10) {
    const syms = ['ALPHA','BETA','GAMMA','DELTA','EPS','ZETA','ETA','THETA','IOTA','KAPPA','LAMBDA','MU'];
    DB.stocks = syms.slice(0,10).map((s,idx)=>({
      id: uuidv4(), symbol: s, name: s + ' Corp', price: 500000000 + Math.floor(Math.random()*300000000), supply: 100, holders: {}, history: []
    }));
  }
  if (!DB.ais || DB.ais.length === 0) {
    DB.ais = [
      { id: 'AI1', name: 'AI_Master', balance: 5000000000, stocks: {} },
      { id: 'AI2', name: 'AI_Player', balance: 2000000000, stocks: {} }
    ]
  }
  saveData(DB)
}
seedIfEmpty();

// --- express + socket ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// serve demo page
app.get('/', (req,res) => {
  res.setHeader('Content-Type','text/html');
  res.send(DemoHTML());
});

// Simple REST: register/login (no bcrypt for demo) -> token stored server-side
app.post('/register', (req,res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send({ error: 'missing' });
  if (findUserByUsername(username)) return res.status(400).send({ error: 'exists' });
  const id = uuidv4();
  const user = { id, username, password, balance: STARTING_BALANCE, stocks: {}, history: [], _boughtOnce: {} };
  DB.users.push(user);
  saveData(DB);
  return res.send({ ok: true });
});
app.post('/login', (req,res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username);
  if (!user || user.password !== password) return res.status(400).send({ error: 'bad' });
  const token = uuidv4();
  DB.tokens[token] = user.id;
  saveData(DB);
  return res.send({ token, user: { id: user.id, username: user.username, balance: user.balance, stocks: user.stocks } });
});

// Admin endpoints (step1 & step2 + create/cancel deposit + stock actions)
app.post('/admin/show', (req,res) => {
  const { code } = req.body;
  if (code === ADMIN_STEP1) return res.send({ show: true });
  return res.status(403).send({ show: false });
});
app.post('/admin/unlock', (req,res) => {
  const { code } = req.body;
  if (code === ADMIN_STEP2) return res.send({ unlocked: true });
  return res.status(403).send({ unlocked: false });
});
app.post('/admin/create-deposit-code', (req,res) => {
  const { code, amount, days } = req.body;
  if (!code || !amount || amount > 200000) return res.status(400).send({ error: 'invalid' });
  if (DB.depositCodes.find(d=>d.code===code)) return res.status(400).send({ error: 'exists' });
  DB.depositCodes.push({ code, amount, days: Number(days||0), createdAt: Date.now(), disabled: false });
  saveData(DB);
  return res.send({ ok:true });
});
app.post('/admin/cancel-deposit', (req,res) => {
  const { code } = req.body;
  const d = DB.depositCodes.find(x=>x.code===code);
  if (!d) return res.status(404).send({ error:'not_found' });
  d.disabled = true; saveData(DB); return res.send({ ok:true });
});
app.post('/admin/stock-action', (req,res) => {
  const { symbol, action } = req.body; // up/down/bankrupt
  const s = DB.stocks.find(x=>x.symbol===symbol);
  if (!s) return res.status(404).send({ error:'no_stock' });
  if (action === 'up') s.price = Math.floor(s.price * 1.1);
  else if (action === 'down') s.price = Math.max(1, Math.floor(s.price * 0.9));
  else if (action === 'bankrupt') {
    s.price = 0;
    DB.users.forEach(u=>{
      const owned = (u.stocks && u.stocks[symbol])||0;
      if (owned>0) u.balance -= 200000000;
    });
  }
  saveData(DB);
  return res.send({ ok:true, stock:s });
});

// serve static helper for socket.io client (socket.io serves /socket.io/socket.io.js automatically)
// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log('Listening on', PORT));

// --- Socket.IO logic ---
io.on('connection', (socket) => {
  console.log('conn', socket.id);

  socket.on('join', (data) => {
    const token = data && data.token;
    if (!token || !DB.tokens[token]) { socket.data.user = null; socket.emit('joined', { ok:true, user:null }); return; }
    const uid = DB.tokens[token];
    const u = findUserById(uid);
    socket.data.user = u ? { id:u.id, username:u.username } : null;
    socket.emit('joined', { ok:true, user: u ? { id:u.id, username:u.username, balance:u.balance, stocks:u.stocks } : null });
  });

  // request stocks immediate
  socket.on('request:stocks', ()=>{
    socket.emit('stocks:update', DB.stocks);
  });

  // bet place -> create pending result, emit bet:started with readyAt, after timeout emit bet:ready
  socket.on('bet:place', async ({ amount, side })=>{
    // amount in integer
    await reloadDB();
    const tok = socket.handshake.query && socket.handshake.query.token; // not reliable; prefer prior join
    const user = socket.data.user ? findUserById(socket.data.user.id) : null;
    if (!user) { socket.emit('bet:error', { error:'not_logged' }); return; }
    if (![20000,50000,100000,200000,500000].includes(amount)) { socket.emit('bet:error',{ error:'bad_amount' }); return; }
    user.balance -= amount; // allow negative per spec
    const outcome = weightedChoice();
    const roll = rollForOutcome(outcome, side);
    let result = 'push';
    if (outcome === 'playerWin') { result = 'win'; user.balance += amount*2; }
    else if (outcome === 'playerLose') result = 'lose';
    // history
    user.history = user.history || [];
    const betId = uuidv4();
    const pending = { id: betId, userId: user.id, amount, side, result, dice: roll.dice, ts: Date.now(), readyAt: Date.now()+DICE_ROLL_SECONDS*1000 };
    DB.games.push({ type:'bet_pending', ...pending });
    user.history.push({ type:'bet', amount, side, result, dice: roll.dice, ts: Date.now() });
    saveData(DB);
    socket.emit('bet:started', { betId, readyAt: pending.readyAt });
    // schedule ready
    setTimeout(async ()=>{
      await reloadDB();
      const u2 = findUserById(user.id);
      socket.emit('bet:ready', { betId, dice: roll.dice, result, balance: u2.balance });
      io.emit('balances:update', { userId: user.id, balance: u2.balance });
    }, DICE_ROLL_SECONDS*1000);
  });

  socket.on('bet:reveal', ({ betId })=>{
    // just ack
    socket.emit('bet:revealed', { betId });
  });

  // stock buy
  socket.on('stock:buy', async ({ symbol, qty })=>{
    await reloadDB();
    const user = socket.data.user ? findUserById(socket.data.user.id) : null;
    if (!user) { socket.emit('stock:buy:result',{ error:'not_logged'}); return; }
    const s = DB.stocks.find(x=>x.symbol===symbol);
    if (!s) return socket.emit('stock:buy:result',{ error:'no_stock' });
    qty = Number(qty);
    if (qty < 30) return socket.emit('stock:buy:result',{ error:'min_30' });
    if (s.supply < qty) return socket.emit('stock:buy:result',{ error:'not_enough_supply' });
    const cost = qty * s.price;
    if (user.balance < cost) return socket.emit('stock:buy:result',{ error:'not_enough_money' });
    user.stocks = user.stocks || {};
    user._boughtOnce = user._boughtOnce || {};
    if (user._boughtOnce[symbol]) return socket.emit('stock:buy:result',{ error:'already_bought' });
    user.balance -= cost;
    user.stocks[symbol] = (user.stocks[symbol] || 0) + qty;
    user._boughtOnce[symbol] = true;
    s.supply -= qty;
    s.holders[user.id] = (s.holders[user.id]||0)+qty;
    user.history = user.history || [];
    user.history.push({ type:'stock_buy', symbol, qty, price:s.price, ts:Date.now() });
    saveData(DB);
    socket.emit('stock:buy:result', { ok:true, balance:user.balance, stocks:user.stocks });
    io.emit('stocks:update', DB.stocks);
  });

  // stock sell
  socket.on('stock:sell', async ({ symbol, qty })=>{
    await reloadDB();
    const user = socket.data.user ? findUserById(socket.data.user.id) : null;
    if (!user) { socket.emit('stock:sell:result',{ error:'not_logged'}); return; }
    const s = DB.stocks.find(x=>x.symbol===symbol);
    if (!s) return socket.emit('stock:sell:result',{ error:'no_stock' });
    qty = Number(qty);
    const owned = (user.stocks && user.stocks[symbol]) || 0;
    if (owned < qty) return socket.emit('stock:sell:result',{ error:'not_enough' });
    const revenue = qty * s.price;
    user.balance += revenue;
    user.stocks[symbol] -= qty;
    if (user.stocks[symbol] === 0) user._boughtOnce[symbol] = false;
    s.supply += qty;
    s.holders[user.id] = (s.holders[user.id]||0) - qty;
    user.history = user.history || [];
    user.history.push({ type:'stock_sell', symbol, qty, price:s.price, ts:Date.now() });
    saveData(DB);
    socket.emit('stock:sell:result', { ok:true, balance:user.balance, stocks:user.stocks });
    io.emit('stocks:update', DB.stocks);
  });

  // deposit with code
  socket.on('deposit:code', async ({ code })=>{
    await reloadDB();
    const user = socket.data.user ? findUserById(socket.data.user.id) : null;
    if (!user) { socket.emit('deposit:result',{ error:'not_logged'}); return; }
    const c = DB.depositCodes.find(d => d.code === code && !d.disabled);
    if (!c) return socket.emit('deposit:result',{ error:'invalid_code' });
    if (c.days && ((Date.now()-c.createdAt) > c.days*24*3600*1000)) return socket.emit('deposit:result',{ error:'expired' });
    user.balance += c.amount;
    c.disabled = true; user.history = user.history || []; user.history.push({ type:'deposit', code, amount:c.amount, ts:Date.now() });
    saveData(DB);
    socket.emit('deposit:result', { ok:true, balance:user.balance });
  });

  socket.on('get:history', async ()=>{
    await reloadDB();
    const user = socket.data.user ? findUserById(socket.data.user.id) : null;
    if (!user) { socket.emit('history', { error:'not_logged' }); return; }
    socket.emit('history', { history: user.history || [] });
  });
});

// reload DB helper
async function reloadDB() {
  DB = loadData();
}

// --- Stock ticker + AI loops ---
function runStockTicker() {
  setInterval(()=>{
    DB.stocks.forEach(s=>{
      // small random -10%..+10%
      const change = (Math.random() - 0.5) * 0.2;
      s.price = Math.max(1, Math.floor(s.price * (1 + change)));
      // append to history (keep last 120 points)
      s.history = s.history || [];
      s.history.push({ ts: Date.now(), price: s.price });
      if (s.history.length > 200) s.history.shift();
    });
    saveData(DB);
    io.emit('stocks:update', DB.stocks);
  }, STOCK_UPDATE_SECONDS*1000);
}
function runAIOps() {
  // AI bets
  setInterval(()=>{
    DB.ais.forEach(ai=>{
      const betOptions = [20000,50000,100000,200000,500000];
      const amount = betOptions[Math.floor(Math.random()*betOptions.length)];
      const side = Math.random() < 0.5 ? 'tai' : 'xiu';
      const outcome = weightedChoice();
      if (outcome === 'playerWin') ai.balance += amount;
      else if (outcome === 'playerLose') ai.balance -= amount;
    });
    saveData(DB);
    io.emit('ais:update', DB.ais);
  }, AI_BET_INTERVAL_SECONDS*1000);

  // AI stock trading
  setInterval(()=>{
    DB.ais.forEach(ai=>{
      const affordable = DB.stocks.filter(s => s.price <= ai.balance && s.supply > 0);
      if (affordable.length === 0) return;
      const pick = affordable[Math.floor(Math.random()*affordable.length)];
      const qty = Math.min(Math.floor(ai.balance / pick.price), Math.min(30, pick.supply));
      if (qty >= 30) {
        ai.balance -= qty * pick.price;
        ai.stocks[pick.symbol] = (ai.stocks[pick.symbol]||0) + qty;
        pick.supply -= qty;
        pick.holders[ai.id] = (pick.holders[ai.id]||0) + qty;
      }
    });
    saveData(DB);
    io.emit('ais:update', DB.ais);
    io.emit('stocks:update', DB.stocks);
  }, STOCK_AI_INTERVAL_SECONDS*1000);
}
runStockTicker();
runAIOps();

// --- Demo HTML (client) ---
function DemoHTML(){
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Tài Xỉu + Cổ Phiếu (Demo single-file)</title>
<style>
  body{ font-family: Arial, Helvetica, sans-serif; background:#071025; color:#e6eef8; margin:0; padding:16px; }
  .wrap{ max-width:1100px; margin:0 auto; }
  header{ text-align:center; margin-bottom:12px }
  .top{ display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap }
  .card{ background:#0b1220; padding:12px; border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.6); }
  .login input{ padding:6px; margin-right:6px; }
  .game-area{ display:flex; gap:12px; align-items:flex-start; margin-top:12px; flex-wrap:wrap }
  .col{ width:520px; }
  .cup{ width:260px; height:170px; perspective:1000px; cursor:pointer; margin:12px auto; display:flex; align-items:center; justify-content:center }
  .cup-inner{ width:100%; height:100%; transform-origin:center bottom; transition: transform 450ms; background:linear-gradient(180deg,#123046,#092233); border-radius:12px; display:flex; align-items:center; justify-content:center; }
  .cup-inner.closed{ transform: rotateX(0deg) }
  .cup-inner.open{ transform: rotateX(-60deg) translateY(-14px) }
  .cup-cover{ color:#fff; font-weight:700; padding:12px 16px; background:linear-gradient(180deg,#1b425f,#0e2736); border-radius:8px }
  .dice-result{ display:flex; gap:10px }
  .die{ width:56px; height:56px; background:#fff; color:#000; display:flex; align-items:center; justify-content:center; border-radius:8px; font-weight:800 }
  .bets button{ padding:8px 10px; margin:6px; border-radius:6px; border:none; cursor:pointer; background:#1f6feb; color:#fff }
  .stocks-list{ max-height:320px; overflow:auto; display:flex; flex-direction:column; gap:8px; margin-top:8px }
  .stock-row{ display:flex; justify-content:space-between; padding:8px; border-radius:6px; background:rgba(255,255,255,0.02); cursor:pointer }
  .stock-row.selected{ outline:2px solid rgba(31,111,235,0.2) }
  .admin{ margin-top:12px; }
  .small{ font-size:13px; color:#9fb0c8 }
  .status{ margin-top:8px }
  @media (max-width:1100px){ .col{ width:100% } .game-area{ flex-direction:column } }
</style>
</head>
<body>
  <div class="wrap">
    <header><h1>Tài Xỉu + Cổ Phiếu — Demo (single file)</h1></header>

    <div class="top">
      <div class="card login">
        <div id="auth-area">
          <input id="username" placeholder="username" />
          <input id="password" placeholder="password" type="password" />
          <button id="btn-register">Register</button>
          <button id="btn-login">Login</button>
        </div>
        <div id="user-info" style="display:none">
          Hi, <span id="u-name"></span> • Balance: <span id="u-balance"></span>
          <button id="btn-logout">Logout</button>
        </div>
      </div>

      <div class="card small">
        <div>Admin secret trigger (client-side) — để hiện ô admin nhập trong UI, gõ: <strong>${ADMIN_SHOW_TRIGGER}</strong> vào ô bên dưới và bấm Show</div>
        <input id="admin-trigger" placeholder="gõ bí mật để hiện admin" />
        <button id="admin-show">Show</button>
      </div>
    </div>

    <div class="game-area">
      <div class="card col" id="dice-card">
        <h3>Tài Xỉu</h3>
        <div class="cup" id="cup">
          <div class="cup-inner closed" id="cup-inner"><div id="cup-content" class="cup-cover">Chén (bấm để mở)</div></div>
        </div>
        <div id="countdown" class="small">Không có cược đang chờ</div>
        <div class="bets">
          <div><button class="bet-btn" data-amt="20000" data-side="tai">20,000 Tài</button><button class="bet-btn" data-amt="20000" data-side="xiu">20,000 Xỉu</button></div>
          <div><button class="bet-btn" data-amt="50000" data-side="tai">50,000 Tài</button><button class="bet-btn" data-amt="50000" data-side="xiu">50,000 Xỉu</button></div>
          <div><button class="bet-btn" data-amt="100000" data-side="tai">100,000 Tài</button><button class="bet-btn" data-amt="100000" data-side="xiu">100,000 Xỉu</button></div>
          <div><button class="bet-btn" data-amt="200000" data-side="tai">200,000 Tài</button><button class="bet-btn" data-amt="200000" data-side="xiu">200,000 Xỉu</button></div>
          <div><button class="bet-btn" data-amt="500000" data-side="tai">500,000 Tài</button><button class="bet-btn" data-amt="500000" data-side="xiu">500,000 Xỉu</button></div>
        </div>
        <div class="status" id="dice-status"></div>
      </div>

      <div class="card col" id="stocks-card">
        <h3>Thị trường cổ phiếu</h3>
        <div class="stocks-list" id="stocks-list"></div>
        <div style="margin-top:8px">
          <div>Chọn: <span id="selected-symbol">—</span></div>
          <div>Qty (min 30): <input id="qty" type="number" value="30" min="30" style="width:100px" /></div>
          <button id="btn-buy">Mua</button>
          <button id="btn-sell">Bán</button>
        </div>
        <div id="stock-detail" style="margin-top:8px"></div>
      </div>
    </div>

    <div class="game-area">
      <div class="card col admin" id="admin-card" style="display:none">
        <h3>Admin (bí mật)</h3>
        <div>
          Step1: <input id="adm-step1" placeholder="mã bước 1" /> <button id="adm-show">Show</button><br/>
          <div id="adm-step2-area" style="display:none; margin-top:6px;">
            Step2: <input id="adm-step2" placeholder="mã bước 2" /> <button id="adm-unlock">Unlock</button>
          </div>
          <div id="adm-actions" style="display:none; margin-top:8px;">
            <div>Create deposit code: <input id="dep-code" placeholder="code"/><input id="dep-amt" type="number" value="200000"/><input id="dep-days" type="number" value="30"/><button id="create-dep">Create</button></div>
            <div style="margin-top:6px">Stock action: symbol <input id="sa-symbol" style="width:80px"/> action <select id="sa-action"><option value="up">up</option><option value="down">down</option><option value="bankrupt">bankrupt</option></select> <button id="sa-go">Apply</button></div>
            <div style="margin-top:8px"><strong>Assistant Alerts</strong><div id="alerts"></div></div>
          </div>
        </div>
      </div>

      <div class="card col" id="history-card">
        <h3>Lịch sử & Trạng thái</h3>
        <div id="history-list" style="max-height:360px; overflow:auto"></div>
      </div>
    </div>

  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
(() => {
  const socket = io();
  let MY = { token:null, user:null };
  const $ = id => document.getElementById(id);

  // auth
  $('btn-register').onclick = async ()=>{
    const u = $('username').value.trim(), p = $('password').value;
    if (!u||!p) return alert('user/pass');
    const r = await fetch('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const j = await r.json();
    if (j.ok) alert('registered, login now'); else alert('err: '+JSON.stringify(j));
  };
  $('btn-login').onclick = async ()=>{
    const u = $('username').value.trim(), p = $('password').value;
    if (!u||!p) return alert('user/pass');
    const r = await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const j = await r.json();
    if (j.token) {
      MY.token = j.token; MY.user = j.user; localStorage.setItem('demo_token', MY.token);
      onLoggedIn();
      socket.emit('join', { token: MY.token });
    } else alert('login fail');
  };
  $('btn-logout').onclick = ()=>{ localStorage.removeItem('demo_token'); MY={token:null,user:null}; location.reload(); };

  // auto restore
  const saved = localStorage.getItem('demo_token');
  if (saved) { MY.token=saved; socket.emit('join',{token:MY.token}); }

  socket.on('joined', ({ user })=>{
    if (user) { MY.user = user; MY.token = localStorage.getItem('demo_token') || MY.token; onLoggedIn(); }
  });

  function onLoggedIn(){
    $('auth-area').style.display='none';
    $('user-info').style.display='block';
    $('u-name').innerText = MY.user.username;
    $('u-balance').innerText = MY.user.balance.toLocaleString();
    loadHistory();
  }

  socket.on('balances:update', ({ userId, balance })=>{
    if (MY.user && MY.user.id === userId) { $('u-balance').innerText = balance.toLocaleString(); }
  });

  // cup behavior
  let currentPending = null;
  let dice = [0,0,0];
  const cupInner = $('cup-inner'), cupContent = $('cup-content'), countdownEl = $('countdown'), diceStatus = $('dice-status');
  function renderCupClosed(){ cupInner.className='cup-inner closed'; cupContent.innerText = 'Chén (bấm để mở)'; }
  function renderCupOpen(){ cupInner.className='cup-inner open'; cupContent.innerHTML = '<div class="dice-result"><div class="die">'+dice[0]+'</div><div class="die">'+dice[1]+'</div><div class="die">'+dice[2]+'</div></div>'; }
  renderCupClosed();

  cupInner.onclick = ()=>{
    if (!currentPending || !currentPending.ready) { alert('Chưa có kết quả để mở hoặc đang chờ'); return; }
    renderCupOpen();
    socket.emit('bet:reveal', { betId: currentPending.betId });
    // show result in status
    diceStatus.innerText = 'Kết quả: ' + (currentPending.result || '?');
  };

  // bet buttons
  document.querySelectorAll('.bet-btn').forEach(b=>{
    b.onclick = ()=> {
      const amt = Number(b.dataset.amt), side = b.dataset.side;
      if (!MY.token) return alert('Login');
      socket.emit('bet:place', { amount: amt, side });
      diceStatus.innerText = 'Đã đặt cược ' + amt.toLocaleString() + ' vào ' + side + '.';
    };
  });

  // events
  socket.on('bet:started', ({ betId, readyAt })=>{
    currentPending = { betId, readyAt, ready:false };
    renderCupClosed();
    diceStatus.innerText = 'Đang xúc... sẵn sàng lúc ' + new Date(readyAt).toLocaleTimeString();
    startCountdown( Math.max(0, Math.floor((readyAt - Date.now())/1000)) );
  });
  socket.on('bet:ready', ({ betId, dice: d, result, balance })=>{
    currentPending = currentPending && currentPending.betId===betId ? { ...currentPending, ready:true, result } : { betId, ready:true, result };
    dice = d;
    $('u-balance').innerText = balance.toLocaleString();
    diceStatus.innerText = 'Kết quả sẵn sàng. Bấm chén để mở.';
  });

  function startCountdown(sec) {
    let s = sec;
    countdownEl.innerText = 'Thời gian chờ: ' + s + 's';
    const iv = setInterval(()=> {
      s--; if (s<=0){ clearInterval(iv); countdownEl.innerText = 'Sẵn sàng mở chén'; return; }
      countdownEl.innerText = 'Thời gian chờ: ' + s + 's';
    },1000);
  }

  // stocks UI
  let STOCKS = [];
  let selected = null;
  const stocksList = $('stocks-list'), selSym = $('selected-symbol'), qtyEl = $('qty'), stockDetail = $('stock-detail');

  function renderStocks(){
    stocksList.innerHTML = '';
    STOCKS.forEach(s=>{
      const el = document.createElement('div'); el.className='stock-row'; el.innerHTML = '<div><strong>'+s.symbol+'</strong> '+s.name+'</div><div><div>Giá: '+s.price.toLocaleString()+'</div><div>Supply: '+s.supply+'</div></div>';
      if (selected === s.symbol) el.classList.add('selected');
      el.onclick = ()=> { selected = s.symbol; selSym.innerText = selected; renderStocks(); renderDetail(); };
      stocksList.appendChild(el);
    });
  }

  function renderDetail(){
    if (!selected) { stockDetail.innerText = 'Chưa chọn cổ phiếu'; return; }
    const s = STOCKS.find(x=>x.symbol===selected);
    stockDetail.innerHTML = '<div>Giá hiện: '+s.price.toLocaleString()+'</div><div>Supply: '+s.supply+'</div>';
  }

  $('btn-buy').onclick = ()=> {
    if (!MY.token) return alert('Login');
    if (!selected) return alert('Chọn cổ phiếu');
    const qty = Number(qtyEl.value) || 0;
    if (qty < 30) return alert('Mua tối thiểu 30');
    socket.emit('stock:buy', { symbol: selected, qty });
  };
  $('btn-sell').onclick = ()=> {
    if (!MY.token) return alert('Login');
    if (!selected) return alert('Chọn cổ phiếu');
    const qty = Number(qtyEl.value) || 0;
    socket.emit('stock:sell', { symbol: selected, qty });
  };

  socket.on('stocks:update', (list)=>{
    STOCKS = list || [];
    renderStocks();
    renderDetail();
  });
  socket.emit('request:stocks');

  // buy/sell results
  socket.on('stock:buy:result', (r)=>{ if (r.error) alert('Buy error: '+r.error); else { alert('Mua ok'); } });
  socket.on('stock:sell:result', (r)=>{ if (r.error) alert('Sell error: '+r.error); else { alert('Bán ok'); } });

  // deposit code (simple input via prompt)
  // history
  async function loadHistory(){
    if (!MY.token) return;
    socket.emit('get:history');
  }
  socket.on('history', ({ history })=>{
    const el = $('history-list');
    el.innerHTML = '';
    if (!history || history.length===0) el.innerText = 'Không có lịch sử';
    else {
      history.slice().reverse().forEach(h=>{
        const d = new Date(h.ts || h.timestamp || Date.now());
        const li = document.createElement('div'); li.style.padding='6px'; li.style.borderBottom='1px solid rgba(255,255,255,0.03)';
        li.innerText = '['+d.toLocaleString()+'] ' + (h.type || JSON.stringify(h));
        el.appendChild(li);
      });
    }
  });

  // deposit via prompt (quick)
  // Admin UI reveal
  $('admin-show').onclick = ()=>{
    const v = $('admin-trigger').value.trim();
    if (v === '${ADMIN_SHOW_TRIGGER}') { $('admin-card').style.display='block'; alert('Admin input visible. Enter step1 then step2 to unlock actions.'); }
    else alert('Secret sai');
  };

  // admin step1/2 calls
  $('adm-show').onclick = async ()=> {
    const code = $('adm-step1').value.trim();
    const r = await fetch('/admin/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const j = await r.json();
    if (j.show) { $('adm-step2-area').style.display='block'; alert('Step1 ok. Nhập step2.'); }
    else alert('Step1 sai');
  };
  $('adm-unlock').onclick = async ()=> {
    const code = $('adm-step2').value.trim();
    const r = await fetch('/admin/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const j = await r.json();
    if (j.unlocked) { $('adm-actions').style.display='block'; alert('Admin unlocked'); } else alert('Step2 sai');
  };
  $('create-dep').onclick = async ()=> {
    const code = $('dep-code').value.trim(); const amount = Number($('dep-amt').value)||0; const days = Number($('dep-days').value)||0;
    const r = await fetch('/admin/create-deposit-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,amount,days})});
    const j = await r.json(); if (j.ok) alert('Created'); else alert('Err: '+JSON.stringify(j));
  };
  $('sa-go').onclick = async ()=> {
    const symbol = $('sa-symbol').value.trim(), action = $('sa-action').value;
    const r = await fetch('/admin/stock-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol,action})});
    const j = await r.json(); if (j.ok) { alert('Applied'); socket.emit('request:stocks'); } else alert('Err: '+JSON.stringify(j));
  };

  // alerts — for demo, server does not push assistant alerts separately in this minimal version
  // deposit using prompt
  window.addEventListener('keydown', (e)=>{ if (e.key==='d' && e.ctrlKey) { // Ctrl+D to deposit
    const code = prompt('Enter deposit code'); if (!code) return; socket.emit('deposit:code', { code }); 
  }});

  socket.on('deposit:result', (r)=>{ if (r.error) alert('Deposit err: '+r.error); else { alert('Nạp thành công. Balance: '+r.balance.toLocaleString()); $('u-balance').innerText = r.balance.toLocaleString(); } });

  // on load: try auto join token then fetch stocks
  if (MY.token) { socket.emit('join', { token: MY.token }); }
})();
</script>
</body>
</html>`;
}
