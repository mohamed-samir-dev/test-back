# Backend — توثيق شامل

## نظرة عامة

باك إند مبني بـ **Node.js + Express + MongoDB (Mongoose)**، يخدم متجر إلكتروني لبيع الجوالات.  
يتضمن نظام مصادقة للأدمن، إدارة منتجات، طلبات، بانرات، تقييمات، وإعدادات الشركة.

---

## التقنيات المستخدمة

| الحزمة | الغرض |
|---|---|
| express | إطار العمل الرئيسي |
| mongoose | التواصل مع MongoDB |
| jsonwebtoken | مصادقة JWT |
| bcryptjs | تشفير كلمات المرور |
| cloudinary | رفع وحذف الصور/الملفات |
| multer | استقبال الملفات من الفورم |
| cookie-parser | قراءة الكوكيز |
| cors | السماح للفرونت إند بالوصول |
| dotenv | متغيرات البيئة |

---

## متغيرات البيئة `.env`

```
MONGO_URI=               # رابط قاعدة البيانات MongoDB Atlas
JWT_SECRET=              # مفتاح سري قوي لتوقيع JWT (غيّره في الإنتاج!)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
FRONTEND_URL=            # رابط الفرونت (يقبل أكثر من رابط مفصول بفاصلة)
PORT=5000
NODE_ENV=production      # أو development
```

---

## تشغيل المشروع

```bash
npm install
npm run dev     # تطوير (nodemon)
npm start       # إنتاج
```

---

## هيكل الملفات

```
backend/
├── config/
│   ├── db.js               # الاتصال بـ MongoDB (connection pool + event handlers)
│   └── cloudinary.js       # إعداد Cloudinary + multer singletons
├── controllers/
│   └── productController.js
├── middleware/
│   └── auth.js             # authMiddleware المشترك
├── models/
│   ├── Admin.js
│   ├── Banner.js
│   ├── CardFieldSettings.js
│   ├── CategoryBanner.js
│   ├── Checkout.js
│   ├── Company.js
│   ├── MainCategory.js
│   ├── Product.js
│   ├── Review.js
│   ├── SubCategory.js
│   └── SubCategorySettings.js
├── routes/
│   ├── adminRoutes.js      # ~1600 سطر — كل endpoints الأدمن
│   ├── checkoutRoutes.js   # طلبات الشراء
│   └── productRoutes.js    # قائمة وتفاصيل المنتجات (public)
├── seed-admin.js           # إنشاء حساب أدمن (يستخدم env vars)
├── seed-from-file.js       # رفع منتجات من new-products.js
├── seed-products.js        # بيانات منتجات sample
└── server.js               # نقطة الدخول
```

---

## ملفات Config

### `config/db.js`
- يتصل بـ MongoDB عبر `MONGO_URI`.
- يضبط `maxPoolSize: 10` لتجنب استنزاف connections على Atlas.
- يطبع تحذيراً إذا كان `JWT_SECRET` هو القيمة الافتراضية.
- يُسجّل أحداث `disconnected` و `error` للـ debugging.

### `config/cloudinary.js`
- يضبط إعدادات Cloudinary من متغيرات البيئة.
- `makeImageUpload()` — singleton multer للصور بحد 5MB.
- `makeFileUpload()` — singleton multer للملفات بحد 20MB.
- `uploadToCloudinary(buffer, folder, options)` — يرفع من الذاكرة مباشرة لـ Cloudinary عبر stream.
- `deleteFromCloudinary(url, resource_type)` — يحذف من Cloudinary باستخراج public_id من الرابط.

### `middleware/auth.js`
- `authMiddleware` — يتحقق من `admin_token` cookie ويُرفق payload على `req.admin`.
- مُشترك بين `adminRoutes.js` و `checkoutRoutes.js`.

---

## Models (نماذج قاعدة البيانات)

### `Admin.js`
| الحقل | النوع | الوصف |
|---|---|---|
| name | String | الاسم |
| phone | String | رقم الهاتف |
| email | String | البريد (unique) |
| password | String | مشفر تلقائياً بـ bcrypt (12 rounds) |
| loginAttempts | Number | عدد محاولات الدخول الفاشلة (متاح للتفعيل) |
| lockUntil | Date | وقت انتهاء القفل (متاح للتفعيل) |

