const Product = require("../models/Product");
const Company = require("../models/Company");
const SubCategorySettings = require("../models/SubCategorySettings");
const { getExchangeRate, addSARPrices, addSARPricesToVariants } = require("../utils/currency");

// ---------------------------------------------------------------------------
// In-process TTL cache for product queries (reduces MongoDB load & CPU)
// ---------------------------------------------------------------------------
const PRODUCTS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const MAX_PRODUCTS_CACHE_ENTRIES = 100;
const _productsCache = new Map();

// Cache لسعر الصرف — يُحدَّث كل دقيقة بدلاً من استعلام DB لكل request
let _rateCache = null;
let _rateCacheTime = 0;
const RATE_CACHE_TTL_MS = 60_000; // دقيقة واحدة

function cacheGet(key) {
  const entry = _productsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _productsCache.delete(key);
    return null;
  }
  _productsCache.delete(key);
  _productsCache.set(key, entry);
  return entry.data;
}

function cacheSet(key, data) {
  if (_productsCache.size >= MAX_PRODUCTS_CACHE_ENTRIES) {
    _productsCache.delete(_productsCache.keys().next().value);
  }
  _productsCache.set(key, { data, expiresAt: Date.now() + PRODUCTS_CACHE_TTL_MS });
}

function invalidateProductsCache() {
  _productsCache.clear();
  // إعادة تعيين cache سعر الصرف عند تغيير المنتجات أو الإعدادات
  _rateCache = null;
  _rateCacheTime = 0;
}

exports.invalidateProductsCache = invalidateProductsCache;

/**
 * إعادة تعيين cache سعر الصرف فقط (عند تغيير egpPerSar في Company).
 * يُستدعى من adminRoutes عند تحديث سعر الصرف.
 */
function invalidateRateCache() {
  _rateCache = null;
  _rateCacheTime = 0;
}
exports.invalidateRateCache = invalidateRateCache;

// ---------------------------------------------------------------------------
// الحصول على سعر الصرف الفعلي (DB أولاً ثم env ثم 14)
// مع cache لمدة دقيقة واحدة لتخفيف الضغط على MongoDB
// ---------------------------------------------------------------------------
async function getCurrentRate() {
  const now = Date.now();
  if (_rateCache !== null && (now - _rateCacheTime) < RATE_CACHE_TTL_MS) {
    return _rateCache;
  }
  try {
    const company = await Company.findOne().select("egpPerSar").lean();
    const rate = getExchangeRate(company?.egpPerSar);
    _rateCache = rate;
    _rateCacheTime = now;
    return rate;
  } catch {
    return getExchangeRate(null);
  }
}

// ---------------------------------------------------------------------------
// Projection strings
// ---------------------------------------------------------------------------

const LIST_FIELDS =
  "name originalPrice salePrice originalPriceEGP salePriceEGP image images color storage network " +
  "freeDelivery deliveryTime warrantyYears inStock status purchasable " +
  "category subCategory brand";

const DETAIL_FIELDS =
  "name brief originalPrice salePrice originalPriceEGP salePriceEGP image images variants " +
  "color storage network screenSize overview overviewImage " +
  "specs specGroups features detailedSpecs sections " +
  "freeDelivery deliveryTime warrantyYears inStock status purchasable " +
  "installment taxIncluded category subCategory brand description";

// ---------------------------------------------------------------------------
// discountPercent helper — يُضاف لكل lean() object
// ---------------------------------------------------------------------------
function addDiscount(obj) {
  if (!obj) return obj;
  const orig = obj.originalPrice;
  const sale = obj.salePrice;
  obj.discountPercent =
    sale != null && sale !== orig && orig > 0
      ? Math.round(((orig - sale) / orig) * 100)
      : 0;
  return obj;
}

/**
 * تطبيق addDiscount + addSARPrices على lean object.
 * هذا المكان الوحيد الذي يحسب priceSAR في الـ response.
 */
function enrichProduct(obj, rate) {
  addDiscount(obj);
  addSARPrices(obj, rate);
  return obj;
}

/**
 * نفس enrichProduct لكن يشمل variants أيضاً (للـ detail endpoint).
 */
function enrichProductDetail(obj, rate) {
  addDiscount(obj);
  addSARPrices(obj, rate);
  addSARPricesToVariants(obj, rate);
  return obj;
}

