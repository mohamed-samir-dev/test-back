/**
 * migrate-prices.js
 *
 * السكربت الآمن لإعادة تصميم نظام الأسعار وتحويله إلى:
 *   EGP = السعر الأساسي ومرجع الحقيقة (Source of Truth)
 *   SAR = السعر المقابل المحسوب من (EGP / EGP_PER_SAR)
 *
 * الحفاظ على القيمة الاقتصادية (أهم شرط):
 *   الأسعار الحالية في قاعدة البيانات مخزنة بالريال السعودي (SAR).
 *   للحفاظ على القيمة الاقتصادية الحقيقية:
 *     Old Currency: SAR
 *     Old Value (SAR): مثلاً 5,999 ريال
 *     New EGP Value: 5,999 * 14 = 83,986 جنيه مصري
 *     New EGP → SAR: 83,986 / 14 = 5,999.00 ريال سعودي
 *   بهذا تظل القيمة بالريال مطابقة تماماً، ويصبح السعر الأساسي بالجنيه المصري!
 *
 * الأمان والنسخ الاحتياطي:
 *   1. حفظ نسخة احتياطية كاملة في ملف JSON محلي في backend/backups/
 *   2. حفظ نسخة احتياطية في MongoDB في collections: products_backup و checkouts_backup
 *   3. توفير سكربت rollback-prices.js للتراجع الكامل في أي وقت
 *   4. منع الترحيل المزدوج عبر فحص migratedToEGP
 *
 * الاستخدام:
 *   node scripts/migrate-prices.js [--rate=14] [--dry-run]
 */

"use strict";

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const mongoose = require("mongoose");
const Product = require("../models/Product");
const Company = require("../models/Company");
const Checkout = require("../models/Checkout");
const { convertEGPToSAR, getExchangeRate } = require("../utils/currency");

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const rateArg = args.find((a) => a.startsWith("--rate="));
const rate = rateArg ? parseFloat(rateArg.split("=")[1]) : (parseFloat(process.env.EGP_PER_SAR) || 14);

if (!rate || rate <= 0 || !isFinite(rate)) {
  console.error("❌ سعر الصرف غير صحيح. مثال: --rate=14");
  process.exit(1);
}

