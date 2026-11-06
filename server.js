#!/usr/bin/env node
/* 三骰追点 · 局域网主机
 * 用法：node server.js  然后手机连同一 WiFi/热点，打开提示的地址。
 * 零依赖，只需 Node.js 16 以上。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const CLIENT_FILE = '三骰追点.html';

let version = 1;
let rollSeq = 0;
let dealSeq = 0;
let pidSeq = 0;

const state = {
  v: version,
  phase: 'lobby',            // lobby | deal | roll | result | finish
  players: [],
  order: [],
  chaserId: null,
  targetId: null,
  plan: null,
  rollsLeft: 0,
  history: [],
  lastRoll: null,
  result: null,
  resultTarget: null,
  canContinue: false,
  catches: 0,
  drinks: 0,
  rolling: false,
  dealSeq: 0
};

/* ---------------- 骰子与牌型 ---------------- */
function rnd(){ return 1 + Math.floor(Math.random() * 6); }
function jit(){ return Math.round(Math.random() * 26 - 13); }
function rollDice(){ return [rnd(), rnd(), rnd()].sort(function(a, b){ return a - b; }); }

function analyze(d){
  const s = d.slice().sort(function(a, b){ return a - b; });
  if(s[0] === s[2]) return {tier:4, label:'豹子', sub:'三个 ' + s[0], key:4000 + s[2]};
  if(s[1] === s[0] + 1 && s[2] === s[1] + 1)
    return {tier:3, label:'顺子', sub:s[0] + '-' + s[1] + '-' + s[2], key:3000 + s[0]};
  let pv = -1, sv = -1;
  if(s[0] === s[1]){ pv = s[0]; sv = s[2]; }
  else if(s[1] === s[2]){ pv = s[2]; sv = s[0]; }
  if(pv > 0) return {tier:2, label:'对子', sub:'对 ' + pv + ' 带 ' + sv, key:2000 + pv * 10 + sv};
  return {tier:1, label:'杂牌', sub:s[2] + ' ' + s[1] + ' ' + s[0], key:1000 + s[2] * 100 + s[1] * 10 + s[0]};
}

function findP(id){
  for(let i = 0; i < state.players.length; i++) if(state.players[i].id === id) return state.players[i];
  return null;
}

/* 名次按实际牌面全量重排；追平算追上时把刚摇出的人排到对方前面 */
function rankByDice(prefer){
  const sorted = state.players.slice().sort(function(a, b){ return b.res.key - a.res.key; });
  state.order = sorted.map(function(p){ return p.id; });
  if(prefer){
    const ci = state.order.indexOf(prefer.chaser);
    const ti = state.order.indexOf(prefer.target);
    if(ci > -1 && ti > -1 && ci > ti){
      state.order.splice(ci, 1);
      const t2 = state.order.indexOf(prefer.target);
      state.order.splice(t2, 0, prefer.chaser);
    }
  }
}
function setPair(){
  const n = state.order.length;
  state.targetId = state.order[n - 2] || null;
  state.chaserId = state.order[n - 1] || null;
}

/* ---------------- 广播 ---------------- */
const waiters = [];
function bump(){
  state.v = ++version;
  const list = waiters.splice(0);
  list.forEach(function(w){
    clearTimeout(w.timer);
    try{ w.res.end(JSON.stringify({ok:true, state:state})); }catch(e){}
  });
}

/* ---------------- 游戏流程 ---------------- */
function startGame(){
  state.catches = 0;
  state.drinks = 0;
  state.history = [];
  state.lastRoll = null;
  state.result = null;
  state.resultTarget = null;
  state.canContinue = false;
  state.plan = null;
  state.rolling = false;
  state.dealSeq = ++dealSeq;
  state.players.forEach(function(p){
    p.dice = rollDice();
    p.j = [jit(), jit(), jit()];
    p.res = analyze(p.dice);
    p.drinks = 0;
  });
  rankByDice();
  setPair();
  state.phase = 'deal';
}

