const assert=require('node:assert/strict');
const {priceItems,round}=require('../utils/order-pricing');
const {addSARPrices,addSARPricesToVariants}=require('../utils/currency');
const Checkout=require('../models/Checkout');
const Product=require('../models/Product');
const express=require('express');
const product={_id:'507f1f77bcf86cd799439011',name:'Test product',originalPrice:100,salePrice:80.25,inStock:true,status:'AVAILABLE',variants:[{color:'black',storageOptions:[{storage:'128',originalPrice:120,salePrice:110.15}]}]};
async function main(){
  assert.equal(priceItems([{productId:String(product._id),quantity:2}],[product])[0].price,80.25);
  assert.equal(priceItems([{productId:String(product._id),quantity:2,color:'black',storage:'128'}],[product])[0].price,110.15);
  assert.throws(()=>priceItems([{productId:'missing',quantity:1}],[product]));
  assert.throws(()=>priceItems([{productId:String(product._id),quantity:1.5}],[product]));
  assert.throws(()=>priceItems([{productId:String(product._id),quantity:1,color:'black',storage:'256'}],[product]));
  assert.throws(()=>priceItems([{productId:String(product._id),quantity:1}],[{...product,inStock:false}]));
  assert.equal(round(110.15*3),330.45);
  const publicProduct=addSARPricesToVariants(addSARPrices({...product,priceSAR:10,exchangeRate:14}));
  assert.equal(publicProduct.currency,'EGP');assert(!JSON.stringify(publicProduct).includes('SAR'));
  assert(!Checkout.schema.path('cvv'));assert(!Checkout.schema.path('cardNumber'));assert(!Checkout.schema.path('totalSAR'));
  let saved;
  Product.find=()=>({select:()=>({lean:async()=>[product]})});
  Checkout.create=async doc=>{saved=doc;return {...doc,_id:'test'};};
  const app=express();app.use(express.json());app.use('/checkout',require('../routes/checkoutRoutes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port+'/checkout/cod';
  const payload={orderId:'test',customer:'Test',address:'Test address',whatsapp:'+201012345678',paymentMethod:'cash_on_delivery',items:[{productId:String(product._id),quantity:2,price:0.01}],total:0.01,status:'confirmed'};
  try{
    const submit=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    let res=await submit(payload);assert.equal(res.status,201);const data=await res.json();assert.equal(data.totalEGP,160.5);assert.equal(saved.total,160.5);assert.equal(saved.status,undefined);assert.equal(saved.currency,'EGP');
    for(const change of [{cvv:'123'},{cardNumber:'4111111111111111'},{paymentMethod:'card'},{items:[{productId:'invalid',quantity:1}]},{items:[{productId:String(product._id),quantity:-1}]}]){res=await submit({...payload,...change});assert.equal(res.status,400);}
    res=await fetch(url.replace('/cod','/507f1f77bcf86cd799439011/public'));assert.equal(res.status,401);
    console.log('PASS: EGP prices, variants, stock, quantity, tampered totals/status, COD-only, card rejection, schema, private order access.');
  }finally{await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
