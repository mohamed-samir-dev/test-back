// Order prices are stored in EGP. Card data is never accepted.

const mongoose = require("mongoose");

const checkoutItemSchema = new mongoose.Schema(
  {
    productId: { type: String, default: "" },
    name:      { type: String, default: "" },
    // السعر الأساسي بالجنيه المصري — source of truth
    priceEGP:  { type: Number, default: 0, min: 0 },
    // السعر المحوّل للريال السعودي وقت الطلب (snapshot)
    // الحقل القديم — محفوظ للتوافق مع البيانات الموجودة
    price:     { type: Number, default: 0, min: 0 },
    quantity:  { type: Number, default: 1, min: 1 },
    color:     { type: String },
    storage:   { type: String },
    image:     { type: String },
  },
  { _id: false }
);

const checkoutSchema = new mongoose.Schema(
  {
    orderId:   { type: String, required: true, unique: true, trim: true, maxlength: 50 },
    customer:  { type: String, trim: true, maxlength: 100 },
    nationalId:{ type: String, trim: true, maxlength: 20 },
    whatsapp:  { type: String, trim: true, maxlength: 20 },
    address:   { type: String, trim: true, maxlength: 300 },


    currency: { type: String, enum: ["EGP"], default: "EGP" },
    items: [checkoutItemSchema],

    // ====== حقول الأسعار الجديدة ======
    // إجمالي الطلب بالجنيه المصري
    totalEGP:    { type: Number, default: 0, min: 0 },
    // الحقل القديم — محفوظ للتوافق مع البيانات الموجودة
    total:       { type: Number, default: 0, min: 0 },

    // ====== حقول التقسيط ======
    installmentType: {
      type: String,
      enum: ["full", "installment"],
      default: "full",
    },
    months:         { type: Number, default: 0, min: 0 },
    downPayment:    { type: Number, default: 0, min: 0 },
    monthlyPayment: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled"],
      default: "pending",
    },
    paymentMethod: {
      type: String,
      default: "cash_on_delivery",
      enum: ["cash_on_delivery"],
    },
  },
  { timestamps: true }
);

// Index لتسريع البحث في الـ admin
checkoutSchema.index({ createdAt: -1 });
checkoutSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Checkout", checkoutSchema);
