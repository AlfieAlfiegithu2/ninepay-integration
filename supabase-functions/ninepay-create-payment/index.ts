// @ts-nocheck
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.190.0/crypto/mod.ts";

console.log("Ninepay function loaded (Bank Transfer API v2)");

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-forwarded-for",
};

// Pricing in VND (matching USD prices)
const PRICING_VND: Record<string, Record<string, number>> = {
    pro: {
        monthly: 1_225_000,       // ~$49
        threeMonth: 2_925_000,    // ~$117 ($39/mo x 3)
        sixMonth: 4_350_000,      // ~$174 ($29/mo x 6)
        twelveMonth: 8_700_000,   // ~$348 ($29/mo x 12)
    },
    ultra: {
        monthly: 4_975_000,       // ~$199
        threeMonth: 11_175_000,   // ~$447 ($149/mo x 3)
        sixMonth: 17_850_000,     // ~$714 ($119/mo x 6)
        twelveMonth: 35_700_000,  // ~$1428 ($119/mo x 12)
    },
    english: {
        monthly: 500_000,         // ~$20
        threeMonth: 1_500_000,    // ~$60 ($20/mo x 3)
        sixMonth: 2_000_000,      // ~$80 ($13.33/mo x 6)
        twelveMonth: 1_725_000,   // ~$69 ($5.75/mo x 12)
    },
};

/**
 * HMAC-SHA256 sign and return base64.
 * Matches 9Pay Postman pre-script:
 *   CryptoJS.HmacSHA256(data, secret) → CryptoJS.enc.Base64.stringify(signature)
 */