- **Pre-save hook**: يشفر الباسورد تلقائياً عند التعديل.
- **comparePassword(plain)**: يقارن الباسورد المدخل بالمشفر.

---

### `Product.js`
**Indexes:**
- `{ createdAt: -1 }` — ترتيب القوائم
- `{ category: 1, inStock: 1 }` — صفحات التصنيف
- `{ brand: 1, inStock: 1 }` — فلترة الماركة
- `{ category: 1, brand: 1 }` — فلترة مركّبة
- `{ subCategory: 1 }` — التصنيف الفرعي
- `text` على `name, category, subCategory, brand` — البحث النصي

**Virtuals:**
- `discountPercent` — نسبة الخصم.
- `price` — `salePrice` أو `originalPrice`.

---

### `Checkout.js`
**Index:** `{ createdAt: -1 }` لدعم pagination الطلبات.

---

### `Review.js`
**Index:** `{ approved: 1, createdAt: -1 }` للـ endpoint العام الذي يفلتر على `approved=true`.

---

### `SubCategorySettings.js`
**Index:** مركّب unique على `(category, subCategory)`.

---

## Caching (In-process TTL)

`adminRoutes.js` يحتوي على cache خفيف في الذاكرة بـ TTL 60 ثانية للـ endpoints العامة كثيفة الاستخدام:

| Cache Key | Endpoint | TTL |
|---|---|---|
| `company` | GET /company | 60s |
| `banners` | GET /banners | 60s |
| `subCategoriesPublic` | GET /sub-categories/public | 60s |
| `homeSettings` | GET /sub-categories/home-settings | 60s |
| `subCategoriesMax` | GET /sub-categories/max | 300s |
| `reviews` | GET /reviews | 60s |
| `cardFieldSettings` | GET /card-field-settings | 300s |
| `catBannersBulk:*` | GET /category-banners-bulk | 60s |

كل mutation endpoint يستدعي `invalidateCache(key)` تلقائياً.

---

## Routes

### `routes/productRoutes.js` — `/api/products`

| Method | Path | الوصف |
|---|---|---|
| GET | `/api/products` | جلب المنتجات (يقبل `?q=`, `?brand=`, `?category=`, `?limit=`) |
| POST | `/api/products` | إنشاء منتج |
| GET | `/api/products/:id` | جلب منتج واحد (lean + projection) |
| PUT | `/api/products/:id` | تحديث منتج |
| DELETE | `/api/products/:id` | حذف منتج |

---

### `routes/checkoutRoutes.js` — `/api/checkout`

| Method | Path | Auth | الوصف |
|---|---|---|---|
| GET | `/api/checkout/csrf-token` | لا | الحصول على CSRF token |
| POST | `/api/checkout` | لا | إنشاء طلب (مع validation شامل) |
| GET | `/api/checkout` | أدمن | جلب الطلبات (paginated) |
| GET | `/api/checkout/:id/public` | لا | جلب طلب للفاتورة (بدون بيانات بطاقة) |
| GET | `/api/checkout/:id` | أدمن | جلب طلب كامل |
| PUT | `/api/checkout/:id/status` | أدمن + CSRF | تحديث الحالة |
| PUT | `/api/checkout/:id/financials` | أدمن + CSRF | تحديث البيانات المالية |
| DELETE | `/api/checkout/:id` | أدمن + CSRF | حذف طلب |

---

### `routes/adminRoutes.js` — `/api/admin`

#### المصادقة
| Method | Path | الوصف |
|---|---|---|
| POST | `/api/admin/login` | تسجيل دخول — JWT في HttpOnly Cookie (8h) |
| POST | `/api/admin/logout` | تسجيل خروج |
| GET | `/api/admin/verify` | التحقق من صلاحية التوكن |

#### إدارة المستخدمين
| Method | Path | Auth |
|---|---|---|
| GET/POST | `/api/admin/users` | أدمن |
| PUT/DELETE | `/api/admin/users/:id` | أدمن |

