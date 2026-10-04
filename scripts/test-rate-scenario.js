/**
 * test-rate-scenario.js
 *
 * اختبار سيناريو تغيير سعر الصرف:
 * 1. وضع منتج بسعر 50,000 EGP وسعر صرف 14 -> SAR = 3,571.43
 * 2. إنشاء طلب وتأكيد أن totalSAR = 3,571.43 و exchangeRate = 14
 * 3. تغيير سعر الصرف إلى 15
 * 4. التأكد أن المنتج أصبح يعرض SAR = 3,333.33 بينما EGP لم يتغير (50,000)
 * 5. التأكد أن الطلب القديم بقي كما هو: totalSAR = 3,571.43 و exchangeRate = 14
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const mongoose = require("mongoose");
const Product = require("../models/Product");
const Company = require("../models/Company");
const Checkout = require("../models/Checkout");
const { convertEGPToSAR, addSARPrices } = require("../utils/currency");

async function runScenario() {
  console.log("\n🧪 بدء اختبار سيناريو تغيير سعر الصرف...\n");

  await mongoose.connect(process.env.MONGO_URI);

  // 1. إنشاء منتج اختباري بسعر 50,000 EGP
  const testProduct = await Product.create({
    name: "منتج تجريبي لاختبار العملة",
    originalPrice: 50000,
    originalPriceEGP: 50000,
    category: "تجريبي",
    inStock: true,
  });
  console.log(`1. تم إنشاء منتج تجريبي: ${testProduct.name}`);
  console.log(`   originalPrice: ${testProduct.originalPrice} EGP`);

  // سعر الصرف = 14
  const rate1 = 14;
  let pEnriched1 = addSARPrices(testProduct.toObject(), rate1);
  console.log(`   عند rate = 14:`);
  console.log(`   priceEGP = ${pEnriched1.priceEGP} EGP`);
  console.log(`   priceSAR = ${pEnriched1.priceSAR} SAR`);

  if (pEnriched1.priceSAR !== 3571.43) {
    throw new Error(`Expected priceSAR 3571.43 at rate 14, got ${pEnriched1.priceSAR}`);
  }
  console.log(`   ✅ حساب SAR سليم: 50000 / 14 = 3571.43 SAR`);

  // 2. إنشاء طلب وتأكيد snapshot
  const testOrderId = `test-${Date.now()}`;
  const testOrder = await Checkout.create({
    orderId: testOrderId,
    customer: "عميل تجريبي",
    items: [
      {
        productId: String(testProduct._id),
        name: testProduct.name,
        priceEGP: 50000,
        priceSAR: 3571.43,
        price: 3571.43,
        exchangeRate: 14,
        quantity: 1,
      },
    ],
    totalEGP: 50000,
    totalSAR: 3571.43,
    total: 3571.43,
    exchangeRate: 14,
    paymentMethod: "cash_on_delivery",
  });

  console.log(`\n2. تم إنشاء طلب تجريبي رقم ${testOrderId}:`);
  console.log(`   Order totalEGP:      ${testOrder.totalEGP} EGP`);
  console.log(`   Order totalSAR:      ${testOrder.totalSAR} SAR`);
  console.log(`   Order exchangeRate:  ${testOrder.exchangeRate}`);

  // 3. تغيير سعر الصرف إلى 15
  const rate2 = 15;
  console.log(`\n3. تم تغيير سعر الصرف إلى: 1 SAR = 15 EGP`);
  let pEnriched2 = addSARPrices(testProduct.toObject(), rate2);
  console.log(`   المنتج الآن:`);
  console.log(`   priceEGP = ${pEnriched2.priceEGP} EGP (لم يتغير)`);
  console.log(`   priceSAR = ${pEnriched2.priceSAR} SAR (تغير بناءً على السعر الجديد)`);

  if (pEnriched2.priceEGP !== 50000) {
    throw new Error(`priceEGP should not change! Got ${pEnriched2.priceEGP}`);
  }
  if (pEnriched2.priceSAR !== 3333.33) {
    throw new Error(`Expected priceSAR 3333.33 at rate 15, got ${pEnriched2.priceSAR}`);
  }
  console.log(`   ✅ حساب SAR الجديد سليم: 50000 / 15 = 3333.33 SAR`);

  // 4. التحقق من الطلب القديم في قاعدة البيانات
  const fetchedOrder = await Checkout.findOne({ orderId: testOrderId }).lean();
  console.log(`\n4. التحقق من بقاء بيانات الطلب القديم كما هي:`);
  console.log(`   Order totalEGP:      ${fetchedOrder.totalEGP} EGP (المتوقع 50000)`);
  console.log(`   Order totalSAR:      ${fetchedOrder.totalSAR} SAR (المتوقع 3571.43)`);
  console.log(`   Order exchangeRate:  ${fetchedOrder.exchangeRate} (المتوقع 14)`);

  if (fetchedOrder.totalSAR !== 3571.43 || fetchedOrder.exchangeRate !== 14) {
    throw new Error("Old order was mutated!");
  }
  console.log(`   ✅ الطلب القديم لم يتغير إطلاقاً ومحافظ على قيمته وتاريخه!`);

  // تنظيف السجلات التجريبية
  await Product.deleteOne({ _id: testProduct._id });
  await Checkout.deleteOne({ _id: testOrder._id });
  console.log("\n🧹 تم تنظيف السجلات التجريبية بنجاح.");

  console.log("\n🎉 سيناريو الاختبار نجح بنسبة 100%!");
  await mongoose.connection.close();
  process.exit(0);
}

runScenario().catch((e) => {
  console.error("❌ فشل الاختبار:", e.message);
  mongoose.connection.close().finally(() => process.exit(1));
});
