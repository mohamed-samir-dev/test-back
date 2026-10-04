// One-time, idempotent EGP cutover. Does not print or back up card data.
const fs = require('fs');
const path = require('path');
require('dotenv').config({path:path.join(__dirname,'../.env'),quiet:true});
const mongoose = require('mongoose');
const RATE = 13.9276;
const SOURCE = 'https://www.exchangerates247.com/currency-converter/SAR/EGP/';
const VERSION = 'egp-only-2026-10-04';
const round = n => Math.round((n + Number.EPSILON)*100)/100;
const sensitive = /^(cardNumber|cardHolder|cardHolderName|expiry|expiryDate|expirationDate|cvv|cvc|cvv2|securityCode|cardDetails|cardData|paymentCard|otp|pin)$/i;
function sanitize(value) {
  if(Array.isArray(value)) return value.map(sanitize);
  if(!value || typeof value !== 'object' || value instanceof Date || value instanceof mongoose.Types.ObjectId) return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>!sensitive.test(k)).map(([k,v])=>[k,sanitize(v)]));
}
function forbiddenPaths(value, prefix='') {
  if(!value || typeof value !== 'object' || value instanceof Date || value instanceof mongoose.Types.ObjectId)return [];
  return Object.entries(value).flatMap(([k,v])=>sensitive.test(k)?[prefix+k]:forbiddenPaths(v,prefix+k+'.'));
}
async function main() {
  const apply=process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000,socketTimeoutMS:45000});
  const db=mongoose.connection.db;
  const products=await db.collection('products').find({}).toArray();
  const originals=await db.collection('products_backup_2026_10_04T14_56_21_796Z').find({}).toArray();
  const baseline=new Map(originals.map(p=>[String(p._id),p]));
  const updates=[];
  for(const p of products) {
    if(p.currencyMigration?.version===VERSION)continue;
    const old=baseline.get(String(p._id));
    if(p.migratedToEGP && (!old || Math.round(old.originalPrice*14)!==p.originalPrice || (old.salePrice>0 && Math.round(old.salePrice*14)!==p.salePrice)))throw new Error('Product differs from original migration baseline: '+String(p._id));
    const source=p.migratedToEGP?old:p;
    const next={...p,originalPrice:round(source.originalPrice*RATE),currency:'EGP',migratedToEGP:true,currencyMigration:{version:VERSION,rate:RATE,source:SOURCE,date:'2026-10-04'}};
    next.originalPriceEGP=next.originalPrice;
    if(source.salePrice != null){next.salePrice=round(source.salePrice*RATE);next.salePriceEGP=next.salePrice;}
    next.variants=(p.variants||[]).map((v,index)=>({...v,storageOptions:(v.storageOptions||[]).map((o,j)=>{
      const original=source.variants?.[index]?.storageOptions?.[j];
      if(!original)throw new Error('Variant baseline missing');
      const result={...o};
      for(const key of ['originalPrice','salePrice'])if(original[key]!=null){result[key]=round(original[key]*RATE);result[key+'EGP']=result[key];}
      return result;
    })}));
    if(next.installment){next.installment={...next.installment,available:false};if(source.installment?.downPayment!=null)next.installment.downPayment=round(source.installment.downPayment*RATE);}
    for(const k of Object.keys(next))if(k.endsWith('SAR'))delete next[k];
    updates.push({replaceOne:{filter:{_id:p._id,originalPrice:p.originalPrice,salePrice:p.salePrice},replacement:next}});
  }
  const collections=await db.listCollections().toArray();
  let sensitiveDocuments=0,removedFields=0;
  for(const {name} of collections){
    if(name==='admins')continue;
    for await(const doc of db.collection(name).find({})){
      const paths=forbiddenPaths(doc);if(!paths.length)continue;
      sensitiveDocuments++;removedFields+=paths.length;
      if(apply)await db.collection(name).updateOne({_id:doc._id},{$unset:Object.fromEntries(paths.map(p=>[p,'']))});
    }
  }
  if(apply){
    const dir=path.join(__dirname,'../backups');fs.mkdirSync(dir,{recursive:true});
    // Scrub existing local backups without copying sensitive fields elsewhere.
    for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))){const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(sanitize(JSON.parse(fs.readFileSync(file,'utf8'))),null,2));}
    if(updates.length){
      const backup=path.join(dir,'products-before-egp-only.json');if(!fs.existsSync(backup))fs.writeFileSync(backup,JSON.stringify(sanitize(products),null,2));
      for(let offset=0;offset<updates.length;offset+=5){
        const batch=updates.slice(offset,offset+5);
        const result=await db.collection('products').bulkWrite(batch);
        if(result.matchedCount!==batch.length)throw new Error('Concurrent product change; inspect before retry');
        console.log('Products verified: '+Math.min(offset+5,updates.length)+'/'+updates.length);
      }
    }
    let orderUpdates=0;
    for await(const o of db.collection('checkouts').find({currency:{$ne:'EGP'}})){
      const rate=o.exchangeRate||14;
      const total=o.totalEGP??round((o.totalSAR??o.total??0)*rate);
      const items=(o.items||[]).map(i=>{const clean=sanitize(i);clean.price=clean.priceEGP=i.priceEGP??round((i.priceSAR??i.price??0)*rate);delete clean.priceSAR;delete clean.exchangeRate;return clean;});
      await db.collection('checkouts').updateOne({_id:o._id,currency:{$ne:'EGP'}},{$set:{currency:'EGP',total,totalEGP:total,items,downPayment:round((o.downPayment||0)*rate),monthlyPayment:round((o.monthlyPayment||0)*rate)},$unset:{totalSAR:'',exchangeRate:''}});orderUpdates++;
    }
    await db.collection('companies').updateMany({},{$set:{currencyAr:'جنيه مصري',currencyEn:'EGP',egpPerSar:RATE,paymentMethod:'الدفع عند الاستلام'}});
    await db.collection('cardfieldsettings').updateMany({},{$set:{showExpiryDate:false,showCvv:false}});
    console.log(JSON.stringify({applied:true,productsUpdated:updates.length,ordersUpdated:orderUpdates,sensitiveDocuments,removedFields,rate:RATE,source:SOURCE}));
  }else console.log(JSON.stringify({dryRun:true,productsToUpdate:updates.length,sensitiveDocuments,fieldsToRemove:removedFields,rate:RATE,sample:updates.slice(0,4).map(u=>({name:u.replaceOne.replacement.name,priceEGP:u.replaceOne.replacement.salePrice??u.replaceOne.replacement.originalPrice}))}));
}
main().catch(e=>{console.error(e.message.replace(/mongodb[^\s]+/gi,'[redacted]'));process.exitCode=1}).finally(()=>mongoose.disconnect());
