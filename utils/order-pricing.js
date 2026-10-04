"use strict";
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
function priceItems(items, products) {
  const byId = new Map(products.map(p => [String(p._id), p]));
  return items.map(item => {
    const product = byId.get(item.productId);
    if (!product || product.inStock === false || product.purchasable === false || (product.status && product.status !== 'AVAILABLE')) throw new Error('المنتج غير متاح للشراء');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new Error('الكمية غير صالحة');
    let option = product;
    const variants = product.variants || [];
    if (variants.length && (item.storage || item.color)) {
      const matches = variants.filter(v => !item.color || v.color === item.color || v.name === item.color);
      if (!matches.length) throw new Error('اللون المحدد غير متاح');
      if (item.storage) {
        const options = matches.flatMap(v => v.storageOptions || []).filter(o => o.storage === item.storage);
        if (!options.length) throw new Error('السعة المحددة غير متاحة');
        if (new Set(options.map(o=>o.salePrice ?? o.originalPrice)).size > 1) throw new Error('يرجى اختيار لون المنتج');
        option = options[0];
      }
    }
    const price = option.salePrice != null && option.salePrice > 0 && option.salePrice < option.originalPrice ? option.salePrice : option.originalPrice;
    if (!Number.isFinite(price) || price <= 0) throw new Error('سعر المنتج غير صالح');
    return { productId: item.productId, name: product.name, quantity: item.quantity, color: item.color, storage: item.storage, price: round(price), priceEGP: round(price) };
  });
}
module.exports = { priceItems, round };
