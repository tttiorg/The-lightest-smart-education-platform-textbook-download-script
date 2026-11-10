#!/usr/bin/env node
/* 智慧教育平台电子教材 PDF 下载器 —— 零依赖，Node.js 18+ 即可运行
 * 用法：
 *   双击 start.bat                       启动网页界面
 *   node smartedu.js <网址1> <网址2> ...  命令行批量下载
 *   node smartedu.js                     交互粘贴模式
 *   可选参数：-o 输出目录  -c 并发数  -f 链接文件  --overwrite  --gui  --port N  --no-open
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const readline = require('readline');

const APPID = '8fb42234-efb6-4ef3-bdb6-82d7f2a06246';
const UC = 'https://uc-gateway.ykt.eduyun.cn';
const META_HOSTS = [
  'https://s-file-1.ykt.cbern.com.cn',
  'https://s-file-2.ykt.cbern.com.cn',
  'https://s-file-3.ykt.cbern.com.cn'
];
const META_PATH = '/zxx/ndrv2/resources/tch_material/details/';
const SALT = Buffer.from('£¬¡£fdjf,jkgfkl', 'latin1');
const DEFAULT_OUT = path.join(__dirname, 'downloads');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/* ---------- 工具函数 ---------- */
function makeDeviceId() {
  const n = 'Win10/Chrome120/' + crypto.randomUUID();
  const h = crypto.createHash('md5').update(Buffer.concat([Buffer.from(n, 'ascii'), SALT])).digest('hex');
  return Buffer.from(h).toString('base64')[2] + 'w' + n;
}
function desTransform(mode, input, key) {
  const k = Buffer.from(key, 'utf8');
  // des-ede-ecb 使用同一密钥两次，等价于单 DES（与前端 CryptoJS DES/ECB/PKCS7 一致）
  const fn = mode === 'enc' ? crypto.createCipheriv : crypto.createDecipheriv;
  const obj = fn('des-ede-ecb', Buffer.concat([k, k]), null);
  return Buffer.concat([obj.update(input), obj.final()]);
}
function desEnc(text, key) { return desTransform('enc', Buffer.from(text, 'utf8'), key).toString('base64'); }
function desDec(b64, key) { return desTransform('dec', Buffer.from(b64, 'base64'), key).toString('utf8'); }
function random8() {
  const s = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let r = '';
  for (let i = 0; i < 8; i++) r += s[Math.floor(Math.random() * 36)];
  return r;
}
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110) || 'untitled';
}
function extractIds(text) {
  const out = [];
  for (const m of String(text).match(UUID_RE) || []) {
    const id = m.toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'SDP-APP-ID': APPID, 'Origin': 'https://basic.smartedu.cn' },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160));
  return JSON.parse(t);
}
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------- 匿名游客令牌 + 签名（平台私有 CDN 鉴权） ---------- */
let tokenCache = null;
let tokenPromise = null;
function ensureToken(force) {
  if (!force && tokenCache && Date.now() < tokenCache.expireAt) return Promise.resolve(tokenCache);
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const dev = makeDeviceId();
    const sess = await postJson(UC + '/v1.1/sessions', { device_id: dev });
    const guest = await postJson(UC + '/v1.1/guest_tokens', {
      session_id: sess.session_id,
      device_id: desEnc(dev, sess.session_key)
    });
    const serverTime = new Date(guest.server_time.replace('+0800', '+08:00')).getTime();
    tokenCache = {
      access_token: guest.access_token,
      mac_key: desDec(guest.mac_key, sess.session_key),
      diff: (isFinite(serverTime) ? serverTime : Date.now()) - Date.now(),
      expireAt: Date.now() + 30 * 60 * 1000
    };
    return tokenCache;
  })().finally(() => { tokenPromise = null; });
  return tokenPromise;
}
function authHeader(url, tok) {
  const u = new URL(url);
  const rawPath = url.slice(url.indexOf(u.host) + u.host.length);
  let p;
  try { p = decodeURIComponent(rawPath); } catch (e) { p = rawPath; }
  const nonce = (Date.now() + tok.diff) + ':' + random8();
  const content = nonce + '\nGET\n' + p + '\n' + u.host + '\n';
  const mac = crypto.createHmac('sha256', tok.mac_key).update(content, 'utf8').digest('base64');
  return 'MAC id="' + tok.access_token + '",nonce="' + nonce + '",mac="' + mac + '"';
}