function applyOutcome(dice, res){
  const chaser = findP(state.chaserId);
  const target = findP(state.targetId);
  if(!chaser || !target){ state.rolling = false; bump(); return; }

  state.history.push(res);

  if(res.key >= target.res.key){
    chaser.dice = dice.slice();
    chaser.res = res;
    rankByDice({chaser: chaser.id, target: target.id});
    state.resultTarget = {name: target.name, res: target.res, dice: target.dice.slice(), skin: target.skin, j: target.j.slice()};
    state.result = 'success';
    state.catches += 1;
    const idx = state.order.indexOf(chaser.id);
    state.canContinue = state.rollsLeft > 0 && idx > 0;
    state.phase = 'result';
  }else if(state.rollsLeft <= 0){
    if(state.plan === 'five'){ chaser.drinks += 1; state.drinks += 1; }
    state.result = 'fail';
    state.canContinue = false;
    state.phase = 'result';
  }
  state.rolling = false;
  bump();
}

/* ---------------- 动作处理 ---------------- */
function handleAction(body){
  const type = body.type;
  const pid = body.pid;

  if(type === 'join'){
    const exist = findP(pid);
    const name = String(body.name || '玩家').trim().slice(0, 8) || '玩家';
    const skin = Math.max(0, Math.min(4, Number(body.skin) || 0));
    if(exist){
      exist.name = name;
      exist.skin = skin;
      bump();
      return {ok:true, pid:exist.id};
    }
    if(state.phase !== 'lobby') return {ok:false, err:'已经开局了，等这一局散场再进'};
    if(state.players.length >= 10) return {ok:false, err:'满 10 人了'};
    const id = 'p' + (++pidSeq);
    state.players.push({
      id: id, name: name, skin: skin,
      dice: [1, 1, 1], j: [jit(), jit(), jit()], res: null, drinks: 0
    });
    bump();
    return {ok:true, pid: id};
  }

  if(type === 'skin'){
    const p = findP(pid);
    if(!p) return {ok:false, err:'你不在房间里'};
    if(state.phase !== 'lobby') return {ok:false, err:'开局后不能再换'};
    p.skin = Math.max(0, Math.min(4, Number(body.skin) || 0));
    bump();
    return {ok:true};
  }

  if(type === 'start'){
    if(state.phase !== 'lobby') return {ok:false, err:'正在玩着呢'};
    if(state.players.length < 2) return {ok:false, err:'至少 2 人'};
    startGame();
    bump();
    return {ok:true};
  }

  const p = findP(pid);

  if(type === 'plan'){
    if(state.phase !== 'deal') return {ok:false, err:'现在不用选'};
    if(pid !== state.chaserId) return {ok:false, err:'不是你追'};
    if(body.plan === 'ten'){
      p.drinks += 1; state.drinks += 1;
      state.rollsLeft = 10;
    }else{
      state.rollsLeft = 5;
    }
    state.plan = body.plan === 'ten' ? 'ten' : 'five';
    state.history = [];
    state.phase = 'roll';
    bump();
    return {ok:true};
  }

  if(type === 'roll'){
    if(state.phase !== 'roll' || state.rolling) return {ok:false, err:'现在不能摇'};
    if(pid !== state.chaserId) return {ok:false, err:'不是你追'};
    if(state.rollsLeft <= 0) return {ok:false, err:'次数用完了'};
    state.rollsLeft -= 1;
    const dice = rollDice();
    const res = analyze(dice);
    state.lastRoll = {seq: ++rollSeq, dice: dice, res: res, at: Date.now()};
    state.rolling = true;
    bump();
    setTimeout(function(){ applyOutcome(dice, res); }, 900);
    return {ok:true};
  }

  if(type === 'continue'){
    if(state.phase !== 'result' || state.result !== 'success') return {ok:false, err:'现在不能继续'};
    if(pid !== state.chaserId) return {ok:false, err:'不是你追'};
    if(!state.canContinue) return {ok:false, err:'没次数了'};
    const idx = state.order.indexOf(state.chaserId);
    if(idx <= 0) return {ok:false, err:'已经到顶了'};
    state.targetId = state.order[idx - 1];
    state.history = [];
    state.result = null;
    state.resultTarget = null;
    state.rolling = false;
    state.phase = 'roll';
    bump();
    return {ok:true};
  }

  if(type === 'stop'){
    if(state.phase !== 'result') return {ok:false, err:'现在不能收手'};
    if(pid !== state.chaserId) return {ok:false, err:'不是你追'};
    setPair();
    state.history = [];
    state.plan = null;
    state.result = null;
    state.resultTarget = null;
    state.canContinue = false;
    state.phase = 'deal';
    bump();
    return {ok:true};
  }

  if(type === 'again'){
    if(state.phase !== 'result') return {ok:false, err:'现在不能继续'};
    if(pid !== state.chaserId) return {ok:false, err:'不是你追'};
    setPair();
    state.history = [];
    state.plan = null;
    state.result = null;
    state.resultTarget = null;
    state.canContinue = false;
    state.phase = 'deal';
    bump();
    return {ok:true};
  }

  if(type === 'surrender'){
    if(!p) return {ok:false, err:'你不在房间里'};
    state.rolling = false;
    state.phase = 'finish';
    bump();
    return {ok:true};
  }

  if(type === 'restart'){
    if(state.phase !== 'finish') return {ok:false, err:'还没散场'};
    startGame();
    bump();
    return {ok:true};
  }

  if(type === 'lobby'){
    if(state.phase !== 'finish') return {ok:false, err:'还没散场'};
    state.phase = 'lobby';
    bump();
    return {ok:true};
  }

  return {ok:false, err:'未知动作'};
}

