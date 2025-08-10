import { BOARD, STAGING, ENEMY_STAGING, ROLE_ARCS, SQUADS } from './staging.js';

// ======= DOM refs
const elBoard = document.getElementById('board');
const elWave = document.getElementById('wave');
const elMana = document.getElementById('mana');
const elSouls = document.getElementById('souls');
const btnStart = document.getElementById('btnStart');
const btnSpeed = document.getElementById('btnSpeed');
const btnReset = document.getElementById('btnReset');

// ======= Layout (responsive)
function fitBoard(){
  const w = elBoard.clientWidth, h = elBoard.clientHeight;
  const cell = Math.floor(Math.min(w/BOARD.W, h/BOARD.H));
  elBoard.style.setProperty('--cell', cell+'px');
}
addEventListener('resize', fitBoard, {passive:true});
new ResizeObserver(fitBoard).observe(elBoard);

// ======= State
let units = [];          // {id, side, role, x,y, hp,maxhp, atk, rng, cd, tAtk, tMove}
let corpses = [];        // [{x,y,t}]
let idSeq = 1;
let running = false, speed = 1;
let wave = 0, souls = 0;
const necro = { mana: 0, manaMax: 30, manaRegen: 5, softCap: 18 };

// Simple stats
const STATS = {
  Warrior:     {hp:28, atk:6,  rng:1, cd:0.8},
  Archer:      {hp:18, atk:7,  rng:4, cd:1.0},
  Wraith:      {hp:14, atk:9,  rng:1, cd:0.7}, // fast melee
  Golem:       {hp:60, atk:10, rng:1, cd:1.2}, // tank
  EnemyMelee:  {hp:24, atk:5,  rng:1, cd:0.9},
  EnemyArcher: {hp:16, atk:6,  rng:4, cd:1.0}
};

// Summon priority (no placement — AI spawns for you)
const SUMMON_PRIORITY = [
  {role:'Golem', upTo:1},
  {role:'Wraith', upTo:2},
  {role:'Warrior', upTo:999},
  {role:'Archer', upTo:2}
];
const SUMMON_COST = { Warrior:4, Archer:5, Wraith:6, Golem:10 };

// ======= Helpers
const key = (x,y)=>x+'_'+y;
function inBounds(x,y){ return x>=0 && x<BOARD.W && y>=0 && y<BOARD.H; }
function occMap(){
  const map = new Map();
  for (const u of units) if (u.hp>0) map.set(key(u.x,u.y), u);
  return map;
}
function nearestEnemy(u){
  let best=null,bd=1e9;
  for (const v of units){
    if (v.hp<=0 || v.side===u.side) continue;
    const d = Math.abs(v.x-u.x)+Math.abs(v.y-u.y);
    if (d<bd){bd=d;best=v;}
  }
  return best;
}
function manhattan(a,b){ return Math.abs(a.x-b.x)+Math.abs(a.y-b.y); }

// ======= DOM unit creation & sync
function makeEl(u){
  const d = document.createElement('div'); d.className = `u ${u.side} role-${u.role}`;
  const badge = document.createElement('div'); badge.className='badge'; badge.textContent = u.side==='ally' ? u.role[0] : 'E';
  const hp = document.createElement('div'); hp.className='hp'; const bar=document.createElement('i'); hp.appendChild(bar);
  d.appendChild(badge); d.appendChild(hp); elBoard.appendChild(d); u.el = d; u.bar = bar;
}
function placeEl(u){
  const cell = parseInt(getComputedStyle(elBoard).getPropertyValue('--cell'))||48;
  u.el.style.left = (u.x*cell)+'px';
  u.el.style.top  = (u.y*cell)+'px';
}
function syncEl(u){
  if (!u.el) makeEl(u);
  placeEl(u);
  u.bar.style.width = Math.max(0, Math.round(100*u.hp/u.maxhp))+'%';
}

