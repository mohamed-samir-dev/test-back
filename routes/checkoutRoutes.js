const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const router = express.Router();
const Checkout = require("../models/Checkout");
const Company = require("../models/Company");
const Product = require("../models/Product");
const { authMiddleware } = require("../middleware/auth");
const { priceItems, round } = require("../utils/order-pricing");

// ---------------------------------------------------------------------------
// In-process cache for total orders count
// ---------------------------------------------------------------------------
let _cachedOrderCount = null;
let _cachedOrderCountTime = 0;
const ORDER_COUNT_CACHE_TTL = 10_000; // 10 seconds

function invalidateOrderCountCache() {
  _cachedOrderCount = null;
  _cachedOrderCountTime = 0;
}

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------
const isProd = process.env.NODE_ENV === "production";


const VALID_STATUSES     = new Set(["pending", "confirmed", "cancelled"]);

// ---------------------------------------------------------------------------
// CSRF protection
// ---------------------------------------------------------------------------
function csrfProtection(req, res, next) {
  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ ok: false, error: "CSRF token invalid" });
  }
  next();
}

// GET /api/checkout/csrf-token
router.get("/csrf-token", (req, res) => {
  const token = crypto.randomBytes(32).toString("hex");
  res.cookie("csrf_token", token, { httpOnly: false, sameSite: "strict", secure: isProd });
  res.json({ csrfToken: token });
});

// ---------------------------------------------------------------------------
// Input validation for checkout — يتحقق من الشكل فقط، لا الأسعار
// الأسعار الحقيقية تُقرأ من قاعدة البيانات في POST handler
// ---------------------------------------------------------------------------
function validateCheckoutBody(req, res, next) {
  const body = req.body || {};
  const { orderId, items, customer, address, whatsapp, paymentMethod } = body;
  if (['cardNumber','expiry','cvv','cardHolder','card','cardDetails','otp'].some(k => Object.hasOwn(body,k))) return res.status(400).json({ok:false,error:'لا نقبل بيانات البطاقات البنكية'});
  if (paymentMethod && paymentMethod !== 'cash_on_delivery') return res.status(400).json({ok:false,error:'الدفع عند الاستلام فقط'});
  if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 50) return res.status(400).json({ok:false,error:'رقم الطلب غير صالح'});
  if (typeof customer !== 'string' || !customer.trim() || customer.length > 100 || typeof address !== 'string' || !address.trim() || address.length > 300 || typeof whatsapp !== 'string' || !/^\+?\d{7,15}$/.test(whatsapp.replace(/\s/g,''))) return res.status(400).json({ok:false,error:'بيانات التواصل والعنوان غير صالحة'});
  if (!Array.isArray(items) || !items.length || items.length > 50 || items.some(i=>!i || !mongoose.Types.ObjectId.isValid(i.productId) || !Number.isInteger(i.quantity ?? i.qty) || (i.quantity ?? i.qty) < 1 || (i.quantity ?? i.qty) > 99)) return res.status(400).json({ok:false,error:'المنتجات أو الكميات غير صالحة'});
  req.validatedBody = { orderId, customer: customer.trim(), address: address.trim(), whatsapp: whatsapp.replace(/\s/g,''), paymentMethod:'cash_on_delivery', items:items.map(i=>({productId:String(i.productId),quantity:i.quantity ?? i.qty,color:typeof i.color==='string'?i.color.slice(0,50):undefined,storage:typeof i.storage==='string'?i.storage.slice(0,50):undefined})) };
  next();
}

async function handleCreateOrder(req, res) {
  try {
    const {items:rawItems,...details} = req.validatedBody;
    const products = await Product.find({_id:{$in:rawItems.map(i=>i.productId)}}).select('name originalPrice salePrice variants inStock status purchasable').lean();
    let items;
    try { items = priceItems(rawItems,products); } catch (error) { return res.status(400).json({ok:false,error:error.message}); }
    const total = round(items.reduce((sum,i)=>sum+i.priceEGP*i.quantity,0));
    const checkout = await Checkout.create({...details,items,total,totalEGP:total,currency:'EGP',installmentType:'full',months:0,downPayment:0,monthlyPayment:0});
    invalidateOrderCountCache();
    return res.status(201).json({ok:true,orderId:checkout.orderId,_id:checkout._id,total,totalEGP:total,currency:'EGP'});
  } catch(error) {
    if(error.code===11000) return res.status(409).json({ok:false,error:'رقم الطلب موجود مسبقاً'});
    return res.status(500).json({ok:false,error:'تعذر حفظ الطلب'});
  }
}

router.post("/", validateCheckoutBody, handleCreateOrder);
router.post("/cod", validateCheckoutBody, handleCreateOrder);

