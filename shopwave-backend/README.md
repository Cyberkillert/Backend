# ShopWave — Backend API

Node.js + Express + Firebase Admin SDK

## Setup

```bash
npm install
cp .env.example .env
# Fill in your Firebase credentials in .env
npm run dev     # development
npm start       # production
```

## Getting Firebase Admin credentials

1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key" → downloads a JSON file
3. Copy values into `.env`:
   - `FIREBASE_PROJECT_ID` = `project_id`
   - `FIREBASE_CLIENT_EMAIL` = `client_email`
   - `FIREBASE_PRIVATE_KEY` = `private_key`

## API Endpoints

### Public
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/products` | List products (query: category, search, limit, minPrice, maxPrice) |
| GET | `/api/products/:id` | Single product |
| GET | `/api/products/:id/reviews` | Product reviews |
| POST | `/api/reports` | Submit report (guest allowed) |
| POST | `/api/coupons/validate` | Validate coupon code |

### Authenticated (any logged-in user)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orders` | My orders |
| GET | `/api/orders/:id` | Order detail |
| POST | `/api/orders/:id/cancel` | Cancel pending order |
| GET | `/api/users/me` | My profile |
| GET | `/api/users/me/addresses` | Saved addresses |
| POST | `/api/users/me/addresses` | Add address |
| DELETE | `/api/users/me/addresses/:id` | Delete address |
| GET | `/api/users/me/wishlist` | Wishlist |
| GET | `/api/users/me/notifications` | Notifications |

### Seller only
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orders/seller/list` | Seller's orders |
| PATCH | `/api/orders/:id/status` | Update order status |
| POST | `/api/products` | Create product |
| PATCH | `/api/products/:id` | Update product |
| DELETE | `/api/products/:id` | Delete product |
| POST | `/api/coupons/seller` | Create seller coupon |

### Admin only
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/dashboard` | Stats overview |
| GET | `/api/admin/sellers` | All sellers |
| PATCH | `/api/admin/sellers/:id` | Approve/reject seller |
| GET | `/api/admin/orders` | All orders |
| PATCH | `/api/admin/orders/:id/status` | Force order status |
| GET | `/api/admin/reports` | All reports |
| PATCH | `/api/admin/reports/:id` | Resolve report |
| DELETE | `/api/admin/reports/:id` | Delete report |
| GET | `/api/admin/users` | All users |
| POST | `/api/admin/notifications` | Broadcast notification |
| GET | `/api/admin/analytics` | Revenue analytics |

## Auth

Send Firebase ID token in every request:
```
Authorization: Bearer <firebase-id-token>
```

Get token in the frontend:
```js
const token = await firebase.auth().currentUser.getIdToken();
```

## Deploy to Railway / Render / Fly.io

1. Push to GitHub
2. Connect repo to Railway/Render
3. Set environment variables from `.env`
4. Deploy — it runs `npm start`

## Push notifications (v3)
The server starts `services/pushWatcher.js`, which pushes new `notifications` documents through Firebase Cloud Messaging. Set `PUSH_WATCHER=off` to disable it (for example when you deploy the Cloud Function in `functions/` instead; run only one sender). Test the sender logic with `npm test`. Frontend setup is in the frontend's `PUSH.md`.
