'use strict';
require('dotenv').config();
const required = ['FIREBASE_PROJECT_ID','FIREBASE_PRIVATE_KEY','FIREBASE_CLIENT_EMAIL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) { console.error('Missing env vars:', missing.join(', ')); process.exit(1); }

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

// Helmet
try { app.use(require('helmet')()); } catch { console.warn('helmet not installed'); }

// CORS
const ALLOWED = (process.env.FRONTEND_URL||'').split(',').map(u=>u.trim()).filter(Boolean);
app.use(cors({
  origin: process.env.NODE_ENV==='production'
    ? (o,cb) => (!o||ALLOWED.includes(o)) ? cb(null,true) : cb(new Error('CORS blocked'))
    : true,
  methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());

// Body limits
app.use(express.json({ limit:'200kb' }));
app.use(express.urlencoded({ extended:false, limit:'50kb' }));

// Logging
app.use((req,_,next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

// Rate limits
const lim = (max,w=15) => rateLimit({ windowMs:w*60000, max, message:{ error:'Too many requests' }, skip:()=>process.env.NODE_ENV==='test' });
app.use('/api/', lim(300));
app.use('/api/orders', lim(20,5));
app.use('/api/coupons/validate', lim(30,5));
app.use('/api/admin', lim(60,15));

// Routes
app.use('/api/products',  require('./routes/products'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/coupons',   require('./routes/coupons'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/delivery',  require('./routes/delivery'));
app.use('/api/reviews',   require('./routes/reviews'));
app.use('/api/upload',    require('./routes/upload'));

// Health
app.get('/health', (_,res) => res.json({ status:'ok', version:'3.0.0', ts: new Date().toISOString() }));
app.get('/ready', async (_,res) => {
  try { await require('./config/firebase').db.collection('_health').limit(1).get(); res.json({ status:'ready' }); }
  catch { res.status(503).json({ status:'not ready' }); }
});

// 404
app.use((req,res) => res.status(404).json({ error:'Route not found' }));

// Error handler
app.use((err,req,res,_next) => {
  console.error(err.message);
  res.status(500).json({ error: process.env.NODE_ENV==='production' ? 'Internal server error' : err.message });
});

const PORT = process.env.PORT||3000;
const server = app.listen(PORT, () => {
  console.log(`ShopWave API v3.0 on :${PORT}`);
  try { require('./services/pushWatcher').start(); } catch (e) { console.error('[push] could not start:', e.message); }
});
process.on('SIGTERM', () => server.close(()=>process.exit(0)));
process.on('SIGINT',  () => server.close(()=>process.exit(0)));
