'use strict';
const router = require('express').Router();
const { requireUser } = require('../middleware/auth');
const https = require('https');
const { URLSearchParams } = require('url');

router.post('/image', requireUser, async (req,res) => {
  const { base64 } = req.body;
  if (!base64||typeof base64!=='string'||base64.length>8e6) return res.status(400).json({ error:'Invalid image data' });
  if (!process.env.IMGBB_API_KEY) return res.status(503).json({ error:'Image upload not configured' });
  try {
    const params = new URLSearchParams({ image:base64 });
    const data = await new Promise((resolve,reject) => {
      const r = https.request(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,{ method:'POST' }, res => {
        let body=''; res.on('data',c=>body+=c); res.on('end',()=>resolve(JSON.parse(body)));
      });
      r.on('error',reject); r.write(params.toString()); r.end();
    });
    if (!data.data?.url) throw new Error('Upload failed');
    res.json({ url:data.data.url });
  } catch(e) { res.status(500).json({ error:'Image upload failed' }); }
});

module.exports = router;
