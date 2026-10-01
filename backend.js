/* デジタルまちづくり議会：データのやりとり（Supabase）
 * ゲーム本体は「db.doc(...) / db.collection(...)」という形で読み書きします。
 * このファイルが、それを Supabase のテーブルと関数に読みかえます。
 * ふだんは config.js だけ書きかえればOKです。
 */
(function(){
'use strict';
const ROOM = /^games\/(\d{4})$/, CHAT = /^games\/(\d{4})\/chat$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(t, p){ for (const k in p){ if (isObj(p[k]) && isObj(t[k])) deepMerge(t[k], p[k]); else t[k] = JSON.parse(JSON.stringify(p[k])); } return t; }
const fail = (code='unavailable') => { const e = new Error(code); e.code = code; return e; };
const snapDoc = state => ({exists: !!state, data: () => state || undefined});
const snapList = list => ({docs: list.map(m => ({id: String(m.id), data: () => m})), size: list.length, empty: !list.length});

/* ───────── 端末ごとのID（アカウントのかわり） ───────── */
function localUser(perTab){
  const store = perTab ? sessionStorage : localStorage;   // テスト用はタブごとに別人にする
  let id = null;
  try { id = store.getItem('machi.uid'); } catch {}
  if (!id){
    id = 'd_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'') : Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { store.setItem('machi.uid', id); } catch {}
  }
  return { id: async () => id, can: async () => true, me: async () => ({id}) };
}

/* ───────── Supabase ───────── */
function supabaseDb(sb){
  return {
    async createRoom(code, state){
      const {data, error} = await sb.rpc('machi_create_room', {p_code: code, p_state: state});
      if (error) throw fail(); return data === true;
    },
    doc(path){
      const m = path.match(ROOM); if (!m) throw new TypeError('bad path ' + path);
      const code = m[1];
      const get = async () => {
        const {data, error} = await sb.from('machi_rooms').select('state').eq('code', code).maybeSingle();
        if (error) throw fail(); return data ? data.state : null;
      };
      return {
        async get(){ return snapDoc(await get()); },
        async set(state){ const {error} = await sb.rpc('machi_set_room', {p_code: code, p_state: state}); if (error) throw fail(); },
        async update(patch){ const {error} = await sb.rpc('machi_merge_room', {p_code: code, p_patch: patch}); if (error) throw fail(); },
        onSnapshot(next, onErr){
          let last = '', dead = false;
          const deliver = st => { const s = JSON.stringify(st); if (s === last) return; last = s; next(snapDoc(st)); };
          const refresh = () => get().then(st => { if (!dead) deliver(st); }).catch(() => {});
          const ch = sb.channel('room-' + code + '-' + Math.random().toString(36).slice(2,7))
            .on('postgres_changes', {event: '*', schema: 'public', table: 'machi_rooms', filter: 'code=eq.' + code},
                p => { if (!dead) deliver(p.new && p.new.state ? p.new.state : null); })
            .subscribe(status => { if (status === 'SUBSCRIBED') refresh(); });
          refresh();
          const poll = setInterval(refresh, 6000);   // 念のための定期確認
          const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
          document.addEventListener('visibilitychange', onVis);
          return () => { dead = true; clearInterval(poll); document.removeEventListener('visibilitychange', onVis); sb.removeChannel(ch); };
        },
      };
    },
    collection(path){
      const cm = path.match(CHAT);
      if (cm){
        const room = cm[1]; let lim = 60;
        const q = {
          where(){ return q; }, orderBy(){ return q; }, limit(n){ lim = n; return q; },
          async add(m){
            const row = {room, seat: m.seat, text: String(m.text).slice(0,80), t: m.t || Date.now(), npc: !!m.npc};
            const {error} = await sb.from('machi_chat').insert(row); if (error) throw fail();
          },
          async get(){
            const {data, error} = await sb.from('machi_chat').select('*').eq('room', room).order('t', {ascending: false}).limit(lim);
            if (error) throw fail(); return snapList(data || []);
          },
          onSnapshot(next){
            let list = [], dead = false;
            const push = () => { list.sort((a,z) => z.t - a.t); list = list.slice(0, lim); next(snapList(list)); };
            const refresh = () => q.get().then(s => { if (dead) return; list = s.docs.map(d => d.data()); push(); }).catch(() => {});
            const ch = sb.channel('chat-' + room + '-' + Math.random().toString(36).slice(2,7))
              .on('postgres_changes', {event: 'INSERT', schema: 'public', table: 'machi_chat', filter: 'room=eq.' + room},
                  p => { if (dead || !p.new) return; if (!list.some(x => x.id === p.new.id)) { list.push(p.new); push(); } })
              .subscribe(status => { if (status === 'SUBSCRIBED') refresh(); });
            refresh();
            const poll = setInterval(refresh, 10000);
            return () => { dead = true; clearInterval(poll); sb.removeChannel(ch); };
          },
        };
        return q;
      }
      if (path === 'games'){
        let lim = 30;
        const q = {
          where(){ return q; }, orderBy(){ return q; }, limit(n){ lim = n; return q; },
          async get(){
            const since = new Date(Date.now() - 12*3600e3).toISOString();
            const {data, error} = await sb.from('machi_rooms').select('code,state').gt('updated_at', since).order('updated_at', {ascending: false}).limit(lim);
            if (error) throw fail(); return snapList((data || []).map(r => ({id: r.code, ...r.state})));
          },
        };
        return q;
      }
      throw new TypeError('bad collection ' + path);
    },
  };
}

/* ───────── テスト用（同じブラウザのタブどうしで同期する。URLに ?mock=1） ───────── */
function mockDb(){
  const KEY = 'machi.mock.v1';
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('machi-mock') : null;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {rooms:{}, chat:{}}; } catch { return {rooms:{}, chat:{}}; } };
  const save = d => { localStorage.setItem(KEY, JSON.stringify(d)); bc && bc.postMessage('x'); };
  const subs = new Set();
  const fire = () => subs.forEach(f => f());
  bc && (bc.onmessage = fire);
  window.addEventListener('storage', e => { if (e.key === KEY) fire(); });
  const watch = f => { subs.add(f); setTimeout(f, 5); return () => subs.delete(f); };
  return {
    async createRoom(code, state){ const d = load(); const r = d.rooms[code]; if (r && Date.now() - r.updated < 6*3600e3) return false; d.rooms[code] = {state, updated: Date.now()}; d.chat[code] = []; save(d); fire(); return true; },
    doc(path){
      const code = path.match(ROOM)[1];
      return {
        async get(){ return snapDoc(load().rooms[code]?.state); },
        async set(state){ const d = load(); d.rooms[code] = {state, updated: Date.now()}; save(d); fire(); },
        async update(patch){ const d = load(); const r = d.rooms[code]; if (!r) throw fail('invalid_argument'); deepMerge(r.state, patch); r.updated = Date.now(); save(d); fire(); },
        onSnapshot(next){ let last=''; return watch(() => { const st = load().rooms[code]?.state; const s = JSON.stringify(st); if (s !== last){ last = s; next(snapDoc(st)); } }); },
      };
    },
    collection(path){
      const cm = path.match(CHAT);
      const q = { where(){return q;}, orderBy(){return q;}, limit(){return q;} };
      if (cm){
        const room = cm[1];
        q.add = async m => { const d = load(); (d.chat[room] = d.chat[room] || []).push({...m, id: Date.now() + Math.random()}); save(d); fire(); };
        q.onSnapshot = next => { let n = -1; return watch(() => { const l = (load().chat[room] || []); if (l.length !== n){ n = l.length; next(snapList(l.slice().sort((a,z)=>z.t-a.t).slice(0,60))); } }); };
        return q;
      }
      q.get = async () => { const d = load(); return snapList(Object.entries(d.rooms).map(([c, r]) => ({id: c, ...r.state}))); };
      return q;
    },
  };
}


