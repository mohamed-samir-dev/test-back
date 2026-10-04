const fs=require('fs');
const path=require('path');
const assert=require('node:assert/strict');
const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'../backups/backup-before-egp-migration-2026-10-04T14-56-21-796Z.json'),'utf8')).products;
const rate=13.9276;
const convert=n=>Math.round((n*rate+Number.EPSILON)*100)/100;
async function main(){
  const results=[];let checks=0;
  for(let i=0;i<baseline.length;i+=6){
    await Promise.all(baseline.slice(i,i+6).map(async old=>{
      const response=await fetch('http://localhost:5000/api/products/'+old._id);
      assert(response.ok);
      const p=await response.json();
      assert.equal(p.originalPrice,convert(old.originalPrice));checks++;
      if(old.salePrice>0 && old.salePrice<old.originalPrice){assert.equal(p.salePrice,convert(old.salePrice));checks++;}
      for(let vi=0;vi<(old.variants||[]).length;vi++)for(let oi=0;oi<(old.variants[vi].storageOptions||[]).length;oi++){
        const original=old.variants[vi].storageOptions[oi],current=p.variants[vi].storageOptions[oi];
        if(original.originalPrice!=null){assert.equal(current.originalPrice,convert(original.originalPrice));checks++;}
        if(original.salePrice>0 && original.salePrice<original.originalPrice){assert.equal(current.salePrice,convert(original.salePrice));checks++;}
      }
      results.push({name:p.name,egp:p.priceEGP,sar:Math.round(p.priceEGP/rate*100)/100});
    }));
  }
  let sensitiveFields=0;
  function scan(v){if(v&&typeof v==='object')for(const [k,value] of Object.entries(v)){if(/^(cardNumber|cardHolder|cardHolderName|expiry|expiryDate|cvv|cvc)$/i.test(k))sensitiveFields++;scan(value);}}
  for(const file of fs.readdirSync(path.join(__dirname,'../backups')).filter(f=>f.endsWith('.json')))scan(JSON.parse(fs.readFileSync(path.join(__dirname,'../backups',file),'utf8')));
  assert.equal(sensitiveFields,0);
  const fmt=n=>n.toLocaleString('en-US',{maximumFractionDigits:2});
  const lines=['# أسعار المنتجات بعد التحويل','',`سعر التحويل: 1 ريال سعودي = ${rate} جنيه مصري. الجنيه هو العملة الأساسية للطلب، والريال للعرض المقابل.`, '', '| المنتج | الجنيه المصري | المقابل بالريال |','|---|---:|---:|',...results.map(r=>`| ${r.name.replaceAll('|','/')} | ${fmt(r.egp)} | ${fmt(r.sar)} |`)];
  fs.writeFileSync(path.join(__dirname,'../../price-report.md'),lines.join('\n'));
  console.log(JSON.stringify({verifiedProducts:results.length,priceChecks:checks,localBackupCardFields:sensitiveFields,sample:results.slice(0,4)}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
