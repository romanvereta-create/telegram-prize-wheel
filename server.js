const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_PIN = String(process.env.ADMIN_PIN || '');
const DEMO_MODE = String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true';

const NAMES = ['София','Вика','Саша','Яромир','Мария','Матвей'];
const LEVELS = [
  '🥇 Суперприз',
  '🥈 Большой приз',
  '🥉 Средний приз',
  '🎮 Малый приз',
  '🎁 Финальный бонус A',
  '🎉 Финальный бонус B'
];
const rooms = new Map();

function freshRoom(){
  return {
    students: NAMES.map((name,i)=>({id:`s${i+1}`,name,stars:0,active:true})),
    level: 0,
    history: [],
    spinning: false,
    completed: false,
    allowedSpinnerUserId: null,
    allowedSpinnerName: null
  };
}
function getRoom(id){ if(!rooms.has(id)) rooms.set(id,freshRoom()); return rooms.get(id); }
function publicState(r){
  return {
students:r.students, level:r.level, levels:LEVELS,
    history:r.history, spinning:r.spinning, completed:r.completed,
    allowedSpinnerName:r.allowedSpinnerName
  };
}
function tickets(r,s){ return Math.max(0, Number(s.stars||0)); }
function active(r){ return r.students.filter(s=>s.active); }
function chooseWeighted(r,list){
  const total=list.reduce((sum,s)=>sum+tickets(r,s),0);
  if(total<=0) return list[crypto.randomInt(list.length)];
  let x=crypto.randomInt(total);
  for(const s of list){ x-=tickets(r,s); if(x<0) return s; }
  return list[list.length-1];
}
function verifyTelegram(initData){
  if(!BOT_TOKEN) throw new Error('BOT_TOKEN не задан на сервере');
  const p=new URLSearchParams(initData||'');
  const hash=p.get('hash');
  if(!hash) throw new Error('Нет подписи Telegram');
  p.delete('hash');
  const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const calc=crypto.createHmac('sha256',secret).update(check).digest('hex');
  const a=Buffer.from(calc,'hex'), b=Buffer.from(hash,'hex');
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('Подпись Telegram не прошла проверку');
  const authDate=Number(p.get('auth_date')||0);
  if(!authDate || Math.abs(Math.floor(Date.now()/1000)-authDate)>86400) throw new Error('Открой приложение из Telegram заново');
  const chatInstance=p.get('chat_instance');
  if(!chatInstance) throw new Error('Открой Mini App именно из общей группы Telegram');
  let user=null;
  try{ user=JSON.parse(p.get('user')||'null'); }catch{}
  return {roomId:`tg:${chatInstance}`,user};
}
function displayName(u){
  if(!u) return 'Участник';
  return [u.first_name,u.last_name].filter(Boolean).join(' ').trim() || u.username || 'Участник';
}
async function emitTurnPermissions(roomId){
  const r=getRoom(roomId);
  const sockets=await io.in(roomId).fetchSockets();
  for(const sk of sockets){
    const uid=String(sk.data.user?.id ?? '');
    const canSpin=!!sk.data.admin || (!!r.allowedSpinnerUserId && uid===String(r.allowedSpinnerUserId));
    sk.emit('spin-permission',{canSpin,allowedSpinnerName:r.allowedSpinnerName});
  }
}
async function emitOnlineUsers(roomId){
  const sockets=await io.in(roomId).fetchSockets();
  const seen=new Map();
  for(const sk of sockets){
    const u=sk.data.user||{};
    const uid=String(u.id ?? sk.id);
    if(!seen.has(uid)) seen.set(uid,{userId:uid,name:displayName(u),username:u.username||''});
  }
  const list=[...seen.values()];
  for(const sk of sockets){
    if(sk.data.admin) sk.emit('online-users',list);
  }
}
function emitState(roomId){
  io.to(roomId).emit('state',publicState(getRoom(roomId)));
  emitTurnPermissions(roomId);
  emitOnlineUsers(roomId);
}

io.use((socket,next)=>{
  try{
    const initData=socket.handshake.auth?.initData||'';
    if(DEMO_MODE && !initData){
      socket.data.roomId=`demo:${socket.handshake.auth?.demoRoom||'main'}`;
      socket.data.user={id:`demo-${crypto.randomUUID()}`,first_name:'Участник'};
      return next();
    }
    const verified=verifyTelegram(initData);
    socket.data.roomId=verified.roomId;
    socket.data.user=verified.user;
    next();
  }catch(e){ next(new Error(e.message)); }
});