/* ---------------- HTTP ---------------- */
function sendJSON(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer(function(req, res){
  let url;
  try{ url = new URL(req.url, 'http://localhost'); }catch(e){ return sendJSON(res, 400, {ok:false}); }

  if(url.pathname === '/' || url.pathname === '/index.html'){
    let html = '';
    try{
      html = fs.readFileSync(path.join(__dirname, CLIENT_FILE), 'utf8');
    }catch(e){
      res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'});
      return res.end('找不到 ' + CLIENT_FILE + '，请确认它和 server.js 在同一个文件夹里。');
    }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    return res.end(html);
  }

  if(url.pathname === '/api/state'){
    const since = Number(url.searchParams.get('since') || 0);
    if(since !== state.v){
      return sendJSON(res, 200, {ok:true, state:state});
    }
    const w = {res:res, timer:null};
    w.timer = setTimeout(function(){
      const i = waiters.indexOf(w);
      if(i > -1) waiters.splice(i, 1);
      try{ sendJSON(res, 200, {ok:true, state:state}); }catch(e){}
    }, 20000);
    waiters.push(w);
    req.on('close', function(){
      const i = waiters.indexOf(w);
      if(i > -1) waiters.splice(i, 1);
      clearTimeout(w.timer);
    });
    return;
  }

  if(url.pathname === '/api/action'){
    let raw = '';
    req.on('data', function(chunk){
      raw += chunk;
      if(raw.length > 1e5) req.destroy();
    });
    req.on('end', function(){
      let body = {};
      try{ body = JSON.parse(raw || '{}'); }catch(e){ return sendJSON(res, 400, {ok:false, err:'参数错误'}); }
      let out;
      try{ out = handleAction(body); }catch(e){ out = {ok:false, err:'服务器出错'}; }
      sendJSON(res, 200, out);
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('404');
});

server.listen(PORT, '0.0.0.0', function(){
  const nets = os.networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach(function(k){
    (nets[k] || []).forEach(function(n){
      if(n.family === 'IPv4' && !n.internal) ips.push(n.address);
    });
  });
  console.log('');
  console.log('  三骰追点 · 局域网主机已启动');
  console.log('  ------------------------------------');
  if(ips.length){
    ips.forEach(function(ip){
      console.log('  手机打开：http://' + ip + ':' + PORT);
    });
  }else{
    console.log('  没有检测到局域网地址，检查是否连上了 WiFi');
  }
  console.log('');
  console.log('  手机和这台设备连同一个 WiFi / 热点即可，不需要外网。');
  console.log('  关掉这个窗口就结束。');
  console.log('');
});
