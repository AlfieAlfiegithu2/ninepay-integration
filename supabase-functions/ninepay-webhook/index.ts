// @ts-ignore
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2";
// @ts-ignore
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper: Verify 9Pay checksum
async function verifyChecksum(result: string, checksum: string, checksumKey: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const data = encoder.encode(result + checksumKey);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const computedChecksum = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    return computedChecksum === checksum.toUpperCase();
}

// @ts-ignore
serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        // Get 9Pay checksum key from environment
        // @ts-ignore
        const checksumKey = Deno.env.get("NINEPAY_CHECKSUM_KEY") || "";

        if (!checksumKey) {
            console.error("Missing NINEPAY_CHECKSUM_KEY");
            return new Response("Missing checksum key", { status: 500, headers: corsHeaders });
        }

        // Parse the webhook data (x-www-form-urlencoded or JSON)
        let body: any;
        const contentType = req.headers.get("content-type") || "";

        if (contentType.includes("application/x-www-form-urlencoded")) {
            const formData = await req.formData();
            body = Object.fromEntries(formData.entries());
        } else {
            body = await req.json();
        }

        console.log("9Pay webhook received:", JSON.stringify(body));

        const { result, checksum, version } = body;

        if (!result || !checksum) {
            console.error("Missing result or checksum in webhook");
            return new Response("Invalid webhook data", { status: 400, headers: corsHeaders });
        }

        // Verify checksum
        const isValid = await verifyChecksum(result, checksum, checksumKey);
        if (!isValid) {
            console.error("Invalid checksum from 9Pay");
            return new Response("Invalid checksum", { status: 401, headers: corsHeaders });
        }

        // Decode result (base64 JSON)
        let paymentData: any;
        try {
            paymentData = JSON.parse(atob(result));
        } catch (e) {
            console.error("Failed to decode payment result:", e);
            return new Response("Invalid result format", { status: 400, headers: corsHeaders });
        }

        console.log("9Pay payment data:", JSON.stringify(paymentData));

        const {
            invoice_no: invoiceNo,
            amount,
            status, // 5 = success, 6 = failure
            transaction_id: transactionId,
        } = paymentData;

        // Initialize Supabase Admin
        const supabaseAdmin = createClient(
            // @ts-ignore
            Deno.env.get("SUPABASE_URL") ?? "",
            // @ts-ignore
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
        );

        // Find the pending payment
        const { data: pendingPayment, error: fetchError } = await supabaseAdmin
            .from("pending_payments")
            .select("*")
            .eq("invoice_no", invoiceNo)
            .single();

        if (fetchError || !pendingPayment) {
            console.error("Pending payment not found:", invoiceNo, fetchError);
            // Still return 200 to acknowledge receipt
            return new Response(JSON.stringify({ received: true, error: "Payment not found" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Check for duplicate processing
        if (pendingPayment.status === "completed") {
            console.log("Payment already processed:", invoiceNo);
            return new Response(JSON.stringify({ received: true, duplicate: true }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Handle successful payment (status === 5)
        if (status === 5) {
            const { user_id: userId, plan_id: planId, months, affiliate_code_id: affiliateCodeId, affiliate_id: affiliateId } = pendingPayment;

            // Calculate subscription expiry
            const expiresAt = new Date();
            expiresAt.setMonth(expiresAt.getMonth() + (months || 1));

            // Determine subscription status
            const subscriptionStatus = planId === "ultra" ? "ultra" : "premium";

            // Update user profile
            const { error: updateError } = await supabaseAdmin
                .from("profiles")
                .update({
                    subscription_status: subscriptionStatus,
                    subscription_expires_at: expiresAt.toISOString(),
                    stripe_subscription_id: null, // Not a Stripe subscription
                })
                .eq("id", userId);

            if (updateError) {
                console.error("Failed to update user subscription:", updateError);
            } else {
                console.log(`User ${userId} activated ${subscriptionStatus} via 9Pay until ${expiresAt.toISOString()}`);
            }

            // Handle affiliate referral if applicable
            if (affiliateCodeId && affiliateId) {
                try {
                    const { data: affiliate } = await supabaseAdmin
                        .from("affiliates")
                        .select("commission_percent, type")
                        .eq("id", affiliateId)
                        .single();

                    if (affiliate) {
                        const isEmployee = affiliate.type === "employee";
                        let commissionAmount = 0;
                        let isQualified = true;

                        // Convert VND to USD for commission calculation (approximate)
                        const amountUSD = amount / 25000;

                        if (isEmployee) {
                            // Check employee threshold
                            const { data: totalRevenueData } = await supabaseAdmin
                                .from("affiliate_referrals")
                                .select("final_amount")
                                .eq("affiliate_id", affiliateId);

                            const totalRevenueGenerated = (totalRevenueData || []).reduce(
                                (sum: number, r: any) => sum + (r.final_amount || 0),
                                0
                            );

                            const THRESHOLD = 1430.89;

                            if (totalRevenueGenerated < THRESHOLD) {
                                isQualified = false;
                                commissionAmount = 0;
                            } else {
                                const basis = amountUSD * 0.9;
                                commissionAmount = Math.round((basis * (affiliate.commission_percent / 100)) * 100) / 100;
                            }
                        } else {
                            commissionAmount = Math.round((amountUSD * (affiliate.commission_percent / 100)) * 100) / 100;
                        }

                        await supabaseAdmin.from("affiliate_referrals").insert({
                            affiliate_code_id: affiliateCodeId,
                            affiliate_id: affiliateId,
                            user_id: userId,
                            ninepay_invoice_no: invoiceNo,
                            ninepay_transaction_id: transactionId,
                            original_amount: amountUSD,
                            discount_amount: 0,
                            final_amount: amountUSD,
                            currency: "usd",
                            commission_amount: commissionAmount,
                            commission_status: isQualified ? "pending" : "disqualified",
                            plan_id: planId,
                        });

                        // Increment redemptions
                        try {
                            await supabaseAdmin.rpc("increment_affiliate_code_redemptions", { code_id: affiliateCodeId });
                        } catch (e) {
                            const { data: c } = await supabaseAdmin
                                .from("affiliate_codes")
                                .select("current_redemptions")
                                .eq("id", affiliateCodeId)
                                .single();
                            if (c) {
                                await supabaseAdmin
                                    .from("affiliate_codes")
                                    .update({ current_redemptions: (c.current_redemptions || 0) + 1 })
                                    .eq("id", affiliateCodeId);
                            }
                        }
                    }
                } catch (err) {
                    console.error("Error recording affiliate referral:", err);
                }
            }

            // Update pending payment status
            await supabaseAdmin
                .from("pending_payments")
                .update({
                    status: "completed",
                    transaction_id: transactionId,
                    completed_at: new Date().toISOString(),
                })
                .eq("invoice_no", invoiceNo);

            return new Response(
                JSON.stringify({ received: true, success: true, userId, subscriptionStatus }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        } else {
            // Payment failed
            await supabaseAdmin
                .from("pending_payments")
                .update({
                    status: "failed",
                    transaction_id: transactionId,
                    completed_at: new Date().toISOString(),
                })
                .eq("invoice_no", invoiceNo);

            return new Response(
                JSON.stringify({ received: true, success: false }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
    } catch (error) {
        console.error("9Pay webhook error:", error);
        return new Response("Server error", { status: 500, headers: corsHeaders });
    }
});
