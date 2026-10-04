const mongoose = require("mongoose");

const bannerItemSchema = new mongoose.Schema(
  { url: { type: String, trim: true, default: "" }, active: { type: Boolean, default: true } },
  { _id: false }
);

const bannerSchema = new mongoose.Schema({
  banners: {
    type: [bannerItemSchema],
    default: () => Array.from({ length: 5 }, () => ({ url: "", active: true })),
    validate: [(val) => Array.isArray(val) && val.length <= 10, "الحد الأقصى للبانرات هو 10"],
  },
}, { timestamps: true });

module.exports = mongoose.model("Banner", bannerSchema);