function fmt(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         Migration: تحويل نظام الأسعار إلى EGP الأساسي            ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  console.log(`💱 سعر الصرف المعتمد: 1 SAR = ${rate} EGP`);
  console.log(`⚙️  الوضع: ${isDryRun ? "🔍 DRY RUN (فحص بدون تعديل)" : "🚀 LIVE (تعديل فعلي مع أخذ نسخ احتياطية)"}\n`);

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ تم الاتصال بقاعدة البيانات بنجاح\n");

  // 1. فحص المنتجات الحالية
  const rawProducts = await Product.find({}).lean();
  console.log(`📦 إجمالي المنتجات الحالية: ${rawProducts.length}`);

  const alreadyMigrated = rawProducts.filter((p) => p.migratedToEGP === true);
  const toMigrate = rawProducts.filter((p) => p.migratedToEGP !== true);

  console.log(`ℹ️  منتجات مرحّلة مسبقاً:   ${alreadyMigrated.length}`);
  console.log(`🔄 منتجات بحاجة للترحيل:    ${toMigrate.length}\n`);

  // 2. فحص الطلبات الحالية
  const rawOrders = await Checkout.find({}).lean();
  console.log(`📋 إجمالي الطلبات الحالية: ${rawOrders.length}`);
  const ordersAlreadyDone = rawOrders.filter((o) => o.exchangeRate != null);
  const ordersToMigrate = rawOrders.filter((o) => o.exchangeRate == null);
  console.log(`ℹ️  طلبات محدثة بـ snapshot: ${ordersAlreadyDone.length}`);
  console.log(`🔄 طلبات بحاجة لـ snapshot:  ${ordersToMigrate.length}\n`);

  // 3. عينات توضيحية قبل البدء
  console.log("📋 أمثلة على التحويل للحفاظ على القيمة الاقتصادية:");
  console.log("─".repeat(80));
  console.log(
    "اسم المنتج".padEnd(32) +
    "السعر القديم (SAR)".padEnd(20) +
    "السعر الجديد (EGP)".padEnd(20) +
    "المعادل (SAR)"
  );
  console.log("─".repeat(80));

  for (const p of toMigrate.slice(0, 6)) {
    const oldSAR = p.originalPrice || 0;
    const newEGP = Math.round(oldSAR * rate);
    const eqSAR = convertEGPToSAR(newEGP, rate);
    console.log(
      (p.name || "").slice(0, 30).padEnd(32) +
      fmt(oldSAR).padEnd(20) +
      fmt(newEGP).padEnd(20) +
      fmt(eqSAR)
    );
  }
  console.log("─".repeat(80) + "\n");

  if (isDryRun) {
    console.log("🔍 وضع DRY RUN — لم يتم إجراء أي تغيير في قاعدة البيانات.");
    await mongoose.connection.close();
    process.exit(0);
  }

  // 4. أخذ Backup كامل قبل أي تعديل
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(__dirname, "../backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const backupFilePath = path.join(backupDir, `backup-before-egp-migration-${timestamp}.json`);
  const backupData = {
    timestamp: new Date().toISOString(),
    rate,
    productsCount: rawProducts.length,
    ordersCount: rawOrders.length,
    products: rawProducts,
    orders: rawOrders,
  };

  fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), "utf-8");
  console.log(`💾 تم حفظ نسخة احتياطية في الملف: ${backupFilePath}`);

  // حفظ نسخة احتياطية في MongoDB أيضاً
  const db = mongoose.connection.db;
  const backupColNameProducts = `products_backup_${timestamp.replace(/-/g, "_")}`;
  const backupColNameOrders = `checkouts_backup_${timestamp.replace(/-/g, "_")}`;

  if (rawProducts.length > 0) {
    await db.collection(backupColNameProducts).insertMany(rawProducts);
    console.log(`💾 تم حفظ نسخة المنتجات في MongoDB collection: ${backupColNameProducts}`);
  }
  if (rawOrders.length > 0) {
    await db.collection(backupColNameOrders).insertMany(rawOrders);
    console.log(`💾 تم حفظ نسخة الطلبات في MongoDB collection: ${backupColNameOrders}`);
  }
  console.log("");

  // 5. ترحيل المنتجات
  console.log("🚀 جاري ترحيل أسعار المنتجات إلى EGP...");
  let migratedProductsCount = 0;

  for (const p of toMigrate) {
    const oldOriginalSAR = p.originalPrice || 0;
    const newOriginalEGP = Math.round(oldOriginalSAR * rate);

    const updateFields = {
      originalPrice: newOriginalEGP,
      originalPriceEGP: newOriginalEGP,
      migratedToEGP: true,
    };

    if (p.salePrice != null && p.salePrice > 0) {
      const oldSaleSAR = p.salePrice;
      const newSaleEGP = Math.round(oldSaleSAR * rate);
      updateFields.salePrice = newSaleEGP;
      updateFields.salePriceEGP = newSaleEGP;
    }

    // ترحيل variants إن وُجدت
    if (Array.isArray(p.variants) && p.variants.length > 0) {
      updateFields.variants = p.variants.map((v) => {
        if (!Array.isArray(v.storageOptions)) return v;
        const newOptions = v.storageOptions.map((opt) => {
          const newOpt = { ...opt };
          if (opt.originalPrice != null) {
            newOpt.originalPrice = Math.round(opt.originalPrice * rate);
            newOpt.originalPriceEGP = newOpt.originalPrice;
          }
          if (opt.salePrice != null) {
            newOpt.salePrice = Math.round(opt.salePrice * rate);
            newOpt.salePriceEGP = newOpt.salePrice;
          }
          return newOpt;
        });
        return { ...v, storageOptions: newOptions };
      });
    }

    await Product.updateOne({ _id: p._id }, { $set: updateFields });
    migratedProductsCount++;
  }
  console.log(`✅ تم ترحيل ${migratedProductsCount} منتج بنجاح!\n`);

  // 6. ترحيل الطلبات القديمة (Snapshot)
  console.log("🚀 جاري تحديث بيانات snapshot للطلبات القديمة...");
  let migratedOrdersCount = 0;

  for (const o of ordersToMigrate) {
    const oldTotalSAR = o.total || 0;
    const newTotalEGP = Math.round(oldTotalSAR * rate);

    const updatedItems = (o.items || []).map((it) => {
      const itemSAR = it.price || it.priceSAR || 0;
      const itemEGP = Math.round(itemSAR * rate);
      return {
        ...it,
        priceSAR: itemSAR,
        priceEGP: itemEGP,
        exchangeRate: rate,
      };
    });

    await Checkout.updateOne(
      { _id: o._id },
      {
        $set: {
          totalSAR: oldTotalSAR,
          totalEGP: newTotalEGP,
          exchangeRate: rate,
          items: updatedItems,
        },
      }
    );
    migratedOrdersCount++;
  }
  console.log(`✅ تم تحديث ${migratedOrdersCount} طلب بـ snapshot الأسعار وسعر الصرف!\n`);

  // 7. تحديث Company.egpPerSar
  let company = await Company.findOne();
  if (!company) company = await Company.create({});
  company.egpPerSar = rate;
  await company.save();
  console.log(`✅ تم ضبط Company.egpPerSar = ${rate}\n`);

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                 اكتملت عملية Migration بنجاح!                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");
  console.log(`📊 ملخص التقرير:`);
  console.log(`   - عدد المنتجات المرحّلة: ${migratedProductsCount}`);
  console.log(`   - عدد الطلبات المحدثة:   ${migratedOrdersCount}`);
  console.log(`   - سعر الصرف المعتمد:     1 SAR = ${rate} EGP`);
  console.log(`   - ملف النسخة الاحتياطية: ${backupFilePath}`);
  console.log(`   - كولكشن الـ Backup في DB: ${backupColNameProducts}`);
  console.log("");

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ حدث خطأ غير متوقع أثناء الـ Migration:", err);
  mongoose.connection.close().finally(() => process.exit(1));
});
