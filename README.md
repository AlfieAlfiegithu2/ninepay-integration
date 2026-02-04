# 9Pay Integration — English AIdol

This repository contains **only** the 9Pay payment integration code for English AIdol.
It is shared with the 9Pay support team to help diagnose the **431 PERMISSION DENIED** issue.

## Problem Summary

Our portal redirect URLs work via `curl` (HTTP 302 → 200) but return **431 PERMISSION DENIED** in all browsers.

See [SUPPORT-REQUEST.md](./SUPPORT-REQUEST.md) for the full diagnostic report.

## Repository Structure

```
ninepay-integration/
├── README.md                          ← You are here
├── SUPPORT-REQUEST.md                 ← Full diagnostic report for 9Pay team
├── .env.example                       ← Environment variables (credentials included)
└── supabase-functions/
    ├── ninepay-create-payment/
    │   └── index.ts                   ← Creates portal redirect URL (THE ISSUE IS HERE)
    └── ninepay-webhook/
        └── index.ts                   ← Handles IPN callbacks after payment
```

## How It Works

### Payment Creation (`ninepay-create-payment/index.ts`)
1. Receives payment request from frontend (plan, amount, user)
2. Builds parameters: `merchantKey`, `time`, `invoice_no`, `amount`, `description`, `back_url`, `return_url`
3. Signs with HMAC-SHA256: `POST\n{endpoint}/payments/create\n{time}\n{sorted_params}`
4. Constructs portal URL: `https://payment.9pay.vn/portal?baseEncode={base64}&signature={hmac}`
5. Returns URL to frontend → frontend opens in new browser tab
6. **Result: 431 PERMISSION DENIED in browser** ❌

### Webhook Handler (`ninepay-webhook/index.ts`)
1. Receives IPN POST from 9Pay after payment completion
2. Verifies checksum: `SHA-256(result + checksumKey)`
3. Decodes base64 result → gets `invoice_no`, `status`, `amount`
4. Updates user subscription in database
5. **Not yet tested** (can't reach payment page to trigger a webhook)

## Credentials

| Item | Value |
|------|-------|
| Merchant Key | `q9n2F8` |
| Secret Key | `XdigeSsrSrTL15CuAPDFQRdU4G1SYYuiVJ9` |
| Checksum Key | `2Pl94oHsqcdexPZxWg2vQDrYQXKhNmW1` |
| Production Endpoint | `https://payment.9pay.vn` |
| Webhook URL | `https://cuumxmfzhwljylbdlflj.supabase.co/functions/v1/ninepay-webhook` |
| Website | `https://www.englishaidol.com` |

## Runtime

- **Deno** (via Supabase Edge Functions, Singapore region)
- Frontend: React on Vercel

## Contact

- **Email:** ryanbigbang15@gmail.com
- **Website:** https://www.englishaidol.com
