// Supabase Edge Function: flutterwave-webhook
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FLW_SECRET_KEY, FLW_WEBHOOK_HASH
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const secret = (key: string) => {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing Supabase function secret: ${key}`);
  return value;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    if (req.headers.get("verif-hash") !== secret("FLW_WEBHOOK_HASH")) {
      return reply({ error: "Invalid webhook signature" }, 401);
    }
    const event = await req.json();
    const transactionId = event?.data?.id;
    const txRef = event?.data?.tx_ref;
    if (!transactionId || !txRef) return reply({ received: true, ignored: true });

    const base = secret("SUPABASE_URL").replace(/\/$/, "");
    const serviceKey = secret("SUPABASE_SERVICE_ROLE_KEY");
    const flutterwaveKey = secret("FLW_SECRET_KEY");
    const verify = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(String(transactionId))}/verify`,
      { headers: { Authorization: `Bearer ${flutterwaveKey}` } },
    );
    const verified = await verify.json();
    const payment = verified?.data;
    if (!verify.ok || verified?.status !== "success" || payment?.status !== "successful") {
      return reply({ received: true, verified: false });
    }

    const orderUrl = new URL(`${base}/rest/v1/jumie_orders`);
    orderUrl.searchParams.set("select", "id,tx_ref,amount,currency,status");
    orderUrl.searchParams.set("tx_ref", `eq.${String(txRef)}`);
    const orderResponse = await fetch(orderUrl, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const orders = await orderResponse.json();
    const order = Array.isArray(orders) ? orders[0] : null;
    if (!order) return reply({ error: "Order not found" }, 404);

    // Match the verified transaction to the saved order exactly.
    if (
      String(payment.tx_ref) !== String(order.tx_ref) ||
      String(payment.currency).toUpperCase() !== "NGN" ||
      String(order.currency).toUpperCase() !== "NGN" ||
      Number(payment.amount) !== Number(order.amount)
    ) {
      return reply({ error: "Verified payment does not match the order." }, 400);
    }

    const confirm = await fetch(`${base}/rest/v1/rpc/jumie_confirm_order`, {
      method: "POST",
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_order_id: order.id, p_transaction_id: String(transactionId) }),
    });
    if (!confirm.ok) {
      console.error("JUMIE order confirmation failed:", await confirm.text());
      return reply({ error: "Order confirmation failed" }, 500);
    }
    return reply({ received: true, verified: true });
  } catch (error) {
    console.error("JUMIE webhook error:", error);
    return reply({ error: error instanceof Error ? error.message : "Webhook failed" }, 500);
  }
});
