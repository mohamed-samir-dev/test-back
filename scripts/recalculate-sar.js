/**
 * recalculate-sar.js
 *
 * سكربت معاينة (preview-only) لإعادة حساب سعر الريال السعودي بسعر صرف مختلف.
 * لا يعدّل قاعدة البيانات — يطبع جدول المقارنة فقط ثم يخرج.
 *
 * الاستخدام:
 *   node scripts/recalculate-sar.js --rate=15
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const mongoose = require("mongoose");
const Product = require("../models/Product");
const Company = require("../models/Company");
const { convertEGPToSAR, getExchangeRate } = require("../utils/currency");

// ─── CLI argument ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const rateArg = args.find((a) => a.startsWith("--rate="));
const newRate = rateArg ? parseFloat(rateArg.split("=")[1]) : null;

if (newRate !== null && (!isFinite(newRate) || newRate <= 0)) {
  console.error("❌ قيمة --rate غير صحيحة. يجب أن تكون رقمًا موجبًا. مثال: --rate=15");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || !isFinite(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtEGP(n) {
  if (n == null || !isFinite(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function diffPct(a, b) {
  if (!a || !isFinite(a) || !isFinite(b)) return "—";
  const d = ((b - a) / a) * 100;
  return (d >= 0 ? "+" : "") + d.toFixed(2) + "%";
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         معاينة إعادة حساب سعر الريال السعودي (preview only)       ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ متصل بقاعدة البيانات\n");

  // سعر الصرف الحالي من DB
  const company = await Company.findOne().select("egpPerSar nameAr").lean();
  const currentRate = getExchangeRate(company?.egpPerSar);
  const previewRate = newRate !== null ? newRate : currentRate;

  console.log(`🏢 الشركة:                  ${company?.nameAr || "(غير محددة)"}`);
  console.log(`💱 سعر الصرف الحالي (DB):  1 SAR = ${currentRate} EGP`);
  console.log(`💱 سعر الصرف المعاين:      1 SAR = ${previewRate} EGP`);
  if (currentRate === previewRate) {
    console.log("   (لم تحدد --rate، لذا المعاينة بنفس السعر الحالي)\n");
  } else {
    console.log("");
  }

  const products = await Product.find({}).lean();

  // ─── Table header ───────────────────────────────────────────────────────────
  const COL = {
    name:       30,
    priceEGP:   12,
    currentSAR: 14,
    newSAR:     14,
    diff:       10,
  };

  const header =
    "الاسم".padEnd(COL.name) +
    "EGP".padEnd(COL.priceEGP) +
    "SAR الحالي".padEnd(COL.currentSAR) +
    `SAR (${previewRate})`.padEnd(COL.newSAR) +
    "الفرق%";

  const separator = "─".repeat(
    COL.name + COL.priceEGP + COL.currentSAR + COL.newSAR + COL.diff
  );

  console.log(separator);
  console.log(header);
  console.log(separator);

  for (const p of products) {
    // السعر المعروض الفعلي: salePrice إن وُجد وإلا originalPrice
    const egp =
      p.salePrice != null && p.salePrice > 0 && p.salePrice < p.originalPrice
        ? p.salePrice
        : p.originalPrice ?? 0;

    const sarCurrent = convertEGPToSAR(egp, currentRate);
    const sarNew     = convertEGPToSAR(egp, previewRate);

    const name = (p.name || "(بدون اسم)").slice(0, COL.name - 2);

    console.log(
      name.padEnd(COL.name) +
      fmtEGP(egp).padEnd(COL.priceEGP) +
      fmt(sarCurrent).padEnd(COL.currentSAR) +
      fmt(sarNew).padEnd(COL.newSAR) +
      diffPct(sarCurrent, sarNew)
    );
  }

  console.log(separator);
  console.log(`\nProducts previewed: ${products.length}`);
  console.log(
    newRate !== null
      ? `\nملاحظة: هذا مجرد معاينة — لم يتم تعديل أي بيانات. لتطبيق سعر الصرف الجديد، عدّله من Admin Settings.\n`
      : `\nملاحظة: استخدم --rate=<رقم> لمعاينة تأثير سعر صرف مختلف.\n`
  );

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطأ أثناء التنفيذ:", err);
  mongoose.connection.close().finally(() => process.exit(1));
});
