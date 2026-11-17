const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const secret = (key: string) => {
  const value = Deno.env.get(key)?.trim();
  if (!value) throw new Error(`Missing Supabase function secret: ${key}`);
  return value;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    let transactionId = String(body.transaction_id ?? "").trim();
    let txRef = String(body.tx_ref ?? "").trim();

    const base = secret("SUPABASE_URL").replace(/\/$/, "");
    const serviceKey = secret("SUPABASE_SERVICE_ROLE_KEY");
    const flutterwaveKey = secret("FLW_SECRET_KEY");

    let order: any = null;
    if (txRef) {
      const orderUrl = new URL(`${base}/rest/v1/orders`);
      orderUrl.searchParams.set("select", "id,order_number,tx_ref,total,currency,payment_status,customer_email,paid_at,user_id");
      orderUrl.searchParams.set("tx_ref", `eq.${txRef}`);
      orderUrl.searchParams.set("limit", "1");
      const orderRes = await fetch(orderUrl, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!orderRes.ok) return reply({ error: "Could not look up this order. Please contact JUMIE support." }, 500);
      const rows = await orderRes.json();
      order = Array.isArray(rows) ? rows[0] : null;
    } else if (body.recover_latest === true) {
      const authorization = req.headers.get("authorization") ?? "";
      const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (!bearer || bearer === serviceKey) {
        return reply({ error: "Please sign in to check your most recent order." }, 401);
      }
      const authRes = await fetch(`${base}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
      });
      if (!authRes.ok) return reply({ error: "Your sign-in session expired. Please sign in and check your payment again." }, 401);
      const authUser = await authRes.json();
      if (!authUser?.id) return reply({ error: "Could not verify your customer account." }, 401);

      const orderUrl = new URL(`${base}/rest/v1/orders`);
      orderUrl.searchParams.set("select", "id,order_number,tx_ref,total,currency,payment_status,customer_email,paid_at,user_id");
      orderUrl.searchParams.set("user_id", `eq.${String(authUser.id)}`);
      orderUrl.searchParams.set("payment_status", "eq.pending");
      orderUrl.searchParams.set("order", "created_at.desc");
      orderUrl.searchParams.set("limit", "1");
      const orderRes = await fetch(orderUrl, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!orderRes.ok) return reply({ error: "Could not find your recent pending order." }, 500);
      const rows = await orderRes.json();
      order = Array.isArray(rows) ? rows[0] : null;
      if (order) txRef = String(order.tx_ref ?? "");
    } else {
      return reply({ error: "Missing payment reference. Please contact JUMIE support before trying again." }, 400);
    }

    if (!order || !txRef) return reply({ error: "No matching pending order was found. Please contact JUMIE support." }, 404);

    let verified: any;
    if (transactionId) {
      const verifyRes = await fetch(
        `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
        { headers: { Authorization: `Bearer ${flutterwaveKey}`, Accept: "application/json" } },
      );
      verified = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || verified?.status !== "success") {
        return reply({ status: "not_paid", error: "Flutterwave has not confirmed this payment yet. If money was deducted, please contact JUMIE support before trying again." }, 402);
      }
    } else {
      const verifyUrl = new URL("https://api.flutterwave.com/v3/transactions/verify_by_reference");
      verifyUrl.searchParams.set("tx_ref", txRef);
      const verifyRes = await fetch(verifyUrl, {
        headers: { Authorization: `Bearer ${flutterwaveKey}`, Accept: "application/json" },
      });
      verified = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || verified?.status !== "success") {
        return reply({ status: "not_paid", error: "Flutterwave has not confirmed this payment yet. If money was deducted, please contact JUMIE support before trying again." }, 402);
      }
    }

    const payment = verified?.data;
    if (!payment || payment.status !== "successful" || String(payment.tx_ref) !== txRef) {
      return reply({ status: "not_paid", error: "Payment is not marked successful by Flutterwave yet. If money was deducted, please contact JUMIE support before trying again." }, 402);
    }
    if (
      String(payment.currency).toUpperCase() !== "NGN" ||
      String(order.currency).toUpperCase() !== "NGN" ||
      Number(payment.amount) < Number(order.total)
    ) {
      return reply({ error: "The verified payment details do not match this order. Please contact JUMIE support." }, 400);
    }

    const paidEmail = String(payment.customer?.email ?? "").trim().toLowerCase();
    const orderEmail = String(order.customer_email ?? "").trim().toLowerCase();
    if (paidEmail && orderEmail && paidEmail !== orderEmail) {
      return reply({ error: "The payment email does not match this order. Please contact JUMIE support." }, 400);
    }

    transactionId = String(payment.id ?? transactionId ?? "").trim();
    if (!transactionId) return reply({ error: "Flutterwave did not return a transaction ID. Please contact JUMIE support." }, 502);

    const confirm = await fetch(`${base}/rest/v1/rpc/jumie_confirm_order`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_order_id: order.id, p_transaction_id: transactionId }),
    });
    if (!confirm.ok) {
      console.error("JUMIE order confirmation failed:", await confirm.text());
      return reply({ error: "Payment was verified, but the order could not be confirmed automatically. Please contact JUMIE support. Do not pay again." }, 500);
    }

    const confirmedAt = order.paid_at ? new Date(order.paid_at) : new Date();
    const deliveryDate = new Date(confirmedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    return reply({
      status: "success",
      order_number: order.order_number,
      delivery_days: 14,
      expected_delivery_date: deliveryDate.toISOString(),
      message: "Your payment has been confirmed. Your order is expected to be delivered within 14 days.",
    });
  } catch (error) {
    console.error("JUMIE payment confirmation error:", error);
    return reply({ error: error instanceof Error ? error.message : "Could not confirm payment." }, 500);
  }
});