io.on('connection',socket=>{
  const roomId=socket.data.roomId;
  if(socket.data.user && socket.data.user.id==null) socket.data.user.id=`anon-${socket.id}`;
  socket.join(roomId);
  socket.data.admin=false;
  emitState(roomId);
  io.to(roomId).emit('presence',{count:io.sockets.adapter.rooms.get(roomId)?.size||1});

  socket.on('admin-login',(pin,cb=()=>{})=>{
    if(!ADMIN_PIN || String(pin)!==ADMIN_PIN) return cb({ok:false,error:'Неверный PIN'});
    socket.data.admin=true; cb({ok:true}); socket.emit('admin',{ok:true}); emitTurnPermissions(roomId); emitOnlineUsers(roomId);
  });

  socket.on('save',(payload,cb=()=>{})=>{
    if(!socket.data.admin) return cb({ok:false,error:'Только преподаватель'});
    const r=getRoom(roomId); if(r.spinning) return cb({ok:false,error:'Сейчас идёт выбор'});
    if(!Array.isArray(payload.students)||payload.students.length!==6) return cb({ok:false,error:'Нужно 6 участников'});
    r.students=r.students.map((old,i)=>({
      ...old,
      name:String(payload.students[i].name||old.name).trim().slice(0,24)||old.name,
      stars:Math.max(0,Math.min(100,Number(payload.students[i].stars)||0))
    }));
    emitState(roomId); cb({ok:true});
  });

  socket.on('set-spinner',(payload,cb=()=>{})=>{
    if(!socket.data.admin) return cb({ok:false,error:'Только преподаватель'});
    const r=getRoom(roomId);
    if(r.spinning) return cb({ok:false,error:'Сейчас колесо вращается'});
    if(r.completed) return cb({ok:false,error:'Месяц уже завершён'});
    const userId=String(payload?.userId||'');
    if(!userId) return cb({ok:false,error:'Выбери участника'});
    io.in(roomId).fetchSockets().then(sockets=>{
      const target=sockets.find(sk=>String(sk.data.user?.id ?? '')===userId);
      if(!target) return cb({ok:false,error:'Этот участник сейчас не подключён'});
      r.allowedSpinnerUserId=userId;
      r.allowedSpinnerName=displayName(target.data.user);
      emitState(roomId);
      cb({ok:true,name:r.allowedSpinnerName});
    }).catch(()=>cb({ok:false,error:'Не удалось назначить ход'}));
  });

  socket.on('spin',(_,cb=()=>{})=>{
    const r=getRoom(roomId);
    const uid=String(socket.data.user?.id ?? '');
    const allowed=!!socket.data.admin || (!!r.allowedSpinnerUserId && uid===String(r.allowedSpinnerUserId));
    if(!allowed) return cb({ok:false,error:r.allowedSpinnerName ? `Сейчас крутит ${r.allowedSpinnerName}` : 'Преподаватель ещё не назначил, кто крутит'});
    if(r.spinning) return cb({ok:false,error:'Уже вращается'}); if(r.completed) return cb({ok:false,error:'Месяц уже завершён'});
    const list=active(r); if(list.length<2) return cb({ok:false,error:'Недостаточно участников'});
    const winner=chooseWeighted(r,list);
    const duration=5200;
    const participants=list.map(s=>({id:s.id,name:s.name,stars:s.stars,tickets:tickets(r,s)}));
    const u=socket.data.user||{};
    const spinnerName=displayName(u);
    r.spinning=true;
    r.allowedSpinnerUserId=null;
    r.allowedSpinnerName=null;
    io.to(roomId).emit('spin-start',{duration,participants,winnerId:winner.id,level:r.level,spinnerName});
    emitTurnPermissions(roomId);
    cb({ok:true});
    setTimeout(()=>{
      if(list.length===2){
        const other=list.find(s=>s.id!==winner.id);
        r.history.push({level:4,name:winner.name});
        r.history.push({level:5,name:other.name});
        winner.active=false; other.active=false; r.completed=true; r.level=6;
        io.to(roomId).emit('spin-result',{winner:winner.name,finalOther:other.name,final:true});
      }else{
        r.history.push({level:r.level,name:winner.name});
        winner.active=false; r.level+=1;
        io.to(roomId).emit('spin-result',{winner:winner.name,final:false});
      }
      r.spinning=false; emitState(roomId);
    },duration+300);
  });

  socket.on('reset',(_,cb=()=>{})=>{
    if(!socket.data.admin) return cb({ok:false,error:'Только преподаватель'});
    const r=getRoom(roomId); r.students.forEach(s=>s.active=true); r.level=0; r.history=[]; r.spinning=false; r.completed=false; r.allowedSpinnerUserId=null; r.allowedSpinnerName=null; emitState(roomId); cb({ok:true});
  });

  socket.on('new-month',(_,cb=()=>{})=>{
    if(!socket.data.admin) return cb({ok:false,error:'Только преподаватель'});
    const old=getRoom(roomId); const nr=freshRoom(); nr.students.forEach((s,i)=>s.name=old.students[i]?.name||s.name); rooms.set(roomId,nr); emitState(roomId); cb({ok:true});
  });

  socket.on('disconnect',()=>setTimeout(()=>{
    io.to(roomId).emit('presence',{count:io.sockets.adapter.rooms.get(roomId)?.size||0});
    emitOnlineUsers(roomId);
  },80));
});

app.use(express.static('.'));
app.get('/health',(req,res)=>res.json({ok:true,rooms:rooms.size}));
server.listen(PORT,'0.0.0.0',()=>console.log(`Listening on ${PORT}`));
