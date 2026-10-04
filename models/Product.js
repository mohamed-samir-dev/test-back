const mongoose = require("mongoose");

const SECTION_TYPES = [
  "design", "colors", "camera", "zoom", "low_light", "front_camera",
  "video", "performance", "cooling", "battery", "software", "ai",
  "safety", "accessories", "comparison", "custom",
];

const mediaSub = new mongoose.Schema({
  type:       { type: String, enum: ["image", "video", "poster"], default: "image" },
  url:        { type: String, required: true },
  urlMobile:  String,
  poster:     String,
  alt:        String,
  title:      String,
  sortOrder:  { type: Number, default: 0 },
}, { _id: true });

const sectionSub = new mongoose.Schema({
  type:        { type: String, required: true, enum: [...SECTION_TYPES, "custom"] },
  title:       String,
  subtitle:    String,
  description: String,
  content:     { type: mongoose.Schema.Types.Mixed, default: {} },
  media:       [mediaSub],
  sortOrder:   { type: Number, default: 0 },
  isActive:    { type: Boolean, default: true },
}, { _id: true });

const storageOptionSubSchema = new mongoose.Schema(
  {
    storage: String,
    ram: String,
    gpu: String,
    chip: String,
    size: String,
    originalPrice: { type: Number, min: 0 },
    salePrice: { type: Number, min: 0 },
    originalPriceEGP: { type: Number, min: 0 },
    salePriceEGP: { type: Number, min: 0 },
  },
  { _id: false }
);

const variantSubSchema = new mongoose.Schema(
  {
    name: String,
    color: String,
    colorCode: String,
    defaultStorage: String,
    images: [String],
    storageOptions: [storageOptionSubSchema],
  },
  { _id: false }
);

const specItemSubSchema = new mongoose.Schema(
  { key: String, value: String },
  { _id: false }
);

const specGroupSubSchema = new mongoose.Schema(
  {
    group: { type: String, required: true },
    items: [specItemSubSchema],
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    currency: { type: String, enum: ["EGP"], default: "EGP" },
    name:          { type: String, required: true, trim: true, maxlength: 250 },
    brief:         { type: String, trim: true },
    originalPrice: { type: Number, required: true, min: [0, "السعر لا يمكن أن يكون سالباً"] },
    salePrice:     { type: Number, min: [0, "سعر التخفيض لا يمكن أن يكون سالباً"] },
    originalPriceEGP: { type: Number, min: [0, "السعر لا يمكن أن يكون سالباً"] },
    salePriceEGP:     { type: Number, min: [0, "سعر التخفيض لا يمكن أن يكون سالباً"] },
    migratedToEGP:    { type: Boolean, default: true },
    description:   { type: String },
    image:         { type: String },
    images:        [{ type: String }],
    variants:      [variantSubSchema],
    color:         { type: String },
    storage:       { type: String },
    network:       { type: String },
    screenSize:    { type: String },
    overview:      { type: String },
    overviewImage: { type: String },
    specs: {
      screen:      String,
      processor:   String,
      ram:         String,
      storage:     String,
      rearCamera:  String,
      frontCamera: String,
      battery:     String,
      batteryLife: String,
      charging:    String,
      os:          String,
      extras:      String,
    },
    specGroups: [specGroupSubSchema],
    features: {
      screenAndDesign: [String],
      performance: [String],
      battery: [String],
      frontCamera: [String],
      rearCamera: [String],
      videoAndPhotography: [String],
    },
    detailedSpecs: {
      memoryType: String,
      simCount: String,
      ram: String,
      internalStorage: String,
      edition: String,
      colorName: String,
      os: String,
      processorName: String,
      mainCameraFeature: String,
      audioJack: String,
      voiceDialing: String,
      fastCharging: String,
      modelName: String,
      secondaryCameraResolution: String,
      batterySize: String,
      screenSize: String,
      simType: String,
      chargingType: String,
      condition: String,
      coreCount: String,
      flash: String,
      networkType: String,
      processorNumber: String,
      modelNumber: String,
      mainCamera: String,
    },
    sections:     [sectionSub],
    freeDelivery: { type: Boolean, default: true },
    deliveryTime: { type: String, default: "24 ساعة", trim: true },
    warrantyYears: { type: Number, default: 2, min: 0 },
    installment: {
      available:  { type: Boolean, default: false },
      downPayment: { type: Number, min: 0 },
      note:        String,
      months:      { type: Number, min: 0 },
      conditions:  [String],
      policy:      String,
    },
    taxIncluded:  { type: Boolean, default: true },
    category:     { type: String, trim: true },
    subCategory:  { type: String, trim: true },
    brand:        { type: String, trim: true },
    inStock:      { type: Boolean, default: true },
    status: {
      type:    String,
      enum:    ["PRE_LAUNCH", "AVAILABLE", "OUT_OF_STOCK"],
      default: "AVAILABLE",
    },
    purchasable: { type: Boolean, default: true },
    hideDetails: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    // Enable virtuals in toJSON so that res.json(hydratedDoc) includes
    // discountPercent and price automatically.  lean() results still need
    // addDiscount() from productController since lean() bypasses toJSON.
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound indexes — each covers its prefix columns too, so standalone
// single-field indexes are not needed separately.
productSchema.index({ category: 1, createdAt: -1 });
productSchema.index({ category: 1, createdAt: 1 });
productSchema.index({ brand: 1, createdAt: -1 });
productSchema.index({ brand: 1, createdAt: 1 });
productSchema.index({ createdAt: -1 });
productSchema.index({ category: 1, inStock: 1 });
productSchema.index({ brand: 1, inStock: 1 });
productSchema.index({ category: 1, brand: 1 });
productSchema.index({ subCategory: 1 });
productSchema.index({ name: "text", category: "text", subCategory: "text", brand: "text" });

productSchema.virtual("discountPercent").get(function () {
  if (this.salePrice != null && this.salePrice !== this.originalPrice && this.originalPrice > 0) {
    return Math.round(((this.originalPrice - this.salePrice) / this.originalPrice) * 100);
  }
  return 0;
});

productSchema.virtual("price").get(function () {
  return this.salePrice || this.originalPrice;
});

productSchema.virtual("priceEGP").get(function () {
  return this.salePrice || this.originalPrice;
});

productSchema.virtual("originalPriceEGPVal").get(function () {
  return this.originalPriceEGP != null ? this.originalPriceEGP : this.originalPrice;
});

productSchema.virtual("salePriceEGPVal").get(function () {
  return this.salePriceEGP != null ? this.salePriceEGP : this.salePrice;
});

// Synchronize originalPriceEGP / salePriceEGP with originalPrice / salePrice
productSchema.pre("save", function () {
  if (this.originalPrice != null) {
    this.originalPriceEGP = this.originalPrice;
  }
  if (this.salePrice != null) {
    this.salePriceEGP = this.salePrice;
  }
});

module.exports = mongoose.model("Product", productSchema);
