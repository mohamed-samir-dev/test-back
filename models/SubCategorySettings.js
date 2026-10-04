const mongoose = require("mongoose");

const subCategorySettingsSchema = new mongoose.Schema({
  category: { type: String, required: true, trim: true },
  subCategory: { type: String, required: true, trim: true },
  showInHome: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  image: { type: String, default: "" },
}, { timestamps: true });

subCategorySettingsSchema.index({ category: 1, subCategory: 1 }, { unique: true });
// Supports the public home-settings endpoint: find where category != "__config__", sort by order.
subCategorySettingsSchema.index({ category: 1, order: 1 });
// Supports the public sub-categories/public endpoint: find where image != "" and subCategory != "__max__".
subCategorySettingsSchema.index({ image: 1, subCategory: 1 });

module.exports = mongoose.model("SubCategorySettings", subCategorySettingsSchema);
