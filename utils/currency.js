/**
 * currency.js — المكان الوحيد المسؤول عن منطق تحويل العملة في المشروع.
 *
 * القاعدة الأساسية:
 *   EGP = السعر الأساسي (source of truth)
 *   SAR = EGP / EGP_PER_SAR
 *
 * مثال:
 *   priceEGP  = 50,000
 *   rate      = 14
 *   priceSAR  = 50,000 / 14 = 3,571.43
 *
 * سعر الصرف يُقرأ بالأولوية من:
 *   1. الـ Company document في قاعدة البيانات (Company.egpPerSar) — يمكن تغييره من Admin دون deploy
 *   2. متغير البيئة EGP_PER_SAR
 *   3. القيمة الافتراضية 14
 */

"use strict";

// القيمة الافتراضية من .env أو 14
const DEFAULT_RATE = parseFloat(process.env.EGP_PER_SAR) || 14;

/**
 * تحويل مبلغ من الجنيه المصري إلى الريال السعودي.
 *
 * @param {number} egp    - المبلغ بالجنيه المصري
 * @param {number} [rate] - عدد الجنيهات لكل ريال (EGP per 1 SAR)
 * @returns {number}       - المبلغ بالريال مقرّباً لمنزلتين عشريتين بدقة مالية
 */
function convertEGPToSAR(egp, rate) {
  const r = (typeof rate === "number" && rate > 0) ? rate : DEFAULT_RATE;
  if (typeof egp !== "number" || egp < 0 || !isFinite(egp)) return 0;
  // تقريب مالي آمن بدون floating-point drift:
  // Math.round(n * 100) / 100 يضمن دقة منزلتين عشريتين كحد أقصى
  return Math.round((egp / r) * 100) / 100;
}

/**
 * تحويل مبلغ من الريال السعودي إلى الجنيه المصري (لأغراض الـ Migration وحساب القيمة الاقتصادية).
 *
 * @param {number} sar    - المبلغ بالريال السعودي
 * @param {number} [rate] - عدد الجنيهات لكل ريال (EGP per 1 SAR)
 * @returns {number}       - المبلغ بالجنيه مقرّباً
 */
function convertSARToEGP(sar, rate) {
  const r = (typeof rate === "number" && rate > 0) ? rate : DEFAULT_RATE;
  if (typeof sar !== "number" || sar < 0 || !isFinite(sar)) return 0;
  return Math.round(sar * r);
}

/**
 * الحصول على سعر الصرف الحالي.
 * يقبل قيمة من Company document إن وُجدت، وإلا يستخدم .env أو الافتراضي.
 *
 * @param {number|null} [companyRate] - القيمة المحفوظة في Company.egpPerSar
 * @returns {number}
 */
function getExchangeRate(companyRate) {
  if (typeof companyRate === "number" && companyRate > 0) return companyRate;
  return DEFAULT_RATE;
}

/**
 * إضافة حقول الأسعار الواضحة (EGP و SAR) إلى كائن منتج عادي (lean object).
 *
 * الحقول المضافة:
 *   - exchangeRate: سعر الصرف المستخدم
 *   - originalPriceEGP: السعر الأصلي بالجنيه
 *   - salePriceEGP: سعر الخصم بالجنيه (إن وُجد)
 *   - priceEGP: السعر المعروض الفعلي بالجنيه (salePrice إن وُجد وإلا originalPrice)
 *   - originalPriceSAR: السعر الأصلي بالريال المقابل
 *   - salePriceSAR: سعر الخصم بالريال المقابل (إن وُجد)
 *   - priceSAR: السعر المعروض الفعلي بالريال المقابل
 *   - price: للتوافق مع المكونات القديمة (= priceEGP)
 *
 * @param {object} obj  - الكائن الذي سيُعدَّل (lean product)
 * @param {number} rate - سعر الصرف (EGP per 1 SAR)
 * @returns {object}
 */