/* ───────── 公開MQTT中継サーバー（設定ゼロ） ─────────
 * 部屋の状態は「市長の端末」が係として持ち、変更をまとめて配る。
 *   machi-dd/v1/<code>/state    部屋の状態（retained・市長だけが送る）
 *   machi-dd/v1/<code>/patch    議員や観戦者からの変更依頼
 *   machi-dd/v1/<code>/chatin   発言
 *   machi-dd/v1/<code>/chatlog  発言の記録（retained・市長だけが送る）
 *   machi-dd/v1/index/<code>    部屋の一覧用の要約（retained）
 */
function mqttDb(client, uid, prefix){
  const P = prefix || 'machi-dd/v1/';
  const handlers = new Map();              // topic -> Set(fn)
  const rooms = {};                        // code -> {state, chat:[], hosting:bool}
  client.on('message', (topic, buf) => {
    let msg = null; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const hs = handlers.get(topic); if (hs) hs.forEach(f => f(msg, topic));
    for (const [t, set] of handlers){ if (t.endsWith('/+') && topic.startsWith(t.slice(0,-1))) set.forEach(f => f(msg, topic)); }
  });
  const sub = (topic, fn) => {
    if (!handlers.has(topic)){ handlers.set(topic, new Set()); client.subscribe(topic, {qos: 1}); }
    handlers.get(topic).add(fn);
    return () => { const set = handlers.get(topic); if (!set) return; set.delete(fn); if (!set.size){ handlers.delete(topic); client.unsubscribe(topic); } };
  };
  const pub = (topic, obj, retain=false) => new Promise((res, rej) => client.publish(topic, JSON.stringify(obj), {qos: 1, retain}, e => e ? rej(fail()) : res()));
  const R = code => (rooms[code] = rooms[code] || {state: null, chat: [], listeners: new Set(), chatListeners: new Set(), hosting: false, unsubs: []});
  const amHost = code => { const st = R(code).state; return !!(st && st.seats && st.seats.mayor === uid); };
  let indexTimer = {};
  const publishState = code => {
    const r = R(code); r.state.updatedAt = Date.now();
    pub(P + code + '/state', r.state, true).catch(()=>{});
    clearTimeout(indexTimer[code]);
    indexTimer[code] = setTimeout(() => { const st = r.state; pub(P + 'index/' + code, {code, created: st.created, updatedAt: st.updatedAt, phase: st.phase, year: st.year, names: st.names, seats: st.seats}, true).catch(()=>{}); }, 800);
    r.listeners.forEach(f => f(r.state));
  };
  const publishChat = code => { const r = R(code); pub(P + code + '/chatlog', {list: r.chat}, true).catch(()=>{}); r.chatListeners.forEach(f => f(r.chat)); };
  // 市長の端末になったら、変更依頼と発言を受けつけはじめる
  const ensureHosting = code => {
    const r = R(code); if (r.hosting || !amHost(code)) return;
    r.hosting = true;
    r.unsubs.push(sub(P + code + '/patch', m => { if (!m || !m.patch || !r.state) return; deepMerge(r.state, m.patch); publishState(code); }));
    r.unsubs.push(sub(P + code + '/chatin', m => { if (!m || !m.text) return; appendChat(code, m); }));
  };
  const appendChat = (code, m) => {
    const r = R(code);
    const row = {id: m.id || (Date.now() + '-' + Math.random().toString(36).slice(2,6)), seat: String(m.seat||''), text: String(m.text).slice(0,80), t: m.t || Date.now(), npc: !!m.npc};
    if (r.chat.some(x => x.id === row.id)) return;
    r.chat = r.chat.concat([row]).slice(-60); publishChat(code);
  };
  const ensureStateSub = code => {
    const r = R(code); if (r.stateSub) return;
    r.stateSub = sub(P + code + '/state', st => {
      if (!st || typeof st !== 'object') return;
      if (amHost(code) && r.hosting && r.state && (st.updatedAt||0) < (r.state.updatedAt||0)) return; // 自分の新しい状態を優先
      r.state = st; ensureHosting(code); r.listeners.forEach(f => f(r.state));
    });
    r.chatSub = sub(P + code + '/chatlog', m => { if (m && Array.isArray(m.list)){ if (!r.hosting || !r.chat.length) r.chat = m.list; r.chatListeners.forEach(f => f(r.chat)); } });
  };
  const waitState = (code, ms=1800) => new Promise(res => {
    const r = R(code); ensureStateSub(code);
    if (r.state) return res(r.state);
    const t0 = Date.now(); const iv = setInterval(() => { if (r.state || Date.now() - t0 > ms){ clearInterval(iv); res(r.state); } }, 100);
  });
  return {
    kind: 'mqtt',
    async createRoom(code, state){
      const cur = await waitState(code, 1500);
      if (cur && Date.now() - (cur.updatedAt || cur.created || 0) < 6*3600e3) return false;
      const r = R(code); r.state = JSON.parse(JSON.stringify(state)); r.chat = [];
      ensureHosting(code); publishState(code); publishChat(code);
      return true;
    },
    doc(path){
      const code = path.match(ROOM)[1];
      return {
        async get(){ return snapDoc(await waitState(code)); },
        async set(state){ const r = R(code); r.state = JSON.parse(JSON.stringify(state)); r.chat = r.chat; ensureHosting(code); publishState(code); },
        async update(patch){
          const r = R(code);
          if (!r.state) await waitState(code);
          if (amHost(code)){ ensureHosting(code); deepMerge(r.state, patch); publishState(code); return; }
          await pub(P + code + '/patch', {patch, from: uid, id: Date.now() + Math.random()});
          if (r.state){ deepMerge(r.state, patch); r.listeners.forEach(f => f(r.state)); }   // 先に画面へ反映
        },
        onSnapshot(next){
          const r = R(code); let last = '';
          const f = st => { const s = JSON.stringify(st); if (s === last) return; last = s; next(snapDoc(JSON.parse(s))); };
          r.listeners.add(f); ensureStateSub(code);
          if (r.state) setTimeout(() => f(r.state), 0);
          else waitState(code, 2500).then(st => { if (!st) next(snapDoc(null)); });
          return () => r.listeners.delete(f);
        },
      };
    },
    collection(path){
      const cm = path.match(CHAT);
      const q = { where(){return q;}, orderBy(){return q;}, limit(){return q;} };
      if (cm){
        const code = cm[1];
        q.add = async m => {
          const row = {...m, id: Date.now() + '-' + Math.random().toString(36).slice(2,6)};
          if (amHost(code)) appendChat(code, row); else await pub(P + code + '/chatin', row);
        };
        q.onSnapshot = next => {
          const r = R(code); ensureStateSub(code);
          const f = list => next(snapList(list.slice().sort((a,z) => z.t - a.t)));
          r.chatListeners.add(f); setTimeout(() => f(r.chat), 0);
          return () => r.chatListeners.delete(f);
        };
        return q;
      }
      q.get = () => new Promise(res => {
        const found = {};
        const off = sub(P + 'index/+', (m, topic) => { if (m && m.code) found[m.code] = m; });
        setTimeout(() => { off(); res(snapList(Object.values(found).filter(d => Date.now() - (d.updatedAt||0) < 12*3600e3).map(d => ({id: d.code, ...d})))); }, 1500);
      });
      return q;
    },
  };
}
function connectMqtt(urls){
  return new Promise(resolve => {
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) return resolve(null);
      const url = urls[i++];
      let done = false;
      const c = window.mqtt.connect(url, {clientId: 'machi_' + Math.random().toString(36).slice(2,10), clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 6000});
      const timer = setTimeout(() => { if (!done){ done = true; c.end(true); tryNext(); } }, 7000);
      c.once('connect', () => { if (done) return; done = true; clearTimeout(timer); resolve(c); });
    };
    tryNext();
  });
}