// ======= Staging allocation
function findSpawnSlot(side, role, taken){
  const arcs = ROLE_ARCS[role] || ['midArc'];
  const pool = (side==='ally') ? STAGING : ENEMY_STAGING;
  for (const arc of arcs){
    const list = pool[arc]||[];
    for (const s of list){
      const k = key(s.x,s.y);
      if (!taken.has(k) && !units.some(u=>u.hp>0 && u.x===s.x && u.y===s.y)) return {x:s.x,y:s.y};
    }
  }
  // fallback: nearest to necro/enemy backline
  let best=null, bd=1e9;
  const x0 = (side==='ally') ? STAGING.necroPos.x : BOARD.W-2;
  for (let x=2; x<=11; x++){
    for (let y=0; y<BOARD.H; y++){
      const k = key(x,y);
      if (taken.has(k)) continue;
      if (units.some(u=>u.hp>0 && u.x===x && u.y===y)) continue;
      const d = Math.abs(x-x0)+Math.abs(y-STAGING.necroPos.y);
      if (d<bd){bd=d;best={x,y};}
    }
  }
  return best;
}

function spawnOne(side, role, xy){
  const s = STATS[role];
  const u = { id:idSeq++, side, role, x:xy.x, y:xy.y, hp:s.hp, maxhp:s.hp, atk:s.atk, rng:s.rng, cd:s.cd, tAtk:0, tMove:0, el:null, bar:null };
  units.push(u); syncEl(u); return u;
}
function spawnSquad(side, role){
  const size = (SQUADS[role]?.size)||1;
  const taken = new Set();
  const spawned = [];
  for (let i=0;i<size;i++){
    const xy = findSpawnSlot(side, role, taken);
    if (!xy) break;
    taken.add(key(xy.x,xy.y));
    spawned.push(spawnOne(side, role, xy));
  }
  return spawned.length;
}

// ======= Enemy wave generation
function spawnEnemiesForWave(n){
  // Simple ramp: more melee, add archers every 2 waves
  const packs = [];
  packs.push({role:'EnemyMelee', count: 2 + Math.floor(n/2)});
  if (n>=2) packs.push({role:'EnemyArcher', count: 1 + Math.floor((n-1)/3)});
  // place in squads
  for (const p of packs){
    let left = p.count;
    while (left>0){ spawnSquad('enemy', p.role); left -= SQUADS[p.role].size; }
  }
}

// ======= Necromancer summon engine (no placement)
function countAlliesByRole(role){ return units.filter(u=>u.side==='ally' && u.role===role && u.hp>0).length; }
function allyCount(){ return units.filter(u=>u.side==='ally' && u.hp>0).length; }

function summonAI(dt){
  necro.mana = Math.min(necro.manaMax, necro.mana + necro.manaRegen*dt);
  // Spend while we can and under soft cap
  let guard = 16; // safety to avoid infinite loops
  while (guard-- > 0){
    if (allyCount() >= necro.softCap) break;
    // pick first affordable priority that is under cap
    let picked = null;
    for (const pr of SUMMON_PRIORITY){
      const have = countAlliesByRole(pr.role);
      if (have < pr.upTo && necro.mana >= (SUMMON_COST[pr.role]||4)){ picked = pr.role; break; }
    }
    if (!picked) break;
    const cost = SUMMON_COST[picked];
    const spawned = spawnSquad('ally', picked);
    if (spawned>0) necro.mana -= cost;
    else break;
  }
}

// ======= Movement & combat
function stepUnit(u, dt, occ){
  if (u.hp<=0) return;
  u.tMove -= dt; if (u.tMove>0) return;
  const target = nearestEnemy(u); if (!target) return;
  const dx = Math.sign(target.x - u.x), dy = Math.sign(target.y - u.y);
  const dist = manhattan(u, target);
  // Attack?
  u.tAtk -= dt;
  const inMelee = (dist===1);
  const inRange = (u.rng>1 && dist <= u.rng);
  if (u.tAtk<=0 && (inMelee || inRange)){
    target.hp -= u.atk;
    if (target.hp<=0){
      target.hp = 0;
      // leave corpse
      corpses.push({x:target.x,y:target.y,t:3});
    }
    u.tAtk = u.cd;
    return;
  }
  // Move (melee & ranged kite)
  const next = {x:u.x, y:u.y};
  if (u.rng>1){
    // ranged: hold ground unless adjacent; if adjacent, try step back
    if (dist===1){
      const back = {x: Math.max(2, u.x-1), y:u.y};
      if (inBounds(back.x,back.y) && !occ.has(key(back.x,back.y))) { next.x=back.x; next.y=back.y; }
    }else{
      // small shuffle forward to keep pressure (every so often)
      if (Math.random()<0.2){
        const step = {x: Math.min(BOARD.W-3, u.x+1), y:u.y};
        if (!occ.has(key(step.x,step.y))) { next.x=step.x; next.y=step.y; }
      }
    }
  }else{
    // melee: try straight toward, then sidestep
    const try1 = {x:u.x+dx, y:u.y};
    const try2 = {x:u.x, y:u.y+dy};
    const try3 = {x:u.x+dx, y:u.y+dy}; // diagonal nudge
    if (inBounds(try1.x,try1.y) && !occ.has(key(try1.x,try1.y))) { next.x=try1.x; next.y=try1.y; }
    else if (inBounds(try2.x,try2.y) && !occ.has(key(try2.x,try2.y))) { next.x=try2.x; next.y=try2.y; }
    else if (inBounds(try3.x,try3.y) && !occ.has(key(try3.x,try3.y))) { next.x=try3.x; next.y=try3.y; }
  }
  if (next.x!==u.x || next.y!==u.y){
    u.x=next.x; u.y=next.y; u.tMove = 0.15; // move cooldown
  }
}

