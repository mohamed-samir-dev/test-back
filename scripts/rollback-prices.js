/**
 * rollback-prices.js
 *
 * استرجاع البيانات السابقة من النسخة الاحتياطية (Rollback).
 *
 * الاستخدام:
 *   node scripts/rollback-prices.js [--file=path/to/backup.json]
 */

"use strict";

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const mongoose = require("mongoose");
const Product = require("../models/Product");
const Checkout = require("../models/Checkout");

const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith("--file="));

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                 Rollback: استرجاع النسخة الاحتياطية              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const backupDir = path.join(__dirname, "../backups");
  let targetFile = fileArg ? fileArg.split("=")[1] : null;

  if (!targetFile) {
    if (!fs.existsSync(backupDir)) {
      console.error("❌ مجلد النسخ الاحتياطية غير موجود");
      process.exit(1);
    }
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith(".json")).sort().reverse();
    if (files.length === 0) {
      console.error("❌ لا توجد ملفات نسخ احتياطية لاسترجاعها");
      process.exit(1);
    }
    targetFile = path.join(backupDir, files[0]);
  }

  console.log(`📂 جاري القراءة من: ${targetFile}`);
  const data = JSON.parse(fs.readFileSync(targetFile, "utf-8"));

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ متصل بـ MongoDB\n");

  if (Array.isArray(data.products) && data.products.length > 0) {
    console.log(`🔄 جاري استرجاع ${data.products.length} منتج...`);
    for (const p of data.products) {
      await Product.updateOne(
        { _id: p._id },
        {
          $set: {
            originalPrice: p.originalPrice,
            salePrice: p.salePrice,
            variants: p.variants,
          },
          $unset: {
            originalPriceEGP: "",
            salePriceEGP: "",
            migratedToEGP: "",
          },
        }
      );
    }
    console.log("✅ تم استرجاع المنتجات بنجاح.");
  }

  if (Array.isArray(data.orders) && data.orders.length > 0) {
    console.log(`🔄 جاري استرجاع ${data.orders.length} طلب...`);
    for (const o of data.orders) {
      await Checkout.updateOne(
        { _id: o._id },
        {
          $set: {
            total: o.total,
            items: o.items,
          },
          $unset: {
            totalEGP: "",
            totalSAR: "",
            exchangeRate: "",
          },
        }
      );
    }
    console.log("✅ تم استرجاع الطلبات بنجاح.");
  }

  console.log("\n🎉 اكتمل الـ Rollback بنجاح!");
  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطأ أثناء الـ Rollback:", err.message);
  mongoose.connection.close().finally(() => process.exit(1));
});
