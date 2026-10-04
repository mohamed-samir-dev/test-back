const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    comment: { type: String, required: true, trim: true, maxlength: 2000 },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 5,
      validate: {
        validator: Number.isInteger,
        message: "التقييم يجب أن يكون عدداً صحيحاً",
      },
    },
    gender: { type: String, enum: ["male", "female"], default: "male" },
    approved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Public endpoint filters on approved=true and sorts by createdAt desc.
reviewSchema.index({ approved: 1, createdAt: -1 });
// Admin endpoint sorts all reviews by createdAt desc without filtering by approved
reviewSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Review", reviewSchema);
