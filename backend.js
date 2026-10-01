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

/* ───────── 起動 ───────── */
window.MachiBackend = {
  async init(){
    const params = new URLSearchParams(location.search);
    const user = localUser(params.get('mock') === '1');
    if (params.get('mock') === '1') return {db: mockDb(), user, why: '', label: 'テスト用（このブラウザの中だけ）'};
    const cfg = window.MACHI_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || /YOUR/.test(cfg.SUPABASE_URL)){
      return {db: null, user, why: 'オンラインの設定がまだです。config.js に Supabase の URL とキーを書いてください（くわしくは README）。'};
    }
    if (!window.supabase || !window.supabase.createClient){
      return {db: null, user, why: 'Supabase のプログラムを読みこめませんでした。インターネットにつながっているか確かめてください。'};
    }
    try {
      const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {auth: {persistSession: false}});
      const {error} = await sb.from('machi_rooms').select('code').limit(1);
      if (error) return {db: null, user, why: 'Supabase につながりませんでした。supabase.sql を実行したか、URLとキーが正しいか確かめてください。'};
      return {db: supabaseDb(sb), user, why: ''};
    } catch {
      return {db: null, user, why: 'Supabase につながりませんでした。'};
    }
  },
};
})();