/* ---------- 解析 + 下载 ---------- */
async function resolvePdf(id) {
  let d = null, lastErr = null;
  for (const host of META_HOSTS) {
    try { d = await getJson(host + META_PATH + id + '.json'); break; }
    catch (e) { lastErr = e; }
  }
  if (!d) throw new Error('读取教材信息失败（' + (lastErr && lastErr.message) + '），请确认链接是教材详情页');
  const title = (d.global_title && d.global_title['zh-CN']) || d.title || id;
  const items = d.ti_items || [];
  const isPdf = t => String(t.ti_format).toLowerCase() === 'pdf';
  const item = items.find(t => t.ti_is_source_file === true && isPdf(t)) || items.find(isPdf);
  if (!item || !item.ti_storages || !item.ti_storages.length) {
    throw new Error('该资源没有可直接下载的 PDF（可能是纯图片教材）');
  }
  return { title: title, urls: item.ti_storages, size: item.ti_size || 0 };
}
async function downloadOne(id, opts) {
  const info = await resolvePdf(id);
  const file = path.join(opts.outDir, safeName(info.title) + '.pdf');
  if (!opts.overwrite && fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (!info.size || st.size === info.size) {
      return { id: id, title: info.title, file: file, bytes: st.size, status: 'skip', message: '已存在，跳过' };
    }
  }
  let tok = await ensureToken(false);
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const url of info.urls) {
      try {
        const r = await fetch(url, {
          headers: {
            'X-ND-AUTH': authHeader(url, tok),
            'Origin': 'https://basic.smartedu.cn',
            'Referer': 'https://basic.smartedu.cn/',
            'User-Agent': 'Mozilla/5.0'
          }
        });
        if (r.status === 401 || r.status === 403) {
          lastErr = new Error('鉴权失效（HTTP ' + r.status + '）');
          tok = await ensureToken(true);
          continue;
        }
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.slice(0, 4).toString() !== '%PDF') { lastErr = new Error('返回内容不是 PDF'); continue; }
        fs.writeFileSync(file, buf);
        const note = info.size && buf.length !== info.size ? '（大小与元数据略有差异）' : '';
        return { id: id, title: info.title, file: file, bytes: buf.length, status: 'ok', message: '完成 ' + note };
      } catch (e) { lastErr = e; }
    }
  }
  throw new Error('下载失败：' + (lastErr && lastErr.message || '未知错误'));
}
async function runJob(ids, opts, onEvent) {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const results = new Array(ids.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= ids.length) return;
      if (onEvent) onEvent(i, { id: ids[i], status: 'running', message: '处理中' });
      try { results[i] = await downloadOne(ids[i], opts); }
      catch (e) { results[i] = { id: ids[i], title: ids[i], status: 'error', message: e.message }; }
      results[i].index = i;
      if (onEvent) onEvent(i, results[i]);
    }
  }
  const n = Math.max(1, Math.min(opts.concurrency || 3, ids.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/* ---------- 网页界面 ---------- */
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>智慧教育 PDF 下载器</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#11161e;color:#e6edf5;font:14px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px 50px}h1{font-size:22px;margin:0 0 6px}p.sub{color:#8fa2b8;margin:0 0 22px}
.card{background:#1a2230;border:1px solid #2a3546;border-radius:12px;padding:18px;margin-bottom:16px}
label{display:block;color:#9fb2c8;margin:0 0 6px}textarea,input,select{width:100%;background:#111823;color:#e6edf5;border:1px solid #334258;border-radius:8px;padding:10px 12px;font:13px/1.6 Consolas,monospace;outline:none}
textarea{height:150px;resize:vertical}textarea:focus,input:focus{border-color:#4c9aff}
.row{display:flex;gap:14px;margin-top:14px}.row>div{flex:1}.row>div.narrow{flex:0 0 130px}
button{background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:10px 22px;font-size:14px;cursor:pointer}button:hover{background:#5596ff}button:disabled{background:#3d4a5c;cursor:not-allowed}
button.ghost{background:transparent;border:1px solid #3c4a5e;color:#b9c8da;margin-left:10px}
.hint{color:#7f92a8;font-size:12px;margin-top:10px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #26313f;vertical-align:top}th{color:#8fa2b8;font-weight:500}
td.name{max-width:430px;word-break:break-all}.tag{display:inline-block;padding:1px 9px;border-radius:20px;font-size:12px;white-space:nowrap}
.ok{background:#123a2c;color:#5be0a0}.skip{background:#3a3418;color:#e8c66a}.error{background:#3d1f24;color:#ff8b8b}.running{background:#1b3050;color:#8fc0ff}.wait{background:#252d3a;color:#8fa2b8}
#sum{color:#9fb2c8;margin-top:12px;min-height:20px}
</style></head><body><div class="wrap">
<h1>智慧教育 PDF 下载器</h1>
<p class="sub">粘贴国家中小学智慧教育平台的教材详情页网址，自动解析并下载 PDF，无需登录。</p>
<div class="card">
  <label>教材链接（支持多个，每行一个；也可直接粘贴包含 contentId 的整段文本）</label>
  <textarea id="links" placeholder="https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=..."></textarea>
  <div class="row"><div><label>输出目录</label><input id="out" value="__DEFAULT_OUT__"></div>
  <div class="narrow"><label>并发数</label><select id="conc"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></div></div>
  <div style="margin-top:16px"><button id="go">开始下载</button><button class="ghost" id="open">打开输出目录</button></div>
  <div class="hint">同名文件已存在且大小一致时自动跳过；下载后校验 PDF 文件头与文件大小。</div>
</div>
<div class="card"><table><thead><tr><th style="width:38px">#</th><th>教材</th><th style="width:90px">大小</th><th style="width:100px">状态</th></tr></thead><tbody id="tb"></tbody></table><div id="sum"></div></div>
</div><script>
var timer=null;
var STATUS={ok:'成功',skip:'已跳过',error:'失败',running:'下载中',wait:'等待'};
function sizeText(b){return b?(b/1048576).toFixed(2)+' MB':'--'}
function render(j){
  var tb=document.getElementById('tb');tb.innerHTML='';
  for(var i=0;i<j.items.length;i++){
    var it=j.items[i],tr=document.createElement('tr');
    var c1=document.createElement('td');c1.textContent=i+1;tr.appendChild(c1);
    var c2=document.createElement('td');c2.className='name';c2.textContent=it.title||it.id;
    if(it.message&&it.status!=='ok'){var sm=document.createElement('div');sm.style.color='#8698ad';sm.style.fontSize='12px';sm.textContent=it.message;c2.appendChild(sm)}
    tr.appendChild(c2);
    var c3=document.createElement('td');c3.textContent=sizeText(it.bytes);tr.appendChild(c3);
    var c4=document.createElement('td');var sp=document.createElement('span');sp.className='tag '+(it.status||'wait');sp.textContent=STATUS[it.status]||it.status;c4.appendChild(sp);tr.appendChild(c4);
    tb.appendChild(tr);
  }
  var done=j.items.filter(function(x){return x.status==='ok'}).length;
  var skipped=j.items.filter(function(x){return x.status==='skip'}).length;
  var failed=j.items.filter(function(x){return x.status==='error'}).length;
  document.getElementById('sum').textContent=j.items.length?'共 '+j.items.length+' 本 · 成功 '+done+' · 跳过 '+skipped+' · 失败 '+failed+(j.done?' · 全部结束':' · 进行中…'):'';
  if(j.done&&timer){clearInterval(timer);timer=null;document.getElementById('go').disabled=false}
}
function poll(id){
  if(timer)clearInterval(timer);
  timer=setInterval(async function(){
    try{var j=await (await fetch('/api/progress?id='+id)).json();render(j)}catch(e){}
  },500);
}
document.getElementById('go').onclick=async function(){
  var text=document.getElementById('links').value.trim();
  if(!text){alert('请先粘贴教材链接');return}
  this.disabled=true;
  try{
    var r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text,outDir:document.getElementById('out').value,concurrency:Number(document.getElementById('conc').value)})});
    var j=await r.json();
    if(!r.ok){alert(j.error||'启动失败');this.disabled=false;return}
    document.getElementById('sum').textContent='任务已启动…';poll(j.jobId);
  }catch(e){alert('请求失败：'+e.message);this.disabled=false}
};
document.getElementById('open').onclick=function(){
  fetch('/api/open-folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:document.getElementById('out').value})});
};
</script></body></html>`;

const jobs = new Map();
function startServer(port, noOpen) {
  const server = http.createServer(async (req, res) => {
    const send = (code, obj, type) => {
      res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/') {
      return send(200, PAGE.replace('__DEFAULT_OUT__', DEFAULT_OUT.replace(/\\/g, '/')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && u.pathname === '/api/progress') {
      const j = jobs.get(u.searchParams.get('id'));
      return j ? send(200, { items: j.items, done: j.done }) : send(404, { error: '任务不存在' });
    }
    if (req.method === 'POST' && (u.pathname === '/api/start' || u.pathname === '/api/open-folder')) {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
      await new Promise(resolve => req.on('end', resolve));
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { return send(400, { error: '请求格式错误' }); }
      if (u.pathname === '/api/open-folder') {
        const dir = String(body.dir || DEFAULT_OUT);
        try {
          if (fs.existsSync(dir)) {
            const cmd = process.platform === 'win32' ? 'explorer "' + dir + '"'
              : process.platform === 'darwin' ? 'open "' + dir + '"' : 'xdg-open "' + dir + '"';
            cp.exec(cmd);
          }
        } catch (e) { /* 忽略 */ }
        return send(200, { ok: true });
      }
      const ids = extractIds(body.text);
      if (!ids.length) return send(400, { error: '没有识别到教材链接（需要包含 contentId）' });
      const outDir = String(body.outDir || DEFAULT_OUT);
      try { fs.mkdirSync(outDir, { recursive: true }); }
      catch (e) { return send(400, { error: '输出目录无法创建：' + e.message }); }
      const jobId = crypto.randomBytes(6).toString('hex');
      const job = { done: false, items: ids.map(id => ({ id: id, title: id, status: 'wait', message: '' })) };
      jobs.set(jobId, job);
      send(200, { jobId: jobId });
      runJob(ids, { outDir: outDir, concurrency: Number(body.concurrency) || 3, overwrite: false },
        (i, r) => { job.items[i] = Object.assign({}, r); })
        .then(() => { job.done = true; })
        .catch(e => { job.done = true; job.items.forEach(it => { if (it.status === 'wait') it.message = e.message; }); });
      return;
    }
    send(404, { error: 'Not found' });
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') startServer(port + 1, noOpen);
    else console.error('服务启动失败：', e.message);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    console.log('网页界面已启动：' + url);
    console.log('输出目录：' + DEFAULT_OUT);
    console.log('关闭此窗口即可退出。');
    if (!noOpen && process.platform === 'win32') cp.exec('start "" "' + url + '"', { shell: 'cmd.exe' });
  });
}

/* ---------- 命令行 ---------- */
function parseArgs(argv) {
  const o = { gui: false, noOpen: false, port: 3211, outDir: DEFAULT_OUT, concurrency: 3, file: null, overwrite: false, urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gui') o.gui = true;
    else if (a === '--no-open') o.noOpen = true;
    else if (a === '--overwrite') o.overwrite = true;
    else if (a === '--port') o.port = Number(argv[++i]) || 3211;
    else if (a === '-o' || a === '--out') o.outDir = path.resolve(argv[++i] || DEFAULT_OUT);
    else if (a === '-c' || a === '--concurrency') o.concurrency = Number(argv[++i]) || 3;
    else if (a === '-f' || a === '--file') o.file = argv[++i];
    else if (a.startsWith('-')) console.warn('忽略未知参数：' + a);
    else o.urls.push(a);
  }
  return o;
}
function askLines() {
  return new Promise(resolve => {
    console.log('请粘贴教材链接（可多行），空行回车开始下载：');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const lines = [];
    rl.on('line', l => { if (l.trim()) lines.push(l); else { rl.close(); resolve(lines.join('\n')); } });
    rl.on('close', () => resolve(lines.join('\n')));
  });
}
(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (o.gui) return startServer(o.port, o.noOpen);
  let text = o.urls.join('\n');
  if (o.file) {
    if (!fs.existsSync(o.file)) { console.error('找不到文件：' + o.file); process.exit(1); }
    text += '\n' + fs.readFileSync(o.file, 'utf8');
  }
  if (!text.trim()) text = await askLines();
  const ids = extractIds(text);
  if (!ids.length) { console.error('没有识别到教材链接（URL 中需包含 contentId）。'); process.exit(1); }
  console.log('识别到 ' + ids.length + ' 本教材，输出目录：' + o.outDir);
  const results = await runJob(ids, { outDir: o.outDir, concurrency: o.concurrency, overwrite: o.overwrite }, (i, r) => {
    if (r.status === 'running') console.log('[' + (i + 1) + '/' + ids.length + '] 下载中…');
    else console.log('[' + (i + 1) + '/' + ids.length + '] ' + (r.status === 'ok' ? '完成' : r.status === 'skip' ? '跳过' : '失败')
      + '  ' + (r.title || r.id) + '  ' + (r.bytes ? (r.bytes / 1048576).toFixed(2) + ' MB' : '') + '  ' + (r.message || ''));
  });
  const ok = results.filter(r => r.status === 'ok').length;
  const skip = results.filter(r => r.status === 'skip').length;
  console.log('全部结束：成功 ' + ok + ' · 跳过 ' + skip + ' · 失败 ' + (results.length - ok - skip));
})();