// ======= Round handling
function startWave(){
  if (running) return;
  running = true; wave += 1;
  elWave.textContent = `Wave ${wave}`;
  // small reset & opening summons
  necro.mana = Math.min(necro.manaMax, necro.mana + 8);
  // enemies
  spawnEnemiesForWave(wave);
}

function resetRun(){
  running=false; speed=1; wave=0; souls=0; necro.mana=0;
  for (const u of units) if (u.el) u.el.remove();
  units.length=0; corpses.length=0;
  // Spawn the necromancer as a visible marker (doesn’t fight yet)
  const nec = { id:idSeq++, side:'ally', role:'Necromancer', x:STAGING.necroPos.x, y:STAGING.necroPos.y,
    hp:999, maxhp:999, atk:0, rng:0, cd:999, tAtk:999, tMove:999 };
  nec.el = document.createElement('div'); nec.el.className='u necro ally';
  const b = document.createElement('div'); b.className='badge'; b.textContent='Necro'; nec.el.appendChild(b);
  const hp = document.createElement('div'); hp.className='hp'; const bar=document.createElement('i'); hp.appendChild(bar); nec.el.appendChild(hp);
  elBoard.appendChild(nec.el); placeEl(nec);
  elMana.textContent = `Mana ${Math.floor(necro.mana)}`;
  elSouls.textContent = `Souls ${souls}`;
}

function waveOver(){
  const allies = units.some(u=>u.side==='ally' && u.role!=='Necromancer' && u.hp>0);
  const enemies = units.some(u=>u.side==='enemy' && u.hp>0);
  if (!enemies){
    running=false; souls += 2 + Math.floor(wave/3);
    elSouls.textContent = `Souls ${souls}`;
    btnStart.textContent = 'Next Wave';
  }
  if (!allies && enemies){
    running=false; btnStart.textContent = 'Retry (Reset)'; // brutal early loss
  }
}

// ======= Loop
let tickMs = 100; // 10 Hz
setInterval(()=>{
  const dt = (tickMs/1000)*speed;

  // decay corpses (visual only in r0)
  for (const c of corpses) c.t -= dt;
  corpses = corpses.filter(c=>c.t>0); // (You can render them in r1)

  if (running){
    summonAI(dt);
    const map = occMap();
    // step + attack
    for (const u of units){
      if (u.hp>0 && u.role!=='Necromancer') stepUnit(u, dt, map);
    }
    // remove dead (leave element to fade? r0: just clean)
    for (const u of units){
      if (u.hp<=0 && u.el){ u.el.remove(); u.el=null; }
    }
    units = units.filter(u=>u.hp>0 || u.role==='Necromancer');
    // check end
    waveOver();
  }

  // sync UI
  for (const u of units) if (u.el) syncEl(u);
  elMana.textContent = `Mana ${Math.floor(necro.mana)}`;
}, tickMs);

// ======= Buttons
btnStart.onclick = ()=>{
  if (btnStart.textContent.startsWith('Retry')) { resetRun(); btnStart.textContent='Start Wave'; return; }
  startWave();
};
btnSpeed.onclick = ()=>{
  speed = (speed===1)?2:(speed===2)?3:1;
  btnSpeed.textContent = `Speed ×${speed}`;
};
btnReset.onclick = ()=>{ resetRun(); btnStart.textContent='Start Wave'; };

// boot
fitBoard(); resetRun();