// ---------------------------------------------------------------------------
// GET /api/checkout/count (admin)
// ---------------------------------------------------------------------------
router.get("/count", authMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    if (_cachedOrderCount !== null && (now - _cachedOrderCountTime) < ORDER_COUNT_CACHE_TTL) {
      return res.json({ count: _cachedOrderCount });
    }
    const count = await Checkout.estimatedDocumentCount();
    _cachedOrderCount = count;
    _cachedOrderCountTime = now;
    res.json({ count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, count: 0 });
  }
});

// ---------------------------------------------------------------------------
// Projection for LIST endpoint
// ---------------------------------------------------------------------------
const LIST_PROJECTION = {
  orderId: 1,
  customer: 1,
  whatsapp: 1,
  installmentType: 1,
  months: 1,
  total: 1,
  totalEGP: 1,
  
  
  downPayment: 1,
  status: 1,
  createdAt: 1,
  "items.name": 1,
  "items.quantity": 1,
};

function buildSearchFilter(search) {
  if (!search || typeof search !== "string") return {};
  const term = search.trim().slice(0, 100);
  if (!term) return {};
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");
  return {
    $or: [
      { orderId: term },
      { orderId: { $regex: `^${escaped}`, $options: "i" } },
      { customer: re },
      { whatsapp: { $regex: escaped } },
    ],
  };
}

// GET /api/checkout  (admin)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip   = (page - 1) * limit;
    const filter = buildSearchFilter(req.query.search);

    const [orders, total] = await Promise.all([
      Checkout.find(filter, LIST_PROJECTION)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Checkout.countDocuments(filter),
    ]);
    res.json({ orders, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/checkout/:id/public  — no sensitive card data
router.get("/:id/public", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id)
      .select("-cardNumber -expiry -cvv -cardHolder -nationalId")
      .lean();
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ ok: false, error: "not found" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/checkout/:id  (admin)
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id).select("-cardNumber -expiry -cvv -cardHolder").lean();
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ ok: false, error: "not found" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/checkout/:id/status  (admin)
router.put("/:id/status", authMiddleware, csrfProtection, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !VALID_STATUSES.has(status))
      return res.status(400).json({ ok: false, error: "حالة غير صالحة" });
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ ok: false, error: "not found" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/checkout/:id/financials  (admin)
// Admin يمكنه تعديل الأرقام المالية يدوياً (تعديلات استثنائية)
router.put("/:id/financials", authMiddleware, csrfProtection, async (req, res) => {
  try {
    const { total, totalEGP, downPayment, months, monthlyPayment } = req.body;
    if (typeof total !== "number" && typeof totalEGP !== "number")
      return res.status(400).json({ ok: false, error: "المجموع غير صالح" });

    const update = {
      downPayment:    Number(downPayment) || 0,
      months:         Number(months) || 0,
      monthlyPayment: Number(monthlyPayment) || 0,
    };
    const amount = totalEGP ?? total;
    if (!Number.isFinite(amount) || amount < 0 || [downPayment, months, monthlyPayment].some(v => v != null && (!Number.isFinite(v) || v < 0))) return res.status(400).json({ok:false,error:'القيم المالية غير صالحة'});
    update.total = round(amount);
    update.totalEGP = round(amount);
    update.currency = 'EGP';

    const order = await Checkout.findByIdAndUpdate(req.params.id, update, {new:true,runValidators:true});
    if (!order) return res.status(404).json({ok:false,error:'not found'});
    res.json(order);
  } catch(error) { res.status(400).json({ok:false,error:'تعذر تحديث الطلب'}); }
});
router.get('/:id/invoice', authMiddleware, async(req,res)=>{
  try {
    const [order,company] = await Promise.all([Checkout.findById(req.params.id).lean(),Company.findOne().lean()]);
    if(!order) return res.status(404).json({ok:false,error:'not found'});
    const ids=(order.items||[]).map(i=>i.productId).filter(id=>mongoose.Types.ObjectId.isValid(id));
    const products=await Product.find({_id:{$in:ids}}).select('image images').lean();
    for(const item of order.items||[]) {const p=products.find(p=>String(p._id)===item.productId);if(p)item.image=p.image||p.images?.[0]||'';}
    res.json({order,company:company||{}});
  }catch(error){res.status(400).json({ok:false,error:'تعذر تحميل الفاتورة'});}
});
router.delete('/:id', authMiddleware, csrfProtection, async(req,res)=>{
  try {const order=await Checkout.findByIdAndDelete(req.params.id);if(!order)return res.status(404).json({ok:false,error:'not found'});invalidateOrderCountCache();res.json({ok:true});}
  catch(error){res.status(400).json({ok:false,error:'تعذر حذف الطلب'});}
});
module.exports=router;
