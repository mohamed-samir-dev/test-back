const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  { url: { type: String, trim: true, default: "" }, active: { type: Boolean, default: true } },
  { _id: false }
);

const categoryBannerSchema = new mongoose.Schema({
  category: { type: String, required: true, unique: true, trim: true },
  banners: {
    type: [itemSchema],
    default: () => [{ url: "", active: true }],
    validate: [(val) => Array.isArray(val) && val.length <= 10, "الحد الأقصى للبانرات هو 10"],
  },
}, { timestamps: true });

module.exports = mongoose.model("CategoryBanner", categoryBannerSchema);