function addSARPrices(obj, rate) {
  if (!obj) return obj;
  obj.exchangeRate = rate;

  // إذا كان سعر التخفيض يساوي أو يتجاوز السعر الأصلي، فهو ليس تخفيضاً حقيقياً
  if (obj.salePrice != null && obj.salePrice >= obj.originalPrice) {
    delete obj.salePrice;
    delete obj.salePriceEGP;
  }

  // أسعار الجنيه الأساسية
  obj.originalPriceEGP = obj.originalPrice ?? 0;
  if (obj.salePrice != null) {
    obj.salePriceEGP = obj.salePrice;
  }
  obj.priceEGP = (obj.salePrice != null && obj.salePrice > 0) ? obj.salePrice : obj.originalPriceEGP;

  // أسعار الريال المحسوبة
  obj.originalPriceSAR = convertEGPToSAR(obj.originalPriceEGP, rate);
  if (obj.salePrice != null) {
    obj.salePriceSAR = convertEGPToSAR(obj.salePriceEGP, rate);
  }
  obj.priceSAR = (obj.salePrice != null && obj.salePriceSAR != null) ? obj.salePriceSAR : obj.originalPriceSAR;

  // الحقل القديم للتوافق = priceEGP (السعر الأساسي)
  obj.price = obj.priceEGP;

  if (obj.installment && typeof obj.installment === "object") {
    if (obj.installment.downPayment != null) {
      obj.installment.downPaymentEGP = obj.installment.downPayment;
      obj.installment.downPaymentSAR = convertEGPToSAR(obj.installment.downPayment, rate);
    }
  }

  return obj;
}

/**
 * إضافة حقول EGP و SAR لـ storageOptions داخل variants.
 *
 * @param {object} obj  - الكائن (lean product)
 * @param {number} rate
 * @returns {object}
 */
function addSARPricesToVariants(obj, rate) {
  if (!obj || !Array.isArray(obj.variants)) return obj;
  obj.variants = obj.variants.map((v) => {
    if (!Array.isArray(v.storageOptions)) return v;
    v.storageOptions = v.storageOptions.map((opt) => {
      const origEGP = opt.originalPrice ?? 0;
      const saleEGP = opt.salePrice != null ? opt.salePrice : undefined;
      const pEGP = saleEGP != null ? saleEGP : origEGP;

      const origSAR = convertEGPToSAR(origEGP, rate);
      const saleSAR = saleEGP != null ? convertEGPToSAR(saleEGP, rate) : undefined;
      const pSAR = saleSAR != null ? saleSAR : origSAR;

      return {
        ...opt,
        originalPriceEGP: origEGP,
        salePriceEGP: saleEGP,
        priceEGP: pEGP,
        originalPriceSAR: origSAR,
        salePriceSAR: saleSAR,
        priceSAR: pSAR,
        price: pEGP,
      };
    });
    return v;
  });
  return obj;
}

// Storefront responses expose EGP only. Conversion helpers remain for historical migrations.
function egpPrices(obj, rate) {
  if (!obj) return obj;
  for (const key of Object.keys(obj)) if (key.endsWith('SAR') || key === 'exchangeRate') delete obj[key];
  if (obj.salePrice != null && (obj.salePrice <= 0 || obj.salePrice >= obj.originalPrice)) delete obj.salePrice;
  obj.currency = 'EGP';
  obj.exchangeRate = getExchangeRate(rate);
  obj.originalPriceEGP = obj.originalPrice;
  obj.salePriceEGP = obj.salePrice;
  obj.price = obj.priceEGP = obj.salePrice ?? obj.originalPrice;
  if (obj.installment) { delete obj.installment.downPaymentSAR; obj.installment.available = false; }
  return obj;
}
function egpVariants(obj) {
  for (const variant of obj?.variants || []) for (const option of variant.storageOptions || []) egpPrices(option);
  return obj;
}
module.exports = { convertEGPToSAR, convertSARToEGP, getExchangeRate, DEFAULT_RATE, addSARPrices: egpPrices, addSARPricesToVariants: egpVariants };
