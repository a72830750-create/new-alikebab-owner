const http = require('http');
const fs = require('fs');
const path = require('path');
// load .env
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath,'utf8').split(/\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch(e) {}
const url = require('url');

const ROOT = __dirname;
const crypto = require('crypto');
const PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const TOKEN_SECRET = process.env.TOKEN_SECRET || '';
function verifyPassword(pw) {
  const [salt, hash] = PASSWORD_HASH.split(':');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h,'hex'), Buffer.from(hash,'hex'));
}
function makeToken() { const t=crypto.randomBytes(32).toString('hex'); validTokens.set(t, Date.now()+1000*60*60); return t; }
if (!PASSWORD_HASH || !TOKEN_SECRET) { console.error('Missing env vars'); process.exit(1); }
const validTokens = new Map();
const loginAttempts = new Map();
function auth(req, res) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = validTokens.get(t); if (!exp || Date.now() > exp) { validTokens.delete(t); res.statusCode = 401; res.end('Unauthorized'); return false; }
  return true;
}
const ORDERS_FILE = path.join(ROOT, 'orders.json');
const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon' };

function readOrders(){ try{return JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8'));}catch(e){return [];} }
function writeOrders(o){ fs.writeFileSync(ORDERS_FILE, JSON.stringify(o,null,2)); }

const server = http.createServer((req,res)=>{
  const parsed = url.parse(req.url,true);
  const pathname = parsed.pathname;

  // Login
  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = loginAttempts.get(ip) || { count: 0, reset: now + 60000 };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
    rec.count++;
    loginAttempts.set(ip, rec);
    if (rec.count > 5) { res.statusCode = 429; res.end('Too many requests'); return; }
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try {
        const {username,password}=JSON.parse(body);
        if (username === 'alikebab' && verifyPassword(password)) {
          const token = makeToken();
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify({token}));
        } else {
          res.statusCode=401; res.end('Unauthorized');
        }
      } catch(e){ res.statusCode=400; res.end('Bad request'); }
    });
    return;
  }
  // Logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    validTokens.delete(t);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ok:true}));
    return;
  }
  if (pathname === '/api/orders' && req.method === 'GET') {
    if (!auth(req,res)) return;
    res.setHeader('Content-Type','application/json');
    const origin = req.headers.origin;
    const allowed = [
      'http://localhost:3000',
      ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
      process.env.CUSTOMER_FRONTEND_URL,
      process.env.OWNER_FRONTEND_URL
    ].map(x => x && x.trim()).filter(Boolean);
    if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    return res.end(JSON.stringify(readOrders()));
  }
  if (pathname === '/api/orders' && req.method === 'POST') {
    res.setHeader('Content-Type','application/json');
    const origin = req.headers.origin;
    const allowed = [
      'http://localhost:3000',
      ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
      process.env.CUSTOMER_FRONTEND_URL,
      process.env.OWNER_FRONTEND_URL
    ].map(x => x && x.trim()).filter(Boolean);
    if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    // customer order submission remains open
    let body=''; let tooBig=false; req.on('data',c=>{ if (tooBig) return; body+=c; if (body.length > 1e6) { tooBig=true; } }); req.on('end',()=>{ if (tooBig) { res.statusCode=413; res.end('Payload too large'); return; }
      let order;
      try { order = JSON.parse(body); } catch(e) { res.statusCode=400; res.end('Bad request'); return; }
      if (!order || typeof order !== 'object' || Array.isArray(order)) { res.statusCode=400; res.end('Bad request'); return; }
      if (typeof order.order_number !== 'string' || !order.order_number.trim() || order.order_number.length > 64) { res.statusCode=400; res.end('Bad request'); return; }
      if (!['delivery','pickup'].includes(order.order_type)) { res.statusCode=400; res.end('Bad request'); return; }
      if (typeof order.customer_name !== 'string' || !order.customer_name.trim() || order.customer_name.length > 120) { res.statusCode=400; res.end('Bad request'); return; }
      if (typeof order.customer_phone !== 'string' || !order.customer_phone.trim() || order.customer_phone.length > 40) { res.statusCode=400; res.end('Bad request'); return; }
      if (!Array.isArray(order.items) || order.items.length === 0 || order.items.length > 50) { res.statusCode=400; res.end('Bad request'); return; }
      for (const it of order.items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) { res.statusCode=400; res.end('Bad request'); return; }
        if (typeof it.name !== 'string' || !it.name.trim() || it.name.length > 120) { res.statusCode=400; res.end('Bad request'); return; }
        if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 99) { res.statusCode=400; res.end('Bad request'); return; }
        if (typeof it.price !== 'number' || !isFinite(it.price) || it.price < 0 || it.price > 10000) { res.statusCode=400; res.end('Bad request'); return; }
      }
      if (order.order_type === 'delivery' && (typeof order.subtotal !== 'number' || order.subtotal < 15)) { res.statusCode=400; res.end('Bad request'); return; }
      const orders = readOrders();
      order.id = Date.now();
      order.status = 'new';
      order.created_at = new Date().toISOString();
      orders.unshift(order);
      writeOrders(orders);
      res.end(JSON.stringify(order));
    });
    return;
  }
  const m = pathname.match(/^\/api\/orders\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    if (!auth(req,res)) return;
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      const {status} = JSON.parse(body);
      const allowedStatuses=['new','accepted','rejected','completed','preparing','ready','out_for_delivery'];
      if (!allowedStatuses.includes(status)) { res.statusCode=400; res.end('Invalid status'); return; }
      const orders = readOrders();
      if (!orders.find(x=>x.id==m[1])) { res.statusCode=404; res.end('Not found'); return; }
      const o = orders.find(x=>x.id==m[1]);
      if (o) o.status = status;
      writeOrders(orders);
      res.setHeader('Content-Type','application/json');
      const origin = req.headers.origin;
    const allowed = [
      'http://localhost:3000',
      ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
      process.env.CUSTOMER_FRONTEND_URL,
      process.env.OWNER_FRONTEND_URL
    ].map(x => x && x.trim()).filter(Boolean);
    if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
      res.end(JSON.stringify(o||{}));
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    const allowed = [
      'http://localhost:3000',
      ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
      process.env.CUSTOMER_FRONTEND_URL,
      process.env.OWNER_FRONTEND_URL
    ].map(x => x && x.trim()).filter(Boolean);
    if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    return res.end();
  }

  // Static
  let filePath;
  if (pathname.startsWith('/customer/')) filePath = path.join('/Users/jamesjackson/pizzaspc', pathname.replace('/customer/',''));
  else if (pathname.startsWith('/owner/')) filePath = path.join('/Users/jamesjackson/forno99-owner', pathname.replace('/owner/',''));
  else if (pathname === '/') filePath = path.join(__dirname, 'index.html');
  else filePath = path.join(ROOT, pathname);

  try {
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch (e) {}

  fs.readFile(filePath,(err,data)=>{
    if (err){ res.statusCode=404; return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', MIME[ext]||'application/octet-stream');
    res.end(data);
  });
});

server.listen(3000,()=>console.log('Server on http://localhost:3000'));
