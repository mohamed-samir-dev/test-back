/**
 * validate-prices.js
 *
 * سكربت الفحص والتحقق من صحة بيانات الأسعار والتحويلات بعد الـ Migration.
 *
 * الاستخدام:
 *   node scripts/validate-prices.js [--rate=14]
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const mongoose = require("mongoose");
const Product = require("../models/Product");
const Company = require("../models/Company");
const Checkout = require("../models/Checkout");
const { convertEGPToSAR, getExchangeRate } = require("../utils/currency");

const args = process.argv.slice(2);
const rateArg = args.find((a) => a.startsWith("--rate="));

function fmt(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         التحقق من صحة ودقة نظام الأسعار (EGP / SAR)              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ متصل بقاعدة البيانات\n");

  const company = await Company.findOne().select("egpPerSar nameAr").lean();
  const rate = rateArg
    ? parseFloat(rateArg.split("=")[1])
    : getExchangeRate(company?.egpPerSar);

  console.log(`🏢 الشركة:                ${company?.nameAr || "(غير محددة)"}`);
  console.log(`💱 سعر الصرف في DB:       ${company?.egpPerSar ?? "غير محدد"}`);
  console.log(`💱 سعر الصرف المستخدم:    1 SAR = ${rate} EGP\n`);

  // 1. فحص المنتجات
  console.log("═══════════════════════════════════════");
  console.log("1. فحص المنتجات (Products)");
  console.log("═══════════════════════════════════════");

  const products = await Product.find({}).lean();
  let validProducts = 0;
  let invalidEGP = 0;
  let invalidSAR = 0;
  let invalidSale = 0;
  const issues = [];

  for (const p of products) {
    let hasIssue = false;

    // فحص السعر الأساسي EGP
    if (p.originalPrice == null || typeof p.originalPrice !== "number" || p.originalPrice <= 0 || !isFinite(p.originalPrice)) {
      invalidEGP++;
      hasIssue = true;
      issues.push(`[${p._id}] "${p.name}": originalPrice غير صحيح (${p.originalPrice})`);
    }

    // فحص سعر الخصم
    if (p.salePrice != null) {
      if (typeof p.salePrice !== "number" || p.salePrice < 0 || p.salePrice >= p.originalPrice) {
        invalidSale++;
        hasIssue = true;
        issues.push(`[${p._id}] "${p.name}": salePrice (${p.salePrice}) غير صحيح مقارنة بـ (${p.originalPrice})`);
      }
    }

    // فحص حساب SAR المقابل
    const expectedSAR = convertEGPToSAR(p.originalPrice, rate);
    if (expectedSAR <= 0 || !isFinite(expectedSAR)) {
      invalidSAR++;
      hasIssue = true;
      issues.push(`[${p._id}] "${p.name}": SAR المحسوب غير صحيح (${expectedSAR})`);
    }

    // فحص خيارات الـ Variants إن وُجدت
    if (Array.isArray(p.variants)) {
      for (const v of p.variants) {
        if (Array.isArray(v.storageOptions)) {
          for (const opt of v.storageOptions) {
            if (opt.originalPrice != null && (opt.originalPrice <= 0 || !isFinite(opt.originalPrice))) {
              invalidEGP++;
              hasIssue = true;
              issues.push(`[${p._id}] variant storage option price غير صحيح: ${opt.originalPrice}`);
            }
          }
        }
      }
    }

    if (!hasIssue) validProducts++;
  }

  console.log(`Products checked:          ${products.length}`);
  console.log(`Products migrated (EGP):   ${validProducts}`);
  console.log(`Products with invalid EGP: ${invalidEGP}`);
  console.log(`Products with invalid SAR: ${invalidSAR}`);
  console.log(`Products with invalid Sale:${invalidSale}\n`);

  if (issues.length > 0) {
    console.log("⚠️ تنبيهات المنتجات:");
    issues.slice(0, 5).forEach((i) => console.log(`   ${i}`));
    if (issues.length > 5) console.log(`   ... و ${issues.length - 5} مشاكل أخرى`);
    console.log("");
  }

  // عينة من المنتجات
  console.log("📋 عينة من المنتجات بعد الحساب:");
  console.log("─".repeat(80));
  console.log(
    "الاسم".padEnd(30) +
    "السعر الأساسي EGP".padEnd(20) +
    "سعر الخصم EGP".padEnd(16) +
    "المعادل SAR"
  );
  console.log("─".repeat(80));
  for (const p of products.slice(0, 5)) {
    const sar = convertEGPToSAR(p.salePrice ?? p.originalPrice, rate);
    console.log(
      (p.name || "").slice(0, 28).padEnd(30) +
      fmt(p.originalPrice).padEnd(20) +
      fmt(p.salePrice).padEnd(16) +
      fmt(sar)
    );
  }
  console.log("─".repeat(80) + "\n");

  // 2. فحص الطلبات
  console.log("═══════════════════════════════════════");
  console.log("2. فحص الطلبات (Orders / Checkouts)");
  console.log("═══════════════════════════════════════");

  const orders = await Checkout.find({}).lean();
  let ordersWithSnapshot = 0;
  let ordersMissingSnapshot = 0;

  for (const o of orders) {
    if (o.exchangeRate != null && o.totalEGP != null && o.totalSAR != null) {
      ordersWithSnapshot++;
    } else {
      ordersMissingSnapshot++;
    }
  }

  console.log(`Orders checked:            ${orders.length}`);
  console.log(`Orders with full snapshot: ${ordersWithSnapshot}`);
  console.log(`Orders missing snapshot:   ${ordersMissingSnapshot}\n`);

  // النتيجة النهائية
  const allGood = invalidEGP === 0 && invalidSAR === 0 && ordersMissingSnapshot === 0;
  console.log("═".repeat(60));
  if (allGood) {
    console.log("🎉 جميع البيانات سليمة 100%! نظام الأسعار يعمل بأمان تام.");
  } else {
    console.log("⚠️  يوجد بعض السجلات التي تحتاج مراجعة كما هو موضح أعلاه.");
  }
  console.log("═".repeat(60) + "\n");

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطأ أثناء الفحص:", err);
  mongoose.connection.close().finally(() => process.exit(1));
});
