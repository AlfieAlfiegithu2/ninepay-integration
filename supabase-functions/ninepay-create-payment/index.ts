// @ts-nocheck
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.190.0/crypto/mod.ts";

console.log("Ninepay function loaded");

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
 * Matches: crypto.createHmac("sha256", secret).update(data).digest().toString('base64')
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
 * Matches EXACTLY the official 9Pay JavaScript sample from:
 * https://gitlab.com/9pay-sample/sample-javascript/-/blob/main/index.js
 * Uses URLSearchParams (same as their sample), keys sorted alphabetically.
 */
function buildHttpQuery(data: Record<string, string | number>): string {
    const httpQuery = new URLSearchParams();
    const ordered = Object.keys(data).sort().reduce(
        (obj: Record<string, string | number>, key: string) => {
            obj[key] = data[key];
            return obj;
        },
        {} as Record<string, string | number>
    );
    Object.keys(ordered).forEach(function (parameterName) {
        httpQuery.append(parameterName, String(ordered[parameterName]));
    });
    return httpQuery.toString();
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

        // Production endpoint — MUST be https://payment.9pay.vn (not paymnet or other typos)
        let apiEndpoint = Deno.env.get("NINEPAY_API_ENDPOINT") || "https://payment.9pay.vn";
        // Safety: normalize endpoint (remove trailing slash, fix common typos)
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
        const { userId, planId, months, affiliateCodeId, affiliateId, discountAmount } = body;

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

        const invoiceNo = `EA${Date.now().toString().slice(-8)}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const time = Math.round(Date.now() / 1000);
        const baseUrl = Deno.env.get("NINEPAY_RETURN_URL") || "https://www.englishaidol.com";
        const returnUrl = `${baseUrl}/dashboard?payment=success&provider=9pay&invoice=${invoiceNo}`;

        // ============================================================
        // 9Pay Redirect approach (per official JS sample)
        // 1. Build params
        // 2. Sort & URL-encode via URLSearchParams
        // 3. Sign: POST\n{endpoint}/payments/create\n{time}\n{httpQuery}
        // 4. Base64-encode params JSON
        // 5. Return portal URL: {endpoint}/portal?baseEncode=...&signature=...
        //
        // method=COLLECTION forces bank transfer payment flow
        // ============================================================

        // Match EXACTLY the 9Pay Laravel SDK params (no extras like method/currency/lang)
        // Extra params change the signature and can cause 431 on portal
        const parameters: Record<string, string | number> = {
            merchantKey: merchantKey,
            time: time,
            invoice_no: invoiceNo,
            amount: amountVND,
            description: `English AIdol ${planKey} ${months}m`,
            back_url: returnUrl,
            return_url: returnUrl,
        };

        // Build sorted URL-encoded query string
        const httpQuery = buildHttpQuery(parameters);

        // Build string to sign (per 9Pay official sample)
        const message = `POST\n${apiEndpoint}/payments/create\n${time}\n${httpQuery}`;
        console.log("String to sign:", message);

        // Generate HMAC-SHA256 signature
        const signature = await buildSignature(message, merchantSecretKey);
        console.log("Signature:", signature);

        // Base64 encode the params JSON
        const baseEncode = btoa(JSON.stringify(parameters));

        // Build portal URL
        const portalParams = buildHttpQuery({
            baseEncode: baseEncode,
            signature: signature,
        });
        const paymentUrl = `${apiEndpoint}/portal?${portalParams}`;

        console.log("Payment URL generated:", paymentUrl);

        // Server-side validation: test the portal URL to catch 431 errors before user sees them
        try {
            const testResponse = await fetch(paymentUrl, {
                method: "GET",
                redirect: "manual", // Don't follow redirects, just check status
            });
            console.log("Portal URL test - Status:", testResponse.status, "Location:", testResponse.headers.get("location"));

            if (testResponse.status === 431) {
                console.error("9Pay portal returned 431 PERMISSION DENIED - account may not be activated or domain not whitelisted");
                return new Response(
                    JSON.stringify({
                        error: "Payment gateway returned permission denied (431). Please contact support.",
                        details: "9Pay portal rejected the request. This is usually an account configuration issue on 9Pay's side.",
                        paymentUrl: paymentUrl, // Still return it for debugging
                        invoiceNo: invoiceNo,
                    }),
                    { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            if (testResponse.status !== 302 && testResponse.status !== 200) {
                console.warn("Portal URL test returned unexpected status:", testResponse.status);
            }
        } catch (testError) {
            console.warn("Portal URL pre-validation failed (non-blocking):", testError);
            // Non-blocking: still proceed even if test fails (network issues, etc.)
        }

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

        return new Response(
            JSON.stringify({
                success: true,
                paymentUrl: paymentUrl,
                invoiceNo: invoiceNo,
                amount: amountVND,
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