/* ───────── 起動 ───────── */
window.MachiBackend = {
  async init(){
    const params = new URLSearchParams(location.search);
    const user = localUser(params.get('mock') === '1');
    if (params.get('mock') === '1') return {db: mockDb(), user, why: '', label: 'テスト用（このブラウザの中だけ）'};
    const cfg = window.MACHI_CONFIG || {};
    const useSupabase = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/YOUR/.test(cfg.SUPABASE_URL);
    if (useSupabase){
      if (!window.supabase || !window.supabase.createClient) return {db: null, user, why: 'Supabase のプログラムを読みこめませんでした。'};
      try {
        const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {auth: {persistSession: false}});
        const {error} = await sb.from('machi_rooms').select('code').limit(1);
        if (error) return {db: null, user, why: 'Supabase につながりませんでした。supabase.sql を実行したか、URLとキーが正しいか確かめてください。'};
        return {db: supabaseDb(sb), user, why: ''};
      } catch { return {db: null, user, why: 'Supabase につながりませんでした。'}; }
    }
    // 設定がなければ、公開の中継サーバーを使う
    if (!window.mqtt) return {db: null, user, why: '通信のプログラムを読みこめませんでした。'};
    const urls = params.get('broker') ? [params.get('broker')] : cfg.MQTT_URLS || ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
    const client = await connectMqtt(urls);
    if (!client) return {db: null, user, why: '中継サーバーにつながりませんでした。インターネットにつながっているか確かめて、「もう一度つなぐ」を押してください。'};
    return {db: mqttDb(client, await user.id(), cfg.MQTT_PREFIX), user, why: '', hostKeepsState: true};
  },
};
})();
