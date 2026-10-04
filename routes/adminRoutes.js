const express = require("express");
const { authMiddleware } = require("../middleware/auth");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Company = require("../models/Company");
const Banner = require("../models/Banner");
const MainCategory = require("../models/MainCategory");
const Product = require("../models/Product");
const SubCategorySettings = require("../models/SubCategorySettings");
const SubCategory = require("../models/SubCategory");
const Review = require("../models/Review");
const Checkout = require("../models/Checkout");
const CategoryBanner = require("../models/CategoryBanner");
const CardFieldSettings = require("../models/CardFieldSettings");
const { makeImageUpload, makeFileUpload, uploadToCloudinary, deleteFromCloudinary } = require("../config/cloudinary");
const { invalidateProductsCache, invalidateRateCache, getCurrentRate } = require("../controllers/productController");
const { addSARPrices, getExchangeRate } = require("../utils/currency");

// ---------------------------------------------------------------------------
// Module-level constants — computed once at startup, not per request.
// ---------------------------------------------------------------------------
const isProd = process.env.NODE_ENV === "production";

// Shared multer instances (singletons from cloudinary config).
const upload    = makeImageUpload();
const uploadDoc = makeFileUpload();

// Allowed-field Sets — O(1) lookup instead of Array.includes() O(n).
const ALLOWED_COMPANY_FIELDS    = new Set(["logo", "header", "footer", "stamp", "cancelStamp"]);
const ALLOWED_FOOTER_IMG_FIELDS = new Set(["qrImage", "img1", "img2"]);
const ALLOWED_FOOTER_FILE_FIELDS = new Set(["file1", "file2"]);
const ALLOWED_CARD_FIELDS       = new Set(["showExpiryDate", "showCvv"]);

// Default banner shape — created once, frozen so no accidental mutation.
const DEFAULT_BANNERS = Object.freeze(Array.from({ length: 5 }, () => ({ url: "", active: true })));

// ---------------------------------------------------------------------------
// Lightweight in-process TTL cache for public read-heavy endpoints.
//
// WHY: These endpoints are called on every page render by anonymous visitors.
// Without caching, each request hits MongoDB for data that changes at most a
// few times per day. A 60-second TTL means at most 1 DB round-trip per minute
// per key while all subsequent requests cost zero DB + zero Mongoose overhead.
//
// Memory cost: each entry holds a tiny JSON-serialisable object. Total footprint
// for all keys is well under 1 MB — safe within the 2 GB limit.
//
// Invalidation: every mutation endpoint that changes the cached data must call
// invalidateCache(key) to ensure stale data is not served.
// ---------------------------------------------------------------------------
const TTL_MS = 60_000; // 60 seconds
const MAX_CACHE_ENTRIES = 200; // Cap cache entries to prevent memory leaks from arbitrary queries
const _cache = new Map(); // key → { data, expiresAt }

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  // Refresh recency in Map (LRU behavior)
  _cache.delete(key);
  _cache.set(key, entry);
  return entry.data;
}