async function buildSignature(data: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const buf = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/**
 * Build URL-encoded query string with SORTED keys.
 * Matches 9Pay Postman pre-script buildHttpQuery:
 *   Object.keys(params).sort().map(key => encodeURIComponent(key) + '=' + encodeURIComponent(params[key])).join('&')
 *   Then replace %20 with +
 */
function buildHttpQuery(data: Record<string, string | number>): string {
    const queryString = Object.keys(data).sort().map((key) => {
        return encodeURIComponent(key) + '=' + encodeURIComponent(String(data[key]));
    }).join('&');
    return queryString.replace(/%20/g, "+");
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        console.log("Request received");

        // Get 9Pay credentials
        const merchantKey = Deno.env.get("NINEPAY_MERCHANT_KEY") || "";
        const merchantSecretKey = Deno.env.get("NINEPAY_SECRET_KEY") || "";

        // Production endpoint
        let apiEndpoint = Deno.env.get("NINEPAY_API_ENDPOINT") || "https://payment.9pay.vn";
        apiEndpoint = apiEndpoint.replace(/\/+$/, "");
        if (apiEndpoint.includes("paymnet")) {
            console.warn("NINEPAY_API_ENDPOINT has typo 'paymnet', fixing to 'payment'");
            apiEndpoint = apiEndpoint.replace("paymnet", "payment");
        }

        console.log("9Pay Config - Merchant:", merchantKey, "Endpoint:", apiEndpoint);

        if (!merchantKey || !merchantSecretKey) {
            console.error("Missing 9Pay credentials");
            return new Response(
                JSON.stringify({ error: "Payment service not configured" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const body = await req.json();
        const { userId, planId, months, affiliateCodeId, affiliateId, discountAmount, clientIp } = body;

        console.log("9Pay Request:", { userId, planId, months });

        if (!userId || !planId) {
            return new Response(
                JSON.stringify({ error: "Missing required parameters" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Initialize Supabase
        const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
        const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

        // Determine amount
        let amountVND = 0;
        const planKey = planId === "premium" || planId === "pro" ? "pro"
            : planId === "english" ? "english"
            : "ultra";
        const billingCycle = months === 12 ? "twelveMonth" : months === 6 ? "sixMonth" : months === 3 ? "threeMonth" : "monthly";
        amountVND = PRICING_VND[planKey]?.[billingCycle] || PRICING_VND[planKey]?.["monthly"] || 500_000;

        console.log("Plan:", planKey, "Cycle:", billingCycle, "Amount VND:", amountVND);

        if (discountAmount && discountAmount > 0) {
            amountVND = Math.max(amountVND - discountAmount, 25000);
        }

        // Generate invoice number (8 chars alphanumeric, matching 9Pay Postman sample)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let invoiceRandom = '';
        for (let i = 0; i < 8; i++) {
            invoiceRandom += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const invoiceNo = `EA${invoiceRandom}`;
        const time = Math.round(Date.now() / 1000);
        const baseUrl = Deno.env.get("NINEPAY_RETURN_URL") || "https://www.englishaidol.com";
        const returnUrl = `${baseUrl}/dashboard?payment=success&provider=9pay&invoice=${invoiceNo}`;

        // ============================================================
        // 9Pay Bank Transfer API (from official Postman collection)
        //
        // Endpoint: POST /api/payments/create-bank-transfer
        // Auth: Authorization header with HMAC-SHA256 signature
        // Body: form-data with all parameters
        //
        // This is a SERVER-TO-SERVER call (not a portal redirect!)
        // 9Pay returns bank transfer details (account, QR code, etc.)
        // ============================================================

        const parameters: Record<string, string | number> = {
            merchantKey: merchantKey,
            time: time,
            invoice_no: invoiceNo,
            lang: "vi",
            client_ip: clientIp || "127.0.0.1",
            amount: amountVND,
            currency: "VND",
            method: "COLLECTION",
            description: `English AIdol ${planKey} ${months}m`,
            return_url: returnUrl,
            expires_time: 100, // minutes before transfer expires
        };

        // Build sorted URL-encoded query string (matching Postman pre-script)
        const httpQuery = buildHttpQuery(parameters);

        // Build string to sign (matching Postman pre-script exactly)
        // POST\n{endpoint}/api/payments/create-bank-transfer\n{time}\n{httpQuery}
        const message = `POST\n${apiEndpoint}/api/payments/create-bank-transfer\n${time}\n${httpQuery}`;
        console.log("String to sign:", message);

        // Generate HMAC-SHA256 signature
        const signature = await buildSignature(message, merchantSecretKey);
        console.log("Signature:", signature);

        // Build form data body (matching Postman body)
        const formData = new FormData();
        Object.entries(parameters).forEach(([key, value]) => {
            formData.append(key, String(value));
        });

        // Make server-to-server POST request to 9Pay
        // Headers match Postman: Authorization + Date
        const apiUrl = `${apiEndpoint}/api/payments/create-bank-transfer`;
        console.log("Calling 9Pay API:", apiUrl);

        const ninePayResponse = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Authorization": `Signature Algorithm=HS256,Credential=${merchantKey},SignedHeaders=,Signature=${signature}`,
                "Date": String(time),
            },
            body: formData,
        });

        const responseStatus = ninePayResponse.status;
        const responseText = await ninePayResponse.text();
        console.log("9Pay API Response - Status:", responseStatus, "Body:", responseText);

        let ninePayData: any;
        try {
            ninePayData = JSON.parse(responseText);
        } catch (e) {
            console.error("Failed to parse 9Pay response:", responseText);
            return new Response(
                JSON.stringify({
                    error: "Invalid response from payment gateway",
                    details: responseText.substring(0, 500),
                    httpStatus: responseStatus,
                }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Check for errors from 9Pay
        // Bank transfer response has: payment_no, status=2 (pending), list_bank_info
        // status=2 means "awaiting transfer" which is SUCCESS for creation
        // Only treat as error if HTTP is not 200 or there's no payment_no/list_bank_info
        const hasPaymentNo = ninePayData.payment_no || ninePayData.data?.payment_no;
        const hasBankInfo = ninePayData.list_bank_info || ninePayData.data?.list_bank_info;
        if (responseStatus !== 200 || (!hasPaymentNo && !hasBankInfo)) {
            console.error("9Pay API error:", JSON.stringify(ninePayData));
            return new Response(
                JSON.stringify({
                    error: ninePayData.message || ninePayData.failure_reason || "Payment gateway error",
                    details: ninePayData,
                    httpStatus: responseStatus,
                }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        console.log("9Pay bank transfer created successfully - payment_no:", hasPaymentNo);

        // Store pending payment
        await supabaseAdmin.from("pending_payments").insert({
            invoice_no: invoiceNo,
            user_id: userId,
            plan_id: planId,
            months: months || 1,
            amount_vnd: amountVND,
            provider: "9pay",
            status: "pending",
            affiliate_code_id: affiliateCodeId || null,
            affiliate_id: affiliateId || null,
            created_at: new Date().toISOString(),
        });

        // Return bank transfer details to frontend
        // 9Pay returns at root level: payment_no, list_bank_info[], amount, status, etc.
        const bankData = ninePayData.data || ninePayData;
        return new Response(
            JSON.stringify({
                success: true,
                invoiceNo: invoiceNo,
                amount: amountVND,
                bankTransfer: {
                    payment_no: bankData.payment_no,
                    list_bank_info: bankData.list_bank_info || [],
                    expires_time: bankData.expires_time,
                    deep_link: bankData.deep_link,
                },
                paymentNo: bankData.payment_no || null,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

    } catch (error) {
        console.error("Fatal Error:", error);
        return new Response(
            JSON.stringify({ error: "Internal server error", details: String(error) }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
