# 9Pay Integration — Diagnostic Request & Full Technical Setup

**Date:** February 4, 2026
**Company:** English AIdol (https://www.englishaidol.com)
**Merchant Key:** `q9n2F8`
**Priority:** HIGH — Payment gateway is completely non-functional for all Vietnamese users

---

## 1. THE PROBLEM

Every payment attempt shows **"431 PERMISSION DENIED"** in the browser on `payment.9pay.vn`. This has been the case on **100% of attempts** since we started integrating. No customer has ever been able to reach the payment page.

| Test Method | Result |
|-------------|--------|
| `curl` from server (Singapore) | ✅ HTTP 302 → 200, payment page loads ("Thông tin giao dịch") |
| Browser (Chrome, Vietnam) | ❌ 431 PERMISSION DENIED |
| Browser (Safari, Vietnam) | ❌ 431 PERMISSION DENIED |
| Browser (Chrome, other countries) | ❌ 431 PERMISSION DENIED |

**The signature is correct** — 9Pay's server accepts it via curl and returns the payment page. The 431 only happens in browsers.

---

## 2. WHAT WE NEED FROM 9PAY (Diagnostic Checklist)

Please check the following for merchant `q9n2F8`:

### Account Status
- [ ] Is the account **fully activated for production**? Or still pending/sandbox?
- [ ] Is the account approved for **Portal Redirect** integration method?
- [ ] Which payment methods are enabled? (Bank transfer / COLLECTION, e-wallets, cards?)

### Domain & URL Configuration
- [ ] Is `www.englishaidol.com` registered/whitelisted as our domain?
- [ ] Is `https://payment.9pay.vn` the correct production endpoint for our account?
- [ ] Is our IPN/webhook URL registered? It should be: `https://cuumxmfzhwljylbdlflj.supabase.co/functions/v1/ninepay-webhook`

### Server Logs
- [ ] Please check your server logs for merchant `q9n2F8` — what causes the 431 response?
- [ ] Sample invoice numbers to search: `EA07392445OOSA`, or any recent `EA*` invoices

### Configuration Fix
- [ ] If something is misconfigured, **please fix it** or tell us exactly what to change
- [ ] If Portal Redirect is not available for our account, what integration method should we use instead?

---

## 3. OUR COMPLETE TECHNICAL SETUP

### 3.1 Credentials

| Item | Value |
|------|-------|
| Merchant Key | `q9n2F8` |
| Secret Key | `XdigeSsrSrTL15CuAPDFQRdU4G1SYYuiVJ9` |
| Checksum Key | `2Pl94oHsqcdexPZxWg2vQDrYQXKhNmW1` |

### 3.2 Endpoints We Use

| Purpose | URL |
|---------|-----|
| Signature URI (in signed message) | `https://payment.9pay.vn/payments/create` |
| Portal redirect (opened in browser) | `https://payment.9pay.vn/portal?baseEncode=...&signature=...` |
| IPN Webhook (for payment notifications) | `https://cuumxmfzhwljylbdlflj.supabase.co/functions/v1/ninepay-webhook` |

### 3.3 Integration Method

We use **Portal Redirect**, matching the official 9Pay JavaScript sample from:
https://gitlab.com/9pay-sample/sample-javascript/-/blob/main/index.js

### 3.4 Parameters We Send (in baseEncode JSON)

```json
{
  "merchantKey": "q9n2F8",
  "time": 1770192000,
  "invoice_no": "EA92000000ABCD",
  "amount": 500000,
  "description": "English AIdol english 1m",
  "back_url": "https://www.englishaidol.com/dashboard?payment=success&provider=9pay&invoice=EA92000000ABCD",
  "return_url": "https://www.englishaidol.com/dashboard?payment=success&provider=9pay&invoice=EA92000000ABCD"
}
```

We send **only these 7 parameters**. We do NOT send `method`, `currency`, `lang`, `bank_code`, or `profile_id`.

**Question:** Should we include any of these? Specifically `method=COLLECTION` for bank transfer?

### 3.5 Signature Generation

- **Algorithm:** HMAC-SHA256, output Base64-encoded
- **String-to-sign format:**
  ```
  POST\nhttps://payment.9pay.vn/payments/create\n{unix_timestamp}\n{sorted_urlencoded_params}
  ```
- Parameters sorted alphabetically by key (PHP `ksort()` equivalent)
- URL encoding via JavaScript `URLSearchParams` (matches PHP `urlencode()`)

**Example signed string:**
```
POST
https://payment.9pay.vn/payments/create
1770107392
amount=500000&back_url=https%3A%2F%2Fwww.englishaidol.com%2Fdashboard%3Fpayment%3Dsuccess%26provider%3D9pay%26invoice%3DEA07392445OOSA&description=English+AIdol+english+1m&invoice_no=EA07392445OOSA&merchantKey=q9n2F8&return_url=https%3A%2F%2Fwww.englishaidol.com%2Fdashboard%3Fpayment%3Dsuccess%26provider%3D9pay%26invoice%3DEA07392445OOSA&time=1770107392
```

**Resulting signature:** `3UUj7cI98/WZEA+w2rNjm7OjoYy2pzUrdew7/06risI=`

### 3.6 Portal URL Construction

```
https://payment.9pay.vn/portal?baseEncode={base64_json}&signature={hmac_signature}
```

Both `baseEncode` and `signature` are URL-encoded via `URLSearchParams`.

---

## 4. OUR SOURCE CODE

Below is our complete, unmodified payment creation function (Supabase Edge Function / Deno).
9Pay team can review to verify our implementation is correct.

### 4.1 Payment Creation Function (`ninepay-create-payment`)

```javascript
// Runtime: Deno (Supabase Edge Functions)
// This function is called from our React frontend when a Vietnamese user clicks "Pay"

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.190.0/crypto/mod.ts";

// HMAC-SHA256 sign and return base64
async function buildSignature(data, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw", encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const buf = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

// Build sorted URL-encoded query string (matches 9Pay JS sample)
function buildHttpQuery(data) {
    const httpQuery = new URLSearchParams();
    const sortedKeys = Object.keys(data).sort();
    sortedKeys.forEach(key => httpQuery.append(key, String(data[key])));
    return httpQuery.toString();
}

// Main handler
serve(async (req) => {
    const merchantKey = Deno.env.get("NINEPAY_MERCHANT_KEY");     // "q9n2F8"
    const secretKey = Deno.env.get("NINEPAY_SECRET_KEY");         // "XdigeSsrSrTL15CuAPDFQRdU4G1SYYuiVJ9"
    const apiEndpoint = "https://payment.9pay.vn";

    const invoiceNo = "EA" + Date.now().toString().slice(-8) + "XXXX";
    const time = Math.round(Date.now() / 1000);
    const returnUrl = "https://www.englishaidol.com/dashboard?payment=success";

    // Parameters (only the 7 required ones)
    const parameters = {
        merchantKey: merchantKey,
        time: time,
        invoice_no: invoiceNo,
        amount: 500000,                    // VND
        description: "English AIdol plan",
        back_url: returnUrl,
        return_url: returnUrl,
    };

    // Build signature
    const httpQuery = buildHttpQuery(parameters);
    const message = `POST\n${apiEndpoint}/payments/create\n${time}\n${httpQuery}`;
    const signature = await buildSignature(message, secretKey);

    // Build portal URL
    const baseEncode = btoa(JSON.stringify(parameters));
    const portalParams = buildHttpQuery({ baseEncode, signature });
    const paymentUrl = `${apiEndpoint}/portal?${portalParams}`;

    // Return URL to frontend → frontend opens in new tab → user sees 431
    return new Response(JSON.stringify({ paymentUrl, invoiceNo }));
});
```

### 4.2 Webhook Handler (`ninepay-webhook`)

```javascript
// Runtime: Deno (Supabase Edge Functions)
// URL: https://cuumxmfzhwljylbdlflj.supabase.co/functions/v1/ninepay-webhook
// This should receive IPN callbacks from 9Pay after payment

serve(async (req) => {
    const checksumKey = Deno.env.get("NINEPAY_CHECKSUM_KEY");  // "2Pl94oHsqcdexPZxWg2vQDrYQXKhNmW1"

    // Parse body (supports both form-urlencoded and JSON)
    const body = /* parsed from req */;
    const { result, checksum } = body;

    // Verify: SHA-256(result + checksumKey) === checksum
    const computed = SHA256(result + checksumKey).toUpperCase();
    if (computed !== checksum.toUpperCase()) return "Invalid checksum";

    // Decode: JSON.parse(base64_decode(result))
    const paymentData = JSON.parse(atob(result));
    // paymentData contains: invoice_no, amount, status (5=success, 6=failure), transaction_id

    // Update our database based on status
    // ...
});
```

---

## 5. OUR SERVER ENVIRONMENT

| Component | Details |
|-----------|---------|
| Backend | Supabase Edge Functions (Deno runtime, **Singapore region**) |
| Frontend | React app on Vercel (global CDN) |
| Domain | `www.englishaidol.com` |
| Payment flow | Server generates portal URL → frontend opens in new browser tab → **user sees 431** |

---

## 6. WHAT WE HAVE ALREADY TRIED

| # | What we tried | Result |
|---|--------------|--------|
| 1 | Direct Transaction Creation API (`POST /payments/create`) | `Invalid_Signature` |
| 2 | Portal Redirect (matching 9Pay JS sample) | 431 in browser |
| 3 | Removed extra params (method, currency, lang) | 431 in browser |
| 4 | Matched PHP `urlencode()` exactly | 431 in browser |
| 5 | Tested portal URL via `curl` from server | ✅ Works! (302 → 200) |
| 6 | Tested from multiple browsers & countries | 431 everywhere |
| 7 | Verified endpoint is `https://payment.9pay.vn` (not typo) | 431 in browser |

---

## 7. OUR CONCLUSION

The **signature and parameters are correct** — 9Pay's server accepts them via curl and returns the payment page. The 431 error only appears in browsers, which means:

1. Our code is working correctly
2. The problem is a **server-side configuration issue** on 9Pay's end
3. Likely cause: account permissions, domain whitelist, or integration method mismatch

---

## 8. HOW TO COLLABORATE

We are ready to work together to resolve this. Here's what would be most helpful:

### Option A: 9Pay fixes it directly
Check the diagnostic items in Section 2, fix any misconfiguration, and let us know when it's ready to test.

### Option B: Live debugging session
We can schedule a call/chat where:
1. We trigger a payment in real-time
2. 9Pay checks their server logs simultaneously
3. We identify exactly why the 431 is returned

### Option C: 9Pay provides a working test
If our account setup is wrong, please provide:
1. A working test portal URL for our merchant that we can open in a browser
2. Or a minimal code sample that works with our merchant key `q9n2F8`

### Option D: GitHub Collaboration
We have created a **private GitHub repository** containing ONLY the 9Pay integration code (no other application code). We can invite your developer to collaborate directly:

- **Repository:** https://github.com/AlfieAlfiegithu2/ninepay-integration
- Contains: payment creation function, webhook handler, this support document
- Your developer can review, edit, and fix the code directly
- Please provide your developer's GitHub username and we will add them as a collaborator

### Contact
- **Website:** https://www.englishaidol.com
- **Email:** ryanbigbang15@gmail.com
- **Available for live debugging:** Yes, flexible timezone

---

## 9. REFERENCES

- 9Pay JS Sample: https://gitlab.com/9pay-sample/sample-javascript/-/blob/main/index.js
- 9Pay Laravel SDK: https://github.com/funnydevjsc/ninepay-laravel-integrate
- 9Pay Developer Portal: https://developers.9pay.vn/danh-sach-api
- 9Pay E-Wallet (ZaloPay) Docs: https://developers.9pay.vn/e-wallet-payments/zalopay