function cacheSet(key, data) {
  // Evict oldest entry if capacity is reached
  if (_cache.size >= MAX_CACHE_ENTRIES) {
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

function invalidateCache(...keys) {
  for (const k of keys) _cache.delete(k);
  if (keys.some((k) => k.includes("Categor") || k.includes("product") || k.includes("homeSettings"))) {
    try { invalidateProductsCache(); } catch { /* ignore */ }
  }
}

// Invalidates all category-banner cache entries that contain `category`.
// Called on every category-banner mutation so stale bulk-banner responses
// are not served.
function invalidateCategoryBannerCache(category) {
  for (const k of _cache.keys()) {
    if (k.includes(category)) _cache.delete(k);
  }
}

// ---------------------------------------------------------------------------
const router = express.Router();

// ============================================================
// AUTH
// ============================================================

// POST /api/admin/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "البريد والكلمة مطلوبان" });

    const admin = await Admin.findOne({ email }).select("+password");
    // Return the same generic error whether the email exists or not —
    // avoids user-enumeration.
    if (!admin) return res.status(401).json({ error: "بيانات غير صحيحة" });

    // Check lockout before doing the expensive bcrypt compare.
    if (admin.isLocked()) {
      return res.status(423).json({ error: "الحساب مقفل مؤقتاً، حاول لاحقاً" });
    }

    const match = await admin.comparePassword(password);
    if (!match) {
      // Increment failed attempts; lock after 10 consecutive failures for 15 min.
      admin.loginAttempts = (admin.loginAttempts || 0) + 1;
      if (admin.loginAttempts >= 10) {
        admin.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
        admin.loginAttempts = 0;
      }
      await admin.save();
      return res.status(401).json({ error: "بيانات غير صحيحة" });
    }

    // Successful login — reset counters.
    if (admin.loginAttempts !== 0 || admin.lockUntil) {
      admin.loginAttempts = 0;
      admin.lockUntil = undefined;
      await admin.save();
    }

    const token = jwt.sign(
      { id: admin._id, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res
      .cookie("admin_token", token, {
        httpOnly:  true,
        secure:    isProd,
        sameSite:  "lax",
        maxAge:    7 * 24 * 60 * 60 * 1000,
      })
      .json({ success: true, token });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/logout
router.post("/logout", (req, res) => {
  res.clearCookie("admin_token", {
    httpOnly: true,
    secure:   isProd,
    sameSite: "lax",
    path:     "/",
  }).json({ success: true });
});

// GET /api/admin/verify
router.get("/verify", (req, res) => {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ valid: false });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// ============================================================
// USERS (admin management — low traffic, no caching needed)
// ============================================================

// GET /api/admin/users
router.get("/users", authMiddleware, async (req, res) => {
  try {
    const admins = await Admin.find({}, "-password -loginAttempts -lockUntil").lean();
    res.json(admins);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/users
router.post("/users", authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !phone || !email || !password)
      return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    const exists = await Admin.findOne({ email });
    if (exists) return res.status(400).json({ error: "البريد مستخدم بالفعل" });
    const admin = await Admin.create({ name, phone, email, password });
    res.status(201).json({ _id: admin._id, name: admin.name, email: admin.email, phone: admin.phone });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/users/:id
router.put("/users/:id", authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: "الاسم والبريد مطلوبان" });
    const [existing, admin] = await Promise.all([
      Admin.findOne({ email, _id: { $ne: req.params.id } }),
      Admin.findById(req.params.id),
    ]);
    if (existing) return res.status(400).json({ error: "البريد مستخدم بالفعل" });
    if (!admin) return res.status(404).json({ error: "المستخدم غير موجود" });
    admin.name  = name;
    admin.email = email;
    if (phone) admin.phone = phone;
    if (password) admin.password = password;
    await admin.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/users/:id", authMiddleware, async (req, res) => {
  try {
    const admins = await Admin.countDocuments();
    if (admins <= 1) return res.status(400).json({ error: "لا يمكن حذف آخر مستخدم" });
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ============================================================
// COMPANY
// ============================================================

// POST /api/admin/company/upload/:field
router.post("/company/upload/:field", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { field } = req.params;
    if (!ALLOWED_COMPANY_FIELDS.has(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const result = await uploadToCloudinary(req.file.buffer, "company");
    const url    = result.secure_url;
    let company  = await Company.findOne();
    if (!company) company = await Company.create({});
    const oldUrl = company[field];
    company[field] = url;
    await company.save();
    invalidateCache("company");
    res.json({ url });

    // Non-blocking cleanup: run external Cloudinary deletion in background
    // to free the Node.js connection and respond in milliseconds
    if (oldUrl) {
      deleteFromCloudinary(oldUrl, "image").catch((e) =>
        console.error("Cloudinary cleanup error:", e.message)
      );
    }
  } catch (err) {
    console.error("company upload error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/image/:field
router.delete("/company/image/:field", authMiddleware, async (req, res) => {
  try {
    const { field } = req.params;
    if (!ALLOWED_COMPANY_FIELDS.has(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    const company = await Company.findOne();
    if (!company) return res.json({ success: true });
    const oldUrl = company[field];
    company[field] = "";
    await company.save();
    invalidateCache("company");
    res.json({ success: true });

    // Non-blocking cleanup
    if (oldUrl) {
      deleteFromCloudinary(oldUrl, "image").catch((e) =>
        console.error("Cloudinary cleanup error:", e.message)
      );
    }
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});


// GET /api/admin/company  (public — cached)
router.get("/company", async (req, res) => {
  try {
    // Serve from cache on warm instances — avoids a DB round-trip on every
    // page load that needs company branding (logo, footer links, etc.).
    const cached = cacheGet("company");
    if (cached) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }

    let company = await Company.findOne().lean();
    if (!company) {
      // First-ever boot: create the document. Use the Mongoose instance only
      // here so we get the saved _id back, then convert to plain object.
      const doc = await Company.create({});
      company = doc.toObject();
    }

    // Ensure footerItems is an array.
    if (!Array.isArray(company.footerItems)) {
      company.footerItems = [];
    }

    cacheSet("company", company);
    res.set("Cache-Control", "public, max-age=60");
    res.json(company);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/company
// Whitelist of fields the admin panel is allowed to update directly.
// Protects against mass-assignment: clients cannot overwrite _id, __v,
// image fields (managed via dedicated upload endpoints), or internal fields.
const ALLOWED_COMPANY_PUT_FIELDS = new Set([
  // Text / contact fields
  "nameAr", "nameEn", "addressAr", "addressEn",
  "phone", "whatsapp", "website", "email",
  "currencyAr", "currencyEn", "taxNumber",
  "shippingCompany", "paymentMethod", "details",
  // Footer link / file fields — managed by /admin/files page via PUT
  // (images are managed by dedicated upload endpoints, but clearing them
  //  via PUT with "" is a valid operation the admin panel uses)
  "qrImage", "qrLink",
  "img1", "link1", "link1Type", "file1",
  "img2", "link2", "link2Type", "file2",
  // Dynamic footer items array (sent as a whole array on save)
  "footerItems",
  // سعر الصرف
  "egpPerSar",
]);

router.put("/company", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    const body = { ...req.body, currencyAr: "جنيه مصري", currencyEn: "EGP", paymentMethod: "الدفع عند الاستلام" };
    // Normalise legacy field names sent by older admin panel versions.
    if (body.linkType1 !== undefined) { body.link1Type = body.linkType1; delete body.linkType1; }
    if (body.linkType2 !== undefined) { body.link2Type = body.linkType2; delete body.linkType2; }

    const cleanupPromises = [];

    // Clean up single images if cleared or replaced
    for (const imgField of ["qrImage", "img1", "img2"]) {
      if (body[imgField] !== undefined && body[imgField] !== company[imgField] && company[imgField]) {
        cleanupPromises.push(deleteFromCloudinary(company[imgField], "image"));
      }
    }

    // Clean up single raw files if cleared or replaced
    for (const fileField of ["file1", "file2"]) {
      if (body[fileField] !== undefined && body[fileField] !== company[fileField] && company[fileField]) {
        cleanupPromises.push(deleteFromCloudinary(company[fileField], "raw"));
      }
    }

    // Clean up footerItems images/files if removed or replaced
    if (Array.isArray(body.footerItems) && Array.isArray(company.footerItems)) {
      const newImages = new Set(body.footerItems.map((it) => it && it.image).filter(Boolean));
      const newFiles = new Set(body.footerItems.map((it) => it && it.file).filter(Boolean));

      for (const oldItem of company.footerItems) {
        if (oldItem && oldItem.image && !newImages.has(oldItem.image)) {
          cleanupPromises.push(deleteFromCloudinary(oldItem.image, "image"));
        }
        if (oldItem && oldItem.file && !newFiles.has(oldItem.file)) {
          cleanupPromises.push(deleteFromCloudinary(oldItem.file, "raw"));
        }
      }
    }

    // Run cleanup asynchronously in background — saves multiple blocking HTTP roundtrips to Cloudinary
    if (cleanupPromises.length > 0) {
      Promise.allSettled(cleanupPromises).catch((e) =>
        console.error("PUT company Cloudinary cleanup error:", e)
      );
    }

    // Apply only whitelisted fields — drop anything not in the allowed set.
    for (const key of Object.keys(body)) {
      if (ALLOWED_COMPANY_PUT_FIELDS.has(key)) {
        if (key === "egpPerSar") {
          const num = Number(body[key]);
          if (num > 0) company[key] = Math.round(num * 100) / 100;
        } else {
          company[key] = body[key];
        }
      }
    }
    await company.save();
    invalidateCache("company");
    invalidateRateCache();
    invalidateProductsCache();
    res.json({ success: true, message: "تم الحفظ بنجاح", egpPerSar: company.egpPerSar });

  } catch (err) {
    console.error("company PUT error:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ============================================================
// EXCHANGE RATE
// ============================================================

// GET /api/admin/exchange-rate
router.get("/exchange-rate", authMiddleware, async (req, res) => {
  try {
    const company = await Company.findOne().select("egpPerSar").lean();
    const rate = getExchangeRate(company?.egpPerSar);
    res.json({
      exchangeRate: rate,
      egpPerSar: rate,
      isCustom: company?.egpPerSar != null,
    });
  } catch (err) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/exchange-rate
router.put("/exchange-rate", authMiddleware, async (req, res) => {
  try {
    const rate = Number(req.body.rate ?? req.body.egpPerSar);
    if (!rate || rate <= 0 || !isFinite(rate)) {
      return res.status(400).json({ error: "سعر الصرف يجب أن يكون رقماً أكبر من صفر" });
    }
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    company.egpPerSar = Math.round(rate * 100) / 100;
    await company.save();
    invalidateCache("company");
    invalidateRateCache();
    invalidateProductsCache();
    res.json({ success: true, exchangeRate: company.egpPerSar, egpPerSar: company.egpPerSar });
  } catch (err) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ============================================================
// BANNERS
// ============================================================

// GET /api/admin/banners  (public — cached)
router.get("/banners", async (req, res) => {
  try {
    const cached = cacheGet("banners");
    if (cached) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }
    let doc = await Banner.findOne().lean();
    if (!doc) {
      const created = await Banner.create({ banners: DEFAULT_BANNERS });
      doc = created.toObject();
    }
    const data = Array.isArray(doc.banners) ? doc.banners : [];
    cacheSet("banners", data);
    res.set("Cache-Control", "public, max-age=60");
    res.json(data);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/banners/upload/:index
router.post("/banners/upload/:index", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) doc = await Banner.create({ banners: DEFAULT_BANNERS });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const old = doc.banners[index]?.url;
    const result = await uploadToCloudinary(req.file.buffer, "banners");
    const url = result.secure_url;
    doc.banners.set(index, { url, active: doc.banners[index].active });
    await doc.save();
    invalidateCache("banners");
    if (old && old !== url) {
      deleteFromCloudinary(old).catch((e) => console.error("Cloudinary delete old banner error:", e.message));
    }
    res.json({ url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/banners/toggle/:index
router.patch("/banners/toggle/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) return res.status(404).json({ error: "لا يوجد" });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const newActive = !doc.banners[index].active;
    doc.banners.set(index, { url: doc.banners[index].url, active: newActive });
    await doc.save();
    invalidateCache("banners");
    res.json({ active: newActive });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/banners/add
router.post("/banners/add", authMiddleware, async (req, res) => {
  try {
    let doc = await Banner.findOne();
    if (!doc) doc = await Banner.create({ banners: DEFAULT_BANNERS });
    if (doc.banners.length >= 10) return res.status(400).json({ error: "الحد الأقصى 10 بانرات" });
    doc.banners.push({ url: "", active: true });
    await doc.save();
    invalidateCache("banners");
    res.json({ index: doc.banners.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/banners/reorder
router.patch("/banners/reorder", authMiddleware, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: "ترتيب غير صحيح" });
    let doc = await Banner.findOne();
    if (!doc) return res.status(404).json({ error: "لا يوجد" });
    if (order.length !== doc.banners.length) return res.status(400).json({ error: "عدد غير متطابق" });
    doc.banners = order.map((i) => doc.banners[i]);
    await doc.save();
    invalidateCache("banners");
    res.json(doc.banners);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/banners/:index/image  (clear image only)
router.delete("/banners/:index/image", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const old = doc.banners[index]?.url;
    doc.banners.set(index, { url: "", active: false });
    await doc.save();
    invalidateCache("banners");
    if (old) {
      deleteFromCloudinary(old).catch((e) => console.error("Cloudinary delete banner image error:", e.message));
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/banners/:index  (remove entire banner slot)
router.delete("/banners/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let doc = await Banner.findOne();
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const old = doc.banners[index]?.url;
    doc.banners.splice(index, 1);
    await doc.save();
    invalidateCache("banners");
    if (old) {
      deleteFromCloudinary(old).catch((e) => console.error("Cloudinary delete banner slot error:", e.message));
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ============================================================
// CATEGORIES
// ============================================================

// GET /api/admin/main-categories  (admin — distinct from products with count)
router.get("/main-categories", authMiddleware, async (req, res) => {
  try {
    const result = await Product.aggregate([
      { $match: { subCategory: { $ne: null, $exists: true } } },
      { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(result.map((r) => ({ name: r._id, count: r.count })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/categories  (admin)
// Cached for 60 s — category list changes only when a product is created or
// edited with a new category value. invalidateCache("adminCategories") is
// called from POST/PUT /products handlers on every mutation so the cache is
// always fresh after a change.
router.get("/categories", authMiddleware, async (req, res) => {
  try {
    const cached = cacheGet("adminCategories");
    if (cached) return res.json(cached);
    const cats = await Product.distinct("category");
    const sorted = cats.filter(Boolean).sort();
    cacheSet("adminCategories", sorted);
    res.json(sorted);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/main-categories
router.post("/main-categories", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    const trimmed = name.trim();
    // Check both products and main category records
    const [inProducts, inMC] = await Promise.all([
      Product.findOne({ subCategory: trimmed }).lean(),
      MainCategory.findOne({ name: trimmed }).lean(),
    ]);
    if (inProducts || inMC) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    const cat = await MainCategory.create({ name: trimmed });
    invalidateCache("adminMainCategoriesExtra", "adminCategories");
    res.status(201).json({ name: cat.name, count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/main-categories/extra  (admin — cached to eliminate repeated aggregations)
router.get("/main-categories/extra", authMiddleware, async (req, res) => {
  try {
    const cached = cacheGet("adminMainCategoriesExtra");
    if (cached) return res.json(cached);

    const [productAgg, manualCats] = await Promise.all([
      Product.aggregate([
        { $match: { subCategory: { $exists: true, $nin: [null, ""] } } },
        { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      ]),
      MainCategory.find().lean(),
    ]);
    const productMap = new Map(productAgg.map((r) => [r._id, r.count]));
    const allNames   = new Set([...productMap.keys(), ...manualCats.map((c) => c.name)]);
    const data = [...allNames].sort().map((name) => ({ name, count: productMap.get(name) || 0 }));
    cacheSet("adminMainCategoriesExtra", data);
    res.json(data);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/main-categories/rename
router.put("/main-categories/rename", authMiddleware, async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    const trimNew = newName.trim();
    const trimOld = oldName.trim();
    if (trimNew !== trimOld) {
      const [existsProduct, existsMC] = await Promise.all([
        Product.findOne({ subCategory: trimNew }).lean(),
        MainCategory.findOne({ name: trimNew }).lean(),
      ]);
      if (existsProduct || existsMC) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    }
    await Promise.all([
      Product.updateMany({ subCategory: trimOld }, { $set: { subCategory: trimNew } }),
      MainCategory.updateOne({ name: trimOld }, { $set: { name: trimNew } }),
    ]);
    invalidateCache("adminMainCategoriesExtra", "adminCategories", "subCategoriesPublic", "homeSettings");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/main-categories/remove
router.delete("/main-categories/remove", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    const trimName = name.trim();
    await Promise.all([
      Product.updateMany({ subCategory: trimName }, { $unset: { subCategory: "" } }),
      MainCategory.deleteOne({ name: trimName }),
    ]);
    invalidateCache("adminMainCategoriesExtra", "adminCategories", "subCategoriesPublic", "homeSettings");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories
router.post("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف الفرعي مطلوب" });
    const trimmed = name.trim();
    const [inProducts, existsSC] = await Promise.all([
      Product.findOne({ $or: [{ category: trimmed }, { subCategory: trimmed }] }).lean(),
      SubCategory.findOne({ name: trimmed }).lean(),
    ]);
    if (inProducts || existsSC) return res.status(400).json({ error: "التصنيف الفرعي موجود بالفعل" });
    const sc = await SubCategory.create({ name: trimmed });
    invalidateCache("adminSubCategories", "adminSubCategorySettings", "subCategoriesPublic", "homeSettings");
    res.status(201).json({ name: sc.name, category: "", count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/all-data (admin consolidated — reduces 4 requests to 1)
router.get("/sub-categories/all-data", authMiddleware, async (req, res) => {
  try {
    const cachedCategories = cacheGet("adminSubCategories");
    const cachedSettings = cacheGet("adminSubCategorySettings");
    const cachedMax = cacheGet("subCategoriesMax");

    let formatted = cachedCategories;
    let settings = cachedSettings;
    let max = cachedMax ? cachedMax.max : null;

    const promises = [];

    if (!formatted) {
      promises.push(
        Promise.all([
          Product.aggregate([
            { $match: { category: { $ne: null, $exists: true, $nin: [""] } } },
            {
              $group: {
                _id: "$category",
                count: { $sum: 1 },
                mainCategory: { $first: "$subCategory" },
              },
            },
            { $sort: { _id: 1 } },
          ]),
          SubCategory.find().lean(),
        ]).then(([result, extraDocs]) => {
          const productMap = new Map(result.map((r) => [r._id, { count: r.count, mainCategory: r.mainCategory || "" }]));
          const allNames = new Set([...productMap.keys(), ...extraDocs.map((s) => s.name)]);
          formatted = Array.from(allNames).sort().map((name) => {
            const p = productMap.get(name);
            return {
              name,
              category: p?.mainCategory || "",
              count: p?.count || 0,
            };
          });
          cacheSet("adminSubCategories", formatted);
        })
      );
    }

    if (!settings) {
      promises.push(
        SubCategorySettings.find(
          { category: { $ne: "__config__" } },
          { category: 1, subCategory: 1, showInHome: 1, order: 1, image: 1, _id: 0 }
        ).lean().then((docs) => {
          settings = docs;
          cacheSet("adminSubCategorySettings", settings);
        })
      );
    }

    if (max === null) {
      promises.push(
        SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" }).lean().then((doc) => {
          max = doc ? doc.order : 4;
          cacheSet("subCategoriesMax", { max });
        })
      );
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }

    res.json({
      items: formatted || [],
      settings: settings || [],
      max: max ?? 4,
    });
  } catch (err) {
    console.error("[sub-categories all-data error]", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/all  (admin)
router.get("/sub-categories/all", authMiddleware, async (req, res) => {
  try {
    const cats = await MainCategory.find().sort({ name: 1 }).lean();
    res.json(cats.map((c) => ({ _id: c._id, name: c.name })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/extra  (admin — parallel queries)
router.get("/sub-categories/extra", authMiddleware, async (req, res) => {
  try {
    const [productCats, extraDocs] = await Promise.all([
      Product.distinct("category"),
      SubCategory.find().lean(),
    ]);
    const productSet = new Set(productCats.filter(Boolean));
    const extra = extraDocs.filter((s) => !productSet.has(s.name));
    res.json(extra.map((s) => ({ name: s.name, category: "", count: 0, _id: s._id })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories  (admin — cached to avoid repeated aggregations)
router.get("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const cached = cacheGet("adminSubCategories");
    if (cached) return res.json(cached);

    const [result, extraDocs] = await Promise.all([
      Product.aggregate([
        { $match: { category: { $ne: null, $exists: true, $nin: [""] } } },
        {
          $group: {
            _id: "$category",
            count: { $sum: 1 },
            mainCategory: { $first: "$subCategory" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      SubCategory.find().lean(),
    ]);

    const productMap = new Map(result.map((r) => [r._id, { count: r.count, mainCategory: r.mainCategory || "" }]));
    const allNames = new Set([...productMap.keys(), ...extraDocs.map((s) => s.name)]);
    const formatted = Array.from(allNames).sort().map((name) => {
      const p = productMap.get(name);
      return {
        name,
        category: p?.mainCategory || "",
        count: p?.count || 0,
      };
    });

    cacheSet("adminSubCategories", formatted);
    res.json(formatted);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/sub-categories/rename
router.put("/sub-categories/rename", authMiddleware, async (req, res) => {
  try {
    const { oldName, oldCategory, newName, newCategory } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    const trimOldName = oldName.trim();
    const trimNewName = newName.trim();
    const trimNewCat = newCategory ? newCategory.trim() : undefined;

    const updateProductDoc = { category: trimNewName };
    if (trimNewCat !== undefined) {
      updateProductDoc.subCategory = trimNewCat;
    }

    await Promise.all([
      // Update products where category matches oldName
      Product.updateMany({ category: trimOldName }, { $set: updateProductDoc }),
      // Update SubCategory document
      SubCategory.updateOne({ name: trimOldName }, { $set: { name: trimNewName } }),
      // Update SubCategorySettings so showInHome, order, and image are preserved
      SubCategorySettings.updateMany(
        { category: trimOldName },
        { $set: { category: trimNewName, subCategory: trimNewName } }
      ),
      SubCategorySettings.updateMany(
        { subCategory: trimOldName },
        { $set: { subCategory: trimNewName } }
      ),
    ]);
    invalidateCache("adminSubCategories", "adminSubCategorySettings", "subCategoriesPublic", "homeSettings", "adminCategories");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/sub-categories/remove
router.delete("/sub-categories/remove", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "الاسم مطلوب" });
    const trimName = name.trim();

    // Check if there is an image to delete from Cloudinary
    const settingWithImg = await SubCategorySettings.findOne({
      $or: [{ category: trimName }, { subCategory: trimName }],
      image: { $exists: true, $ne: "" },
    }).lean();

    if (settingWithImg?.image) {
      await deleteFromCloudinary(settingWithImg.image).catch(() => {});
    }

    await Promise.all([
      // Unset category from all products that carry it
      Product.updateMany({ category: trimName }, { $unset: { category: "" } }),
      // Delete settings rows
      SubCategorySettings.deleteMany({
        $or: [{ category: trimName }, { subCategory: trimName }],
      }),
      SubCategory.deleteOne({ name: trimName }),
    ]);
    invalidateCache("adminSubCategories", "adminSubCategorySettings", "subCategoriesPublic", "homeSettings", "adminCategories");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/settings  (admin — cached)
router.get("/sub-categories/settings", authMiddleware, async (req, res) => {
  try {
    const cached = cacheGet("adminSubCategorySettings");
    if (cached) return res.json(cached);

    const settings = await SubCategorySettings.find(
      { category: { $ne: "__config__" } },
      { category: 1, subCategory: 1, showInHome: 1, order: 1, image: 1, _id: 0 }
    ).lean();
    cacheSet("adminSubCategorySettings", settings);
    res.json(settings);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/toggle
router.patch("/sub-categories/settings/toggle", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });

    // Read current value first, then atomically flip it.
    const existing = await SubCategorySettings.findOne({ category, subCategory }).lean();
    const newValue = existing ? !existing.showInHome : true;
    const doc = await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { showInHome: newValue } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    invalidateCache("homeSettings", "adminSubCategorySettings");
    res.json({ showInHome: doc.showInHome });
  } catch (err) {
    console.error("[settings/toggle error]", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/order
router.patch("/sub-categories/settings/order", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory, order } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });
    await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { order: Number(order) || 0 } },
      { upsert: true }
    );
    invalidateCache("homeSettings", "adminSubCategorySettings");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories/image/:category
router.post("/sub-categories/image/:category", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { category } = req.params;
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const existing = await SubCategorySettings.findOne({ category, subCategory: { $ne: "__max__" } }).lean();
    if (existing?.image) await deleteFromCloudinary(existing.image);
    const result = await uploadToCloudinary(req.file.buffer, "sub-categories");
    const updateResult = await SubCategorySettings.updateMany(
      { category, subCategory: { $ne: "__max__" } },
      { $set: { image: result.secure_url } }
    );
    if (updateResult.modifiedCount === 0) {
      await SubCategorySettings.create({ category, subCategory: category, image: result.secure_url });
    }
    invalidateCache("subCategoriesPublic", "homeSettings", "adminSubCategorySettings");
    res.json({ url: result.secure_url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/sub-categories/image/:category
router.delete("/sub-categories/image/:category", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const existing = await SubCategorySettings.findOne({ category, subCategory: { $ne: "__max__" } }).lean();
    if (existing?.image) {
      await deleteFromCloudinary(existing.image).catch(() => {});
    }
    await SubCategorySettings.updateMany(
      { category, subCategory: { $ne: "__max__" } },
      { $set: { image: "" } }
    );
    invalidateCache("subCategoriesPublic", "homeSettings", "adminSubCategorySettings");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/public  (public — cached)
// This is the homepage category grid endpoint. Aggregation is expensive;
// caching for 60 s means at most 1 aggregate + 1 DB read per minute
// instead of one per page view.
router.get("/sub-categories/public", async (req, res) => {
  try {
    const cached = cacheGet("subCategoriesPublic");
    if (cached) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }

    const [result, customImages] = await Promise.all([
      Product.aggregate([
        { $match: { category: { $ne: null, $exists: true }, image: { $ne: "", $exists: true } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$category", count: { $sum: 1 }, image: { $first: "$image" } } },
      ]),
      SubCategorySettings.find({ image: { $ne: "" }, subCategory: { $ne: "__max__" } })
        .select("category image")
        .lean(),
    ]);

    // Build image override map in a single pass.
    const imageMap = {};
    for (const s of customImages) if (s.image) imageMap[s.category] = s.image;

    const data = result.map((r) => ({
      name:  r._id,
      count: r.count,
      image: imageMap[r._id] || r.image,
    }));
    cacheSet("subCategoriesPublic", data);
    res.set("Cache-Control", "public, max-age=60");
    res.json(data);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/home-settings  (public — cached)
router.get("/sub-categories/home-settings", async (req, res) => {
  try {
    const cached = cacheGet("homeSettings");
    if (cached) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }
    const settings = await SubCategorySettings.find({ category: { $ne: "__config__" } })
      .sort({ order: 1 })
      .lean();
    cacheSet("homeSettings", settings);
    res.set("Cache-Control", "public, max-age=60");
    res.json(settings);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/max  (public — cached)
router.get("/sub-categories/max", async (req, res) => {
  try {
    const cached = cacheGet("subCategoriesMax");
    if (cached !== null) {
      res.set("Cache-Control", "public, max-age=300");
      return res.json(cached);
    }
    const doc = await SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" }).lean();
    const data = { max: doc ? doc.order : 4 };
    cacheSet("subCategoriesMax", data);
    res.set("Cache-Control", "public, max-age=300");
    res.json(data);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/max
router.patch("/sub-categories/max", authMiddleware, async (req, res) => {
  try {
    const val = parseInt(req.body.max);
    if (!val || val < 1) return res.status(400).json({ error: "قيمة غير صحيحة" });
    await SubCategorySettings.findOneAndUpdate(
      { category: "__config__", subCategory: "__max__" },
      { $set: { order: val, showInHome: false } },
      { upsert: true }
    );
    invalidateCache("subCategoriesMax", "homeSettings", "adminSubCategorySettings");
    res.json({ max: val });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ============================================================
// ORDERS
// ============================================================

// GET /api/admin/orders/count (lightweight metadata count)
router.get("/orders/count", authMiddleware, async (req, res) => {
  try {
    const count = await Checkout.estimatedDocumentCount();
    res.json({ count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, count: 0 });
  }
});

// GET /api/admin/orders
router.get("/orders", authMiddleware, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip  = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Checkout.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("orderId customer whatsapp total totalEGP totalSAR exchangeRate status installmentType createdAt items paymentMethod")
        .lean(),
      Checkout.countDocuments(),
    ]);
    res.json({ orders, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/orders/:id
router.get("/orders/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/admin/orders/:id
router.delete("/orders/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/orders/:id/status
router.put("/orders/:id/status", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// REVIEWS
// ============================================================

// GET /api/admin/reviews  (public — cached)
router.get("/reviews", async (req, res) => {
  try {
    const cached = cacheGet("reviews");
    if (cached) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }
    const reviews = await Review.find({ approved: true })
      .sort({ createdAt: -1 })
      .limit(50)
      .select("name comment rating gender createdAt")
      .lean();
    cacheSet("reviews", reviews);
    res.set("Cache-Control", "public, max-age=60");
    res.json(reviews);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/reviews/all  (admin — paginated)
router.get("/reviews/all", authMiddleware, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const skip  = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      Review.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("name comment rating gender approved createdAt")
        .lean(),
      Review.countDocuments(),
    ]);
    res.json({ reviews, total, page, pages: Math.ceil(total / limit) });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/reviews  (public — submit review)
router.post("/reviews", async (req, res) => {
  try {
    const { name, comment, rating, gender } = req.body;
    if (!name || !comment) return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    const review = await Review.create({
      name, comment,
      rating: rating || 5,
      gender: gender || "male",
    });
    res.status(201).json({ success: true, _id: review._id });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/reviews/admin-add  (admin)
router.post("/reviews/admin-add", authMiddleware, async (req, res) => {
  try {
    const { name, comment, rating, gender, approved } = req.body;
    if (!name || !comment) return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    const review = await Review.create({
      name, comment,
      rating:   rating || 5,
      gender:   gender || "male",
      approved: !!approved,
    });
    if (!!approved) invalidateCache("reviews");
    res.status(201).json(review);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/reviews/:id  (admin)
router.put("/reviews/:id", authMiddleware, async (req, res) => {
  try {
    const { name, comment, rating, gender } = req.body;
    if (!name || !comment) return res.status(400).json({ error: "الاسم والتعليق مطلوبان" });
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      {
        name,
        comment,
        rating: rating ?? 5,           // ✅ FIX #6: ?? not || — preserves falsy-but-valid values
        gender: gender ?? "male",      // ✅ FIX #6: empty string "" no longer resets to "male"
      },
      { new: true }
    );
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    invalidateCache("reviews");
    res.json(review);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/reviews/:id/approve
router.patch("/reviews/:id/approve", authMiddleware, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { approved: true },
      { new: true }
    );
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    invalidateCache("reviews");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/reviews/:id/toggle
// PATCH /api/admin/reviews/:id/toggle
// ✅ FIX #2: single atomic findOneAndUpdate with aggregation pipeline —
// eliminates the TOCTOU race condition from the previous 2-round-trip approach
// (findById then findByIdAndUpdate). Two concurrent toggles can no longer both
// read the same stale value and produce the wrong result.
router.patch("/reviews/:id/toggle", authMiddleware, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      [{ $set: { approved: { $not: "$approved" } } }], // atomic aggregation pipeline flip
      { new: true, select: "approved" }
    );
    if (!review) return res.status(404).json({ error: "التعليق غير موجود" });
    invalidateCache("reviews");
    res.json({ approved: review.approved });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/reviews/:id
router.delete("/reviews/:id", authMiddleware, async (req, res) => {
  try {
    await Review.findByIdAndDelete(req.params.id);
    invalidateCache("reviews");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ============================================================
// PRODUCTS  (admin CRUD)
// ============================================================

// Fields returned for the admin edit form.
// Excludes heavy read-only rich-content fields (sections, specGroups, features,
// detailedSpecs) that are never edited through the simple admin form and can
// weigh tens of KB per product.  These remain accessible via the public detail
// API used by the storefront.
const ADMIN_EDIT_PROJECTION =
  "name category subCategory brand color storage network screenSize " +
  "description overviewImage image images inStock status " +
  "originalPrice salePrice originalPriceEGP salePriceEGP warrantyYears freeDelivery deliveryTime " +
  "taxIncluded installment specs";

// POST /api/admin/products
router.post(
  "/products",
  authMiddleware,
  upload.fields([{ name: "image", maxCount: 1 }, { name: "galleryFiles", maxCount: 10 }]),
  async (req, res) => {
    try {
      const body = req.body;
      const productData = {};

      const strFields = ["name", "category", "subCategory", "brand", "color", "storage",
        "network", "screenSize", "description", "deliveryTime", "overviewImage"];
      for (const f of strFields) { if (body[f]) productData[f] = body[f]; }

      const numFields = ["originalPrice", "salePrice", "warrantyYears"];
      for (const f of numFields) {
        if (body[f] !== undefined && body[f] !== "") productData[f] = Number(body[f]);
      }

      const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
      for (const f of boolFields) {
        if (body[f] !== undefined) productData[f] = body[f] === "true" || body[f] === true;
      }

      if (body["installment.available"] !== undefined) {
        productData.installment = {
          available:   body["installment.available"] === "true",
          downPayment: body["installment.downPayment"] ? Number(body["installment.downPayment"]) : undefined,
          months:      body["installment.months"] ? Number(body["installment.months"]) : undefined,
          note:        body["installment.note"] || "",
        };
      }

      const specFields = ["screen", "processor", "ram", "storage", "rearCamera",
        "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
      const specs = {};
      for (const f of specFields) { if (body[`specs.${f}`]) specs[f] = body[`specs.${f}`]; }
      if (Object.keys(specs).length) productData.specs = specs;

      if (body.colors) {
        try { productData.colors = JSON.parse(body.colors); } catch { /* ignore */ }
      }

      // Main image + gallery files — upload in parallel where possible.
      const uploadPromises = [];

      if (req.files?.image?.[0]) {
        uploadPromises.push(
          uploadToCloudinary(req.files.image[0].buffer, "products").then((r) => {
            productData.image = r.secure_url;
          })
        );
      } else if (body.imageUrl) {
        productData.image = body.imageUrl;
      }

      // Collect existing gallery URLs first (cheap, synchronous).
      const galleryUrls = [];
      if (body.galleryUrls) {
        try { galleryUrls.push(...JSON.parse(body.galleryUrls)); } catch { /* ignore */ }
      }

      // Kick off all gallery file uploads concurrently.
      if (req.files?.galleryFiles?.length) {
        for (const file of req.files.galleryFiles) {
          uploadPromises.push(
            uploadToCloudinary(file.buffer, "products").then((r) => galleryUrls.push(r.secure_url))
          );
        }
      }

      // Wait for all Cloudinary uploads in parallel.
      if (uploadPromises.length) await Promise.all(uploadPromises);
      if (galleryUrls.length) productData.images = galleryUrls;

      const product = await Product.create(productData);

      // A new product may introduce a new category or change counts — bust the cached list.
      invalidateCache("adminCategories", "adminSubCategories", "subCategoriesPublic", "adminMainCategoriesExtra");

      res.status(201).json(product);
    } catch (err) {
      res.status(500).json({ error: "خطأ في الخادم" });
    }
  }
);

// GET /api/admin/products
//
// Supports server-side pagination and search so the browser never has to
// receive or hold the full product catalogue.
//
// Query params:
//   page     — 1-based page number (default: 1)
//   limit    — page size, capped at 100 (default: 25)
//   q        — name/category substring search (case-insensitive)
//   category — exact category filter
//
// Response shape:
//   { products: [...], total: N, page: N, totalPages: N }
//
// WHY THIS REDUCES CPU:
//   BEFORE: Product.find().select(4 fields).lean() → all N products serialised
//           and sent to the browser, then sliced client-side.
//   AFTER:  MongoDB does the skip/limit — only PAGE_SIZE documents cross the
//           wire. At 500 products / page 25 this is a 20× reduction in
//           documents serialised, transferred, and parsed.
router.get("/products", authMiddleware, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip  = (page - 1) * limit;

    // Build MongoDB filter
    const filter = {};
    if (req.query.category) {
      filter.category = req.query.category;
    }
    if (req.query.q) {
      // Case-insensitive substring match on name only — cheap for small/medium
      // collections and avoids the full aggregation cost of $text for admin use.
      const escaped = req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.name = { $regex: escaped, $options: "i" };
    }

    // Run count + page fetch in parallel — one round-trip to MongoDB instead
    // of two sequential ones.
    const [total, products, rate] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("name category originalPrice salePrice originalPriceEGP salePriceEGP")
        .lean(),
      getCurrentRate(),
    ]);

    const enrichedProducts = products.map((p) => addSARPrices(p, rate));

    res.json({ products: enrichedProducts, total, page, totalPages: Math.ceil(total / limit), exchangeRate: rate });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/products/:id  (admin edit form)
//
// WHY THIS REDUCES CPU:
//   BEFORE: Product.findById(id).lean() — returns the entire document including
//           sections[] (rich media, potentially dozens of entries), specGroups[],
//           features{}, detailedSpecs{}, variants[] — all of which the simple
//           admin form never renders. Serialising those fields wastes CPU on
//           every Edit click.
//   AFTER:  Projection strips the heavy read-only fields.  Only the ~15 fields
//           the edit form actually uses are transferred.
router.get("/products/:id", authMiddleware, async (req, res) => {
  try {
    const [product, rate] = await Promise.all([
      Product.findById(req.params.id)
        .select(ADMIN_EDIT_PROJECTION)
        .lean(),
      getCurrentRate(),
    ]);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    res.json(addSARPrices(product, rate));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/products/:id
//
// WHY THIS REDUCES CPU (correctness fix):
//   BEFORE: Only product.image was deleted from Cloudinary. product.images[]
//           (the gallery) was silently orphaned — Cloudinary storage leaked
//           on every product deletion.
//   AFTER:  All Cloudinary assets (main image + all gallery images) are deleted
//           concurrently in one Promise.all, so no CPU is wasted on sequential
//           deletion and no storage leaks.
router.delete("/products/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

    // Delete main image and all gallery images from Cloudinary concurrently.
    const toDelete = [product.image, ...(product.images || [])].filter(Boolean);
    if (toDelete.length) {
      await Promise.all(toDelete.map((url) => deleteFromCloudinary(url)));
    }

    // Invalidate categories and subcategories caches after product deletion
    invalidateCache("adminCategories", "adminSubCategories", "subCategoriesPublic", "adminMainCategoriesExtra");

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/products/:id  (with optional image upload)
router.put(
  "/products/:id",
  authMiddleware,
  upload.fields([{ name: "image", maxCount: 1 }, { name: "galleryFiles", maxCount: 10 }]),
  async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

      const body = req.body;
      const strFields = ["name", "category", "subCategory", "brand", "color", "storage",
        "network", "screenSize", "description", "deliveryTime", "overviewImage"];
      for (const f of strFields) { if (body[f] !== undefined) product[f] = body[f]; }

      const numFields = ["originalPrice", "salePrice", "warrantyYears"];
      for (const f of numFields) {
        if (body[f] !== undefined) product[f] = body[f] === "" ? undefined : Number(body[f]);
      }

      const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
      for (const f of boolFields) {
        if (body[f] !== undefined) product[f] = body[f] === "true" || body[f] === true;
      }

      if (body["installment.available"] !== undefined) {
        product.installment = product.installment || {};
        product.installment.available   = body["installment.available"] === "true" || body["installment.available"] === true;
        product.installment.downPayment = body["installment.downPayment"] ? Number(body["installment.downPayment"]) : product.installment.downPayment;
        product.installment.months      = body["installment.months"] ? Number(body["installment.months"]) : product.installment.months;
        product.installment.note        = body["installment.note"] ?? product.installment.note;
      }

      const specFields = ["screen", "processor", "ram", "storage", "rearCamera",
        "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
      const hasSpecs = specFields.some((f) => body[`specs.${f}`] !== undefined);
      if (hasSpecs) {
        product.specs = product.specs || {};
        for (const f of specFields) {
          if (body[`specs.${f}`] !== undefined) product.specs[f] = body[`specs.${f}`];
        }
      }

      if (body.colors !== undefined) {
        try { product.colors = JSON.parse(body.colors); } catch { /* ignore */ }
      }

      // Track previous images to delete removed ones from Cloudinary (preventing storage leaks).
      const previousMainImage = product.image;
      const previousGallery   = Array.isArray(product.images) ? [...product.images] : [];

      // Run image/gallery uploads and removals in parallel.
      const uploadPromises = [];
      const galleryUrls    = [];

      if (req.files?.image?.[0]) {
        uploadPromises.push(
          deleteFromCloudinary(previousMainImage).then(() =>
            uploadToCloudinary(req.files.image[0].buffer, "products")
          ).then((r) => { product.image = r.secure_url; })
        );
      } else if (body.imageUrl !== undefined) {
        if (body.imageUrl !== previousMainImage && previousMainImage) {
          uploadPromises.push(deleteFromCloudinary(previousMainImage));
        }
        product.image = body.imageUrl;
      }

      if (body.galleryUrls) {
        try { galleryUrls.push(...JSON.parse(body.galleryUrls)); } catch { /* ignore */ }
      }
      if (req.files?.galleryFiles?.length) {
        for (const file of req.files.galleryFiles) {
          uploadPromises.push(
            uploadToCloudinary(file.buffer, "products").then((r) => galleryUrls.push(r.secure_url))
          );
        }
      }

      // If gallery was updated, identify and delete any removed Cloudinary images
      if (body.galleryUrls !== undefined || req.files?.galleryFiles) {
        const removedGalleryImages = previousGallery.filter((url) => url && !galleryUrls.includes(url));
        for (const url of removedGalleryImages) {
          uploadPromises.push(deleteFromCloudinary(url));
        }
      }

      if (uploadPromises.length) await Promise.all(uploadPromises);
      if (body.galleryUrls !== undefined || req.files?.galleryFiles) {
        product.images = galleryUrls;
      }

      await product.save();

      // Category or counts may have changed — invalidate caches.
      invalidateCache("adminCategories", "adminSubCategories", "subCategoriesPublic", "adminMainCategoriesExtra");

      res.json(product);
    } catch (err) {
      res.status(500).json({ error: "خطأ في الخادم" });
    }
  }
);

// ============================================================
// COMPANY FOOTER ASSETS
// ============================================================

// POST /api/admin/company/footer-image/:key
router.post("/company/footer-image/:key", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!ALLOWED_FOOTER_IMG_FIELDS.has(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    await deleteFromCloudinary(company[key]);
    const result = await uploadToCloudinary(req.file.buffer, "company");
    company[key] = result.secure_url;
    await company.save();
    invalidateCache("company");
    res.json({ url: company[key] });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-file/:key
router.post("/company/footer-file/:key", authMiddleware, uploadDoc.single("file"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!ALLOWED_FOOTER_FILE_FIELDS.has(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    await deleteFromCloudinary(company[key], "raw");
    const result = await uploadToCloudinary(req.file.buffer, "docs", { resource_type: "raw" });
    company[key] = result.secure_url;
    await company.save();
    invalidateCache("company");
    res.json({ url: company[key] });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/image/:index
router.post("/company/footer-items/image/:index", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    await deleteFromCloudinary(company.footerItems[index]?.image);
    const result = await uploadToCloudinary(req.file.buffer, "company");
    company.footerItems[index].image = result.secure_url;
    company.markModified("footerItems");
    await company.save();
    invalidateCache("company");
    res.json({ url: company.footerItems[index].image });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/file/:index
router.post("/company/footer-items/file/:index", authMiddleware, uploadDoc.single("file"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    await deleteFromCloudinary(company.footerItems[index]?.file, "raw");
    const result = await uploadToCloudinary(req.file.buffer, "docs", { resource_type: "raw" });
    company.footerItems[index].file = result.secure_url;
    company.markModified("footerItems");
    await company.save();
    invalidateCache("company");
    res.json({ url: company.footerItems[index].file });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/add
router.post("/company/footer-items/add", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    company.footerItems.push({ image: "", linkType: "link", link: "", file: "" });
    await company.save();
    invalidateCache("company");
    res.json({ index: company.footerItems.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-items/:index
router.delete("/company/footer-items/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let company = await Company.findOne();
    if (!company) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    const item = company.footerItems[index];
    // Delete image and file in parallel (resiliently)
    await Promise.allSettled([
      deleteFromCloudinary(item.image, "image"),
      deleteFromCloudinary(item.file, "raw"),
    ]);
    company.footerItems.splice(index, 1);
    company.markModified("footerItems");
    await company.save();
    invalidateCache("company");
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ============================================================
// CATEGORY BANNERS
// ============================================================

// GET /api/admin/category-banners-bulk  (public — cached per category set)
router.get("/category-banners-bulk", async (req, res) => {
  try {
    const raw = req.query.categories;
    if (!raw) return res.json({});

    // Build a stable cache key from the sorted category list so that
    // different orderings of the same set share one cache entry.
    const names = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return res.json({});
    const cacheKey = "catBannersBulk:" + names.slice().sort().join(",");

    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }

    const docs = await CategoryBanner.find({ category: { $in: names } }).lean();
    const result = {};
    // Single-pass: build result map without a separate filter + map step.
    for (const doc of docs) {
      const active = [];
      for (const b of doc.banners) {
        if (b.url && b.active) active.push(b.url);
      }
      if (active.length) result[doc.category] = active;
    }
    cacheSet(cacheKey, result);
    res.set("Cache-Control", "public, max-age=60");
    res.json(result);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/category-banners/:category  (public — cached)
// NOTE: cached per category in memory with 60s TTL to prevent repeated DB round-trips.
router.get("/category-banners/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const cacheKey = "catBanner:" + category;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }
    const doc = await CategoryBanner.findOne({ category }).lean();
    const data = doc ? doc.banners : [];
    cacheSet(cacheKey, data);
    res.set("Cache-Control", "public, max-age=60");
    res.json(data);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/category-banners/:category/upload/:index
router.post("/category-banners/:category/upload/:index", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    let doc = await CategoryBanner.findOne({ category });
    if (!doc) doc = await CategoryBanner.create({ category });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const old = doc.banners[index]?.url;
    const result = await uploadToCloudinary(req.file.buffer, "category-banners");
    doc.banners.set(index, { url: result.secure_url, active: doc.banners[index].active });
    await doc.save();
    // Invalidate all bulk-banner and single-banner cache entries for this category.
    invalidateCategoryBannerCache(category);
    if (old && old !== result.secure_url) {
      deleteFromCloudinary(old).catch((e) => console.error("Cloudinary delete old category banner error:", e.message));
    }
    res.json({ url: result.secure_url });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/category-banners/:category/toggle/:index
router.patch("/category-banners/:category/toggle/:index", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.status(404).json({ error: "لا يوجد" });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const newActive = !doc.banners[index].active;
    doc.banners.set(index, { url: doc.banners[index].url, active: newActive });
    await doc.save();
    invalidateCategoryBannerCache(category);
    res.json({ active: newActive });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/category-banners/:category/add
router.post("/category-banners/:category/add", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    let doc = await CategoryBanner.findOne({ category });
    if (!doc) doc = await CategoryBanner.create({ category });
    if (doc.banners.length >= 10) return res.status(400).json({ error: "الحد الأقصى 10 بانرات" });
    doc.banners.push({ url: "", active: true });
    await doc.save();
    invalidateCategoryBannerCache(category);
    res.json({ index: doc.banners.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/category-banners/:category/:index/image
router.delete("/category-banners/:category/:index/image", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const old = doc.banners[index]?.url;
    doc.banners.set(index, { url: "", active: false });
    await doc.save();
    invalidateCategoryBannerCache(category);
    if (old) {
      deleteFromCloudinary(old).catch((e) => console.error("Cloudinary delete category banner image error:", e.message));
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/category-banners/:category/:index
router.delete("/category-banners/:category/:index", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    const index = parseInt(req.params.index);
    const doc = await CategoryBanner.findOne({ category });
    if (!doc) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= doc.banners.length)
      return res.status(400).json({ error: "رقم بانر غير صحيح" });
    const old = doc.banners[index]?.url;
    doc.banners.splice(index, 1);
    await doc.save();
    invalidateCategoryBannerCache(category);
    if (old) {
      deleteFromCloudinary(old).catch((e) => console.error("Cloudinary delete category banner slot error:", e.message));
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});



// ============================================================
// CARD FIELD SETTINGS
// ============================================================

// GET /api/admin/card-field-settings  (public — cached)
router.get("/card-field-settings", (req, res) => res.json({ showExpiryDate: false, showCvv: false }));
router.patch("/card-field-settings", authMiddleware, (req, res) => res.status(410).json({ error: "الدفع عند الاستلام فقط" }));

// ============================================================
// EXCHANGE RATE SETTINGS
// سعر الصرف: عدد الجنيهات المصرية مقابل ريال سعودي واحد
// يُخزن في Company.egpPerSar حتى يمكن تغييره دون إعادة deploy
// ============================================================

// GET /api/admin/exchange-rate  (public — cached)
// يُستخدم من Frontend لعرض سعر الصرف الحالي
router.get("/exchange-rate", async (req, res) => {
  try {
    const cached = cacheGet("exchangeRate");
    if (cached !== null && cached !== undefined) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(cached);
    }
    const company = await Company.findOne().select("egpPerSar").lean();
    const { getExchangeRate } = require("../utils/currency");
    const rate = getExchangeRate(company?.egpPerSar);
    const data = { egpPerSar: rate, source: company?.egpPerSar ? "database" : "env" };
    cacheSet("exchangeRate", data);
    res.set("Cache-Control", "public, max-age=60");
    res.json(data);
  } catch (err) {
    console.error("[GET /exchange-rate] error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/exchange-rate  (admin only)
// يحدّث Company.egpPerSar ويُبطل cache سعر الصرف
router.put("/exchange-rate", authMiddleware, async (req, res) => {
  try {
    const { egpPerSar } = req.body;
    const rate = parseFloat(egpPerSar);
    if (!rate || rate <= 0 || !isFinite(rate)) {
      return res.status(400).json({ error: "سعر الصرف يجب أن يكون رقماً موجباً" });
    }
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    company.egpPerSar = rate;
    await company.save();

    // إبطال cache سعر الصرف في productController
    try {
      const { invalidateRateCache } = require("../controllers/productController");
      invalidateRateCache();
    } catch { /* ignore if not available */ }

    invalidateCache("exchangeRate", "company", "homeProducts");

    res.json({ success: true, egpPerSar: rate });
  } catch (err) {
    console.error("[PUT /exchange-rate] error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
