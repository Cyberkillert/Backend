'use strict';
let z;
try { z = require('zod').z; } catch { z = null; }

// Simple fallback validator when zod not installed
function validate(schema) {
  return (req, res, next) => {
    if (!z) { next(); return; }
    const r = schema.safeParse(req.body);
    if (!r.success) return res.status(400).json({
      error: 'Validation failed',
      details: r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))
    });
    req.body = r.data; next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    if (!z) { next(); return; }
    const r = schema.safeParse(req.query);
    if (!r.success) return res.status(400).json({ error: 'Invalid query params' });
    req.query = r.data; next();
  };
}

// Build schemas only if zod available
const Schemas = {};
if (z) {
  const s = (max=500) => z.string().trim().max(max);
  const pos = z.number().positive().finite();
  const nn  = z.number().nonnegative().finite();
  const sid = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/,'Invalid ID');

  Schemas.productCreate = z.object({
    name: s(200), price: pos.max(1e6), description: s(5000), category: s(100),
    images: z.array(z.string().url().max(2000)).max(6).default([]),
    stock: z.number().int().nonnegative().max(1e5).default(0),
    variants: z.array(z.object({ size:s(50).default(''),color:s(50).default(''),stock:z.number().int().nonnegative().max(1e5) })).max(100).default([]),
    sizes: z.array(s(50)).max(20).default([]),
    colors: z.array(s(50)).max(20).default([]),
    deliveryFee: nn.max(1e4).default(0), freeDeliveryAbove: nn.max(1e6).default(0),
    deliveryMinutes: z.number().int().nonnegative().max(43200).default(0),
    originalPrice: pos.max(1e6).optional().nullable(),
    minQty: z.number().int().positive().max(1000).default(1),
    maxQty: z.number().int().positive().max(1e4).nullable().optional(),
    lowStockThreshold: z.number().int().nonnegative().max(1e4).default(5),
    returnPolicy: z.object({ enabled:z.boolean(), days:z.number().int().positive().max(365).optional(), freeReturn:z.boolean().optional() }).default({enabled:false}),
  });

  Schemas.productUpdate = Schemas.productCreate.partial();

  Schemas.orderCreate = z.object({
    items: z.array(z.object({ productId:sid, qty:z.number().int().positive().max(1000), size:s(50).default(''), color:s(50).default('') })).min(1).max(50),
    address: z.object({ name:s(100), phone:s(20), street:s(300), city:s(100), state:s(100).default(''), pincode:z.string().trim().regex(/^\d{5,10}$/) }),
    payment: s(40),
    couponCode: s(50).optional().nullable(),
  });

  Schemas.orderCancel  = z.object({ reason: s(500) });
  Schemas.orderStatus  = z.object({ status: z.enum(['accepted','packed','cancelled']), reason: s(500).optional() });
  Schemas.couponCreate = z.object({ code:z.string().trim().toUpperCase().min(3).max(30), discountType:z.enum(['percent','flat']), discountValue:pos.max(1e5), maxDiscount:nn.max(1e5).optional(), minOrder:nn.max(1e6).default(0), maxClaims:z.number().int().positive().max(1e6).optional(), maxPerUser:z.number().int().positive().max(100).default(1), expiresAt:z.string().datetime().optional().nullable(), description:s(200).optional() });
  Schemas.couponValidate = z.object({ code:s(50), items:z.array(z.object({ productId:sid, qty:z.number().int().positive().max(1000) })).min(1).max(50) });
  Schemas.reportCreate = z.object({ type:z.enum(['product','seller','delivery']), targetId:sid, targetName:s(200).default(''), reason:s(300), details:s(1000).default(''), reporterName:s(100).default('Guest') });
  Schemas.addressCreate = z.object({ label:s(50).default('Home'), street:s(300), city:s(100), state:s(100).default(''), pincode:z.string().trim().regex(/^\d{5,10}$/), phone:s(20).default('') });
  Schemas.reviewCreate = z.object({ rating:z.number().int().min(1).max(5), title:s(200).default(''), text:s(2000), pros:s(500).default(''), cons:s(500).default('') });
  Schemas.sellerStatus = z.object({ status:z.enum(['approved','rejected','suspended']), reason:s(500).optional() });
  Schemas.notification = z.object({ title:s(200), message:s(1000), target:z.enum(['all','user']).default('all'), targetUserId:sid.optional().nullable(), type:z.enum(['system','order','delivery','coupon','review']).default('system') });
}

module.exports = { validate, validateQuery, Schemas };