// ---------------------------------------------------------------------------
// Arabic normalization helper
// ---------------------------------------------------------------------------
function normalizeArabic(str) {
  return str
    .replace(/[أإآا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

// ---------------------------------------------------------------------------
// Category query builder
// ---------------------------------------------------------------------------
function buildCategoryQuery(category) {
  const cat = category.trim();
  const escaped = cat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizedCat = escaped
    .replace(/[أإآ]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
  const pattern = normalizedCat.replace(/ا/g, "[أإآا]");
  return { $regex: new RegExp(`^${pattern}$`, "i") };
}

// ---------------------------------------------------------------------------
// Arabic substring search fallback
// ---------------------------------------------------------------------------
const SEARCH_SCAN_LIMIT  = 100;
const SEARCH_MAX_RESULTS = 30;

function buildArabicSubstringPattern(str) {
  const trimmed = str.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped
    .replace(/[أإآا]/g, "[أإآا]")
    .replace(/[ىي]/g, "[ىي]")
    .replace(/[ةه]/g, "[ةه]")
    .replace(/[ؤو]/g, "[ؤو]")
    .replace(/[ئ]/g, "[ئ]");
}

async function arabicSubstringSearch(query, q) {
  try {
    const pattern = buildArabicSubstringPattern(q);
    const regexResults = await Product.find({
      ...query,
      name: { $regex: pattern, $options: "i" },
    })
      .select(LIST_FIELDS)
      .limit(SEARCH_MAX_RESULTS)
      .lean();

    if (regexResults.length > 0) return regexResults;
  } catch {
    // fall through
  }

  const normalized = normalizeArabic(q);
  const docs = await Product.find(query)
    .select(LIST_FIELDS)
    .sort({ createdAt: 1 })
    .limit(SEARCH_SCAN_LIMIT)
    .lean();

  const results = [];
  for (const doc of docs) {
    if (normalizeArabic(doc.name).includes(normalized)) {
      results.push(doc);
      if (results.length === SEARCH_MAX_RESULTS) break;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// GET /api/products/home
// ---------------------------------------------------------------------------
exports.getHomeProducts = async (req, res) => {
  try {
    const cached = cacheGet("homeProducts");
    if (cached) {
      res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
      return res.json(cached);
    }

    const [settings, rate] = await Promise.all([
      SubCategorySettings.find({
        category: { $ne: "__config__" },
        showInHome: true,
      }).sort({ order: 1 }).lean(),
      getCurrentRate(),
    ]);

    const homeCategories = settings.map((s) => s.category).filter(Boolean);
    const query = homeCategories.length > 0 ? { category: { $in: homeCategories } } : {};

    const products = await Product.find(query)
      .select(LIST_FIELDS)
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();

    const result = products.map((p) => enrichProduct(p, rate));
    cacheSet("homeProducts", result);

    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    return res.json(result);
  } catch (err) {
    console.error("[getHomeProducts] error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/products
// ---------------------------------------------------------------------------
exports.getProducts = async (req, res) => {
  try {
    const { q, brand, category } = req.query;
    const limitParam = parseInt(req.query.limit) || 0;

    const cacheKey = `list:${q || ""}:${brand || ""}:${category || ""}:${limitParam}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
      return res.json(cached);
    }

    const [rate] = await Promise.all([getCurrentRate()]);

    const query = {};
    if (brand) {
      const escapedBrand = brand.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.brand = { $regex: new RegExp(`^${escapedBrand}$`, "i") };
    }
    if (category) {
      if (category.includes(",")) {
        const cats = category.split(",").map((c) => c.trim()).filter(Boolean);
        query.$or = cats.map((c) => ({ category: buildCategoryQuery(c) }));
      } else {
        query.category = buildCategoryQuery(category);
      }
    }

    if (!q) {
      const effectiveLimit = limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const products = await Product.find(query)
        .select(LIST_FIELDS)
        .sort({ createdAt: 1 })
        .limit(effectiveLimit)
        .lean();
      const result = products.map((p) => enrichProduct(p, rate));
      cacheSet(cacheKey, result);
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
      return res.json(result);
    }

    try {
      const results = await Product.find({ ...query, $text: { $search: q } })
        .select(LIST_FIELDS)
        .limit(SEARCH_MAX_RESULTS)
        .lean();

      if (results.length > 0) {
        const result = results.map((p) => enrichProduct(p, rate));
        cacheSet(cacheKey, result);
        res.set("Cache-Control", "public, max-age=30");
        return res.json(result);
      }
    } catch {
      // $text index missing — fall through
    }

    const fallback = await arabicSubstringSearch(query, q);
    const result = fallback.map((p) => enrichProduct(p, rate));
    cacheSet(cacheKey, result);
    res.set("Cache-Control", "public, max-age=30");
    return res.json(result);
  } catch (err) {
    console.error("[getProducts] error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/products/:id
// ---------------------------------------------------------------------------
exports.getProduct = async (req, res) => {
  try {
    const cacheKey = `single:${req.params.id}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
      return res.json(cached);
    }

    const [product, rate] = await Promise.all([
      Product.findById(req.params.id).select(DETAIL_FIELDS).lean(),
      getCurrentRate(),
    ]);

    if (!product) return res.status(404).json({ message: "Product not found" });
    const result = enrichProductDetail(product, rate);
    cacheSet(cacheKey, result);
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
    res.json(result);
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Product not found" });
    }
    console.error("[getProduct] error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/products — legacy seed scripts only
// ---------------------------------------------------------------------------
exports.createProduct = async (req, res) => {
  try {
    const product = await Product.create(req.body);
    invalidateProductsCache();
    res.status(201).json(product);
  } catch (err) {
    console.error("[createProduct] error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/products/:id
// ---------------------------------------------------------------------------
exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!product) return res.status(404).json({ message: "Product not found" });
    invalidateProductsCache();
    res.json(product);
  } catch (err) {
    if (err.name === "CastError")
      return res.status(404).json({ message: "Product not found" });
    console.error("[updateProduct] error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/products/:id
// ---------------------------------------------------------------------------
exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    invalidateProductsCache();
    res.json({ message: "Product deleted" });
  } catch (err) {
    if (err.name === "CastError")
      return res.status(404).json({ message: "Product not found" });
    console.error("[deleteProduct] error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/products/exchange-rate
// ---------------------------------------------------------------------------
exports.getPublicExchangeRate = async (req, res) => {
  try {
    const rate = await getCurrentRate();
    res.set("Cache-Control", "public, max-age=60");
    res.json({ exchangeRate: rate, egpPerSar: rate });
  } catch (err) {
    res.status(500).json({ error: "Failed to get exchange rate" });
  }
};

exports.getCurrentRate = getCurrentRate;