#### إعدادات الشركة (cached)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/company` | لا (cached) |
| PUT | `/api/admin/company` | أدمن |
| POST | `/api/admin/company/upload/:field` | أدمن |
| POST | `/api/admin/company/footer-image/:key` | أدمن |
| POST | `/api/admin/company/footer-file/:key` | أدمن |
| DELETE | `/api/admin/company/image/:field` | أدمن |
| POST/DELETE | `/api/admin/company/footer-items/*` | أدمن |

#### البانرات (cached)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/banners` | لا (cached) |
| POST | `/api/admin/banners/upload/:index` | أدمن |
| PATCH | `/api/admin/banners/toggle/:index` | أدمن |
| POST | `/api/admin/banners/add` | أدمن |
| PATCH | `/api/admin/banners/reorder` | أدمن |
| DELETE | `/api/admin/banners/:index/image` | أدمن |
| DELETE | `/api/admin/banners/:index` | أدمن |

#### التصنيفات
- `GET /api/admin/main-categories` — أدمن
- `GET /api/admin/main-categories/extra` — أدمن
- `POST /api/admin/main-categories` — أدمن
- `PUT /api/admin/main-categories/rename` — أدمن
- `DELETE /api/admin/main-categories/remove` — أدمن
- `GET /api/admin/sub-categories/public` — **لا** (cached)
- `GET /api/admin/sub-categories/home-settings` — **لا** (cached)
- `GET /api/admin/sub-categories/max` — **لا** (cached 5m)
- `PATCH /api/admin/sub-categories/max` — أدمن
- `GET /api/admin/sub-categories/settings` — أدمن
- `PATCH /api/admin/sub-categories/settings/toggle` — أدمن
- `PATCH /api/admin/sub-categories/settings/order` — أدمن
- `POST /api/admin/sub-categories/image/:category` — أدمن

#### الطلبات (paginated)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/orders?page=&limit=` | لا |
| GET | `/api/admin/orders/:id` | لا |
| PUT | `/api/admin/orders/:id/status` | أدمن |
| DELETE | `/api/admin/orders/:id` | أدمن |

#### التقييمات (public cached)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/reviews` | لا (cached) |
| GET | `/api/admin/reviews/all?page=&limit=` | أدمن (paginated) |
| POST | `/api/admin/reviews` | لا |
| POST | `/api/admin/reviews/admin-add` | أدمن |
| PUT | `/api/admin/reviews/:id` | أدمن |
| PATCH | `/api/admin/reviews/:id/approve` | أدمن |
| PATCH | `/api/admin/reviews/:id/toggle` | أدمن |
| DELETE | `/api/admin/reviews/:id` | أدمن |

#### المنتجات (admin CRUD)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/products` | أدمن |
| GET | `/api/admin/products/:id` | أدمن |
| POST | `/api/admin/products` | أدمن (multipart) |
| PUT | `/api/admin/products/:id` | أدمن (multipart) |
| DELETE | `/api/admin/products/:id` | أدمن |


#### بانرات التصنيفات (cached)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/category-banners-bulk` | لا (cached) |
| GET | `/api/admin/category-banners/:category` | لا (cached) |
| POST/PATCH/DELETE | `/api/admin/category-banners/:category/*` | أدمن |

#### إعدادات حقول البطاقة (cached)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/admin/card-field-settings` | لا (cached 5m) |
| PATCH | `/api/admin/card-field-settings` | أدمن |

---

## ملاحظات أمنية

- كلمات المرور مشفرة بـ bcrypt (12 rounds).
- JWT مخزن في HttpOnly Cookie (لا يمكن الوصول إليه من JavaScript).
- Cookie مضبوط على `secure: true` و `sameSite: none` في الإنتاج.
- CSRF protection على mutation endpoints في checkoutRoutes (double-submit cookie).
- التحقق من نوع الحقول المسموح برفعها (Set-based whitelist) قبل أي عملية رفع.
- Validation شامل على checkout body (orderId, cardNumber, expiry, cvv, items, total).
- **تنبيه:** غيّر `JWT_SECRET` في `.env` قبل النشر الإنتاجي.

---

## ملفات Seed (لمرة واحدة — مدرجة في .gitignore)

```bash
# إنشاء حساب أدمن (يستخدم متغيرات البيئة)
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=StrongPass123 node seed-admin.js

# رفع منتجات من ملف مخصص
# أنشئ new-products.js أولاً ثم شغّل:
node seed-from-file.js
```
