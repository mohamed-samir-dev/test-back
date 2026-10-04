require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('./models/Product');
const SubCategorySettings = require('./models/SubCategorySettings');
const Banner = require('./models/Banner');
const Company = require('./models/Company');
const CategoryBanner = require('./models/CategoryBanner');
const Review = require('./models/Review');

async function benchmark() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('--- MongoDB Queries Benchmark ---');
  
  // 1. Products query currently used by /api/products
  let t0 = performance.now();
  const LIST_FIELDS = 'name originalPrice salePrice image images color storage network freeDelivery deliveryTime warrantyYears inStock status purchasable category subCategory brand';
  const prods = await Product.find({})
    .select(LIST_FIELDS)
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();
  let tProds = performance.now() - t0;
  console.log(`Product.find(500): ${prods.length} products in ${tProds.toFixed(1)}ms | JSON size: ${(JSON.stringify(prods).length/1024).toFixed(1)} KB`);

  // 2. subCategoriesPublic aggregate
  t0 = performance.now();
  const agg = await Product.aggregate([
    { $match: { category: { $ne: null, $exists: true }, image: { $ne: '', $exists: true } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$category', count: { $sum: 1 }, image: { $first: '$image' } } },
  ]);
  let tAgg = performance.now() - t0;
  console.log(`Category aggregate: ${agg.length} categories in ${tAgg.toFixed(1)}ms`);

  // 3. SubCategorySettings
  t0 = performance.now();
  const settings = await SubCategorySettings.find({ category: { $ne: '__config__' } }).sort({ order: 1 }).lean();
  let tSet = performance.now() - t0;
  console.log(`SubCategorySettings.find: ${settings.length} settings in ${tSet.toFixed(1)}ms`);

  // 4. CategoryBanner
  t0 = performance.now();
  const catBanners = await CategoryBanner.find({}).lean();
  let tCatB = performance.now() - t0;
  console.log(`CategoryBanner.find: ${catBanners.length} docs in ${tCatB.toFixed(1)}ms | JSON size: ${(JSON.stringify(catBanners).length/1024).toFixed(1)} KB`);

  // 5. Reviews
  t0 = performance.now();
  const revs = await Review.find({ approved: true }).sort({ createdAt: -1 }).limit(50).select('name comment rating gender createdAt').lean();
  let tRev = performance.now() - t0;
  console.log(`Reviews.find: ${revs.length} reviews in ${tRev.toFixed(1)}ms`);

  await mongoose.disconnect();
}
benchmark().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
