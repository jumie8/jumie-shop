// Supabase Edge Function: flutterwave-checkout
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FLW_SECRET_KEY, SITE_URL
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const secret = (key: string) => {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing Supabase function secret: ${key}`);
  return value;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  try {
    const base = secret("SUPABASE_URL").replace(/\/$/, "");
    const serviceKey = secret("SUPABASE_SERVICE_ROLE_KEY");
    const flutterwaveKey = secret("FLW_SECRET_KEY");
    const siteUrl = secret("SITE_URL");
    const body = await req.json();
    const items = Array.isArray(body.items) ? body.items : [];
    const customer = body.customer ?? {};
    const name = String(customer.name ?? "").trim();
    const email = String(customer.email ?? "").trim().toLowerCase();
    const phone = String(customer.phone ?? "").trim();
    const state = String(customer.state ?? "").trim();
    const city = String(customer.city ?? "").trim();
    const address = String(customer.address ?? "").trim();

    if (!items.length || items.length > 50) return reply({ error: "Your cart is empty or too large." }, 400);
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone || !state || !city || !address) {
      return reply({ error: "Please enter complete and valid delivery details." }, 400);
    }

    const quantities = new Map<string, number>();
    for (const item of items) {
      const id = String(item.id ?? "").trim();
      const qty = Number(item.qty);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(qty) || qty < 1 || qty > 99) {
        return reply({ error: "Invalid product or quantity in your cart." }, 400);
      }
      quantities.set(id, (quantities.get(id) ?? 0) + qty);
    }

    // Always read authoritative prices and stock from Supabase; never trust browser totals.
    const productUrl = new URL(`${base}/rest/v1/products`);
    productUrl.searchParams.set("select", "id,name,price,stock");
    productUrl.searchParams.set("id", `in.(${[...quantities.keys()].join(",")})`);
    const productResponse = await fetch(productUrl, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!productResponse.ok) throw new Error("Could not validate products against store inventory.");
    const products = await productResponse.json();
    if (!Array.isArray(products) || products.length !== quantities.size) {
      return reply({ error: "A product is no longer available. Please refresh your cart." }, 409);
    }

    const lines = [];
    let total = 0;
    for (const product of products) {
      const qty = quantities.get(String(product.id)) ?? 0;
      const price = Number(product.price);
      const stock = Number(product.stock);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stock) || stock < qty) {
        return reply({ error: `${product.name ?? "A product"} is out of stock or has an invalid price.` }, 409);
      }
      const lineTotal = Number((price * qty).toFixed(2));
      total = Number((total + lineTotal).toFixed(2));
      lines.push({
        product_id: String(product.id),
        product_name: String(product.name ?? "Product"),
        unit_price: price,
        quantity: qty,
        line_total: lineTotal,
      });
    }

    const txRef = `JUMIE-${crypto.randomUUID()}`;
    const orderResponse = await fetch(`${base}/rest/v1/jumie_orders`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        tx_ref: txRef, status: "pending", amount: total, currency: "NGN",
        customer_name: name, customer_email: email, customer_phone: phone,
        customer_state: state, customer_city: city, delivery_address: address,
      }),
    });
    const orderRows = await orderResponse.json();
    if (!orderResponse.ok || !Array.isArray(orderRows) || !orderRows[0]?.id) {
      throw new Error("Could not save the order in Supabase.");
    }
    const orderId = orderRows[0].id;

    const itemResponse = await fetch(`${base}/rest/v1/jumie_order_items`, {
      method: "POST",
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(lines.map((line) => ({ ...line, order_id: orderId }))),
    });
    if (!itemResponse.ok) {
      await fetch(`${base}/rest/v1/jumie_orders?id=eq.${orderId}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      throw new Error("Could not save the order items in Supabase.");
    }

    const paymentResponse = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${flutterwaveKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef, amount: total, currency: "NGN", redirect_url: siteUrl,
        customer: { email, name, phonenumber: phone },
        customizations: { title: "JUMIE Online Shopping", description: `Payment for order ${txRef}` },
        meta: { jumie_order_id: orderId },
      }),
    });
    const paymentData = await paymentResponse.json();
    const link = paymentData?.data?.link;
    if (!paymentResponse.ok || paymentData?.status !== "success" || !link) {
      await fetch(`${base}/rest/v1/jumie_orders?id=eq.${orderId}`, {
        method: "PATCH",
        headers: {
          apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "failed" }),
      });
      throw new Error(paymentData?.message || "Flutterwave could not start the payment.");
    }
    return reply({ status: "success", link, tx_ref: txRef, order_id: orderId });
  } catch (error) {
    console.error("JUMIE checkout error:", error);
    return reply({ error: error instanceof Error ? error.message : "Checkout failed." }, 500);
  }
});
