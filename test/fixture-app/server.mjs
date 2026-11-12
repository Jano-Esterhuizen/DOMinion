// DOMinion e2e fixture app: a tiny shop used by auth, pipeline, heal and crawl tests so the suite
// never depends on external sites. Plain ESM so it also runs standalone:
//   node test/fixture-app/server.mjs        (PORT env var, default 4600)
// All credentials below are obviously fake and exist only for tests.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { createGuardrails, verifySync } from "otplib";

export const FIXTURE_USERS = Object.freeze({
  plain: Object.freeze({
    email: "fixture.user@example.test",
    password: "fixture-pass-PLAIN-0000",
    name: "Fixture Customer",
    role: "customer",
  }),
  totp: Object.freeze({
    email: "fixture.admin@example.test",
    password: "fixture-pass-TOTP-0000",
    name: "Fixture Admin",
    role: "admin",
    totpSecret: "JBSWY3DPEHPK3PXP",
  }),
});

export const FIXTURE_PRODUCTS = Object.freeze([
  { id: 1, name: "Backpack", category: "gear", price: 29.99, description: "A sturdy backpack for every trip." },
  { id: 2, name: "Bike Light", category: "gear", price: 9.99, description: "Bright enough for night rides." },
  { id: 3, name: "Bolt T-Shirt", category: "clothing", price: 15.99, description: "Soft cotton with a bolt logo." },
  { id: 4, name: "Fleece Jacket", category: "clothing", price: 49.99, description: "Warm, light and packable." },
  { id: 5, name: "Onesie", category: "clothing", price: 7.99, description: "For the smallest testers." },
]);

const DEFAULT_FLAGS = Object.freeze({
  /** Renames the "Add to cart" button to "Add to basket" (breaks a locator; healable). */
  renameAddToCart: false,
  /** Adding to the cart silently does nothing (broken app behaviour; should become fixme). */
  brokenCartBadge: false,
  /** Products page shows a bot challenge instead of products. */
  captchaOnProducts: false,
  /** Delay in ms before the products list renders client-side. */
  slowProductsMs: 0,
});

const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const money = (n) => `$${n.toFixed(2)}`;

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeNext(value, fallback) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

export async function startFixtureApp(options = {}) {
  const flags = { ...DEFAULT_FLAGS, ...(options.flags ?? {}) };
  /** sid -> { user?: key, pendingMfa?: key }. Cart and shipping live in cookies, per browser context. */
  const sessions = new Map();
  let orderCounter = 1000;

  const app = Fastify({ logger: false });
  /** Every request as "METHOD /path", for tests that check what a crawler or agent did. */
  const requestLog = [];
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/__fixture")) requestLog.push(`${request.method} ${request.url}`);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.fixtureCookies?.length) reply.header("set-cookie", request.fixtureCookies);
    return payload;
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  function setCookie(request, cookie) {
    (request.fixtureCookies ??= []).push(cookie);
  }

  function session(request) {
    if (request.fixtureSession) return request.fixtureSession;
    const cookies = parseCookies(request.headers.cookie);
    let s = cookies.fixture_sid && sessions.get(cookies.fixture_sid);
    if (!s) {
      s = { id: randomBytes(16).toString("hex") };
      sessions.set(s.id, s);
      setCookie(request, `fixture_sid=${s.id}; Path=/; HttpOnly; SameSite=Lax`);
    }
    let cart = new Map();
    try {
      cart = new Map(Object.entries(JSON.parse(cookies.fixture_cart ?? "{}")).map(([k, v]) => [Number(k), Number(v)]));
    } catch {
      cart = new Map();
    }
    let shipping;
    try {
      shipping = cookies.fixture_shipping ? JSON.parse(cookies.fixture_shipping) : undefined;
    } catch {
      shipping = undefined;
    }
    request.fixtureSession = Object.assign(s, { cart, shipping, request });
    return request.fixtureSession;
  }

  function saveCart(s) {
    setCookie(s.request, `fixture_cart=${encodeURIComponent(JSON.stringify(Object.fromEntries(s.cart)))}; Path=/; SameSite=Lax`);
  }

  function saveShipping(s) {
    setCookie(s.request, `fixture_shipping=${encodeURIComponent(JSON.stringify(s.shipping ?? null))}; Path=/; SameSite=Lax`);
  }

  /** token -> user key, for the `api` login strategy (Authorization: Bearer <token> on every request). */
  const apiTokens = new Map();
  const bearerUser = (request) => {
    const auth = request?.headers?.authorization ?? "";
    return auth.startsWith("Bearer ") ? apiTokens.get(auth.slice(7)) : undefined;
  };
  const userOf = (s) => {
    const key = bearerUser(s.request) ?? s.user;
    return key ? FIXTURE_USERS[key] : undefined;
  };
  const cartCount = (s) => [...s.cart.values()].reduce((a, b) => a + b, 0);
  const cartTotal = (s) =>
    [...s.cart.entries()].reduce((sum, [id, qty]) => sum + FIXTURE_PRODUCTS.find((p) => p.id === id).price * qty, 0);
  const addLabel = () => (flags.renameAddToCart ? "Add to basket" : "Add to cart");

  function layout(s, title, body) {
    const user = userOf(s);
    const account = user
      ? `<a href="/account">Account</a> <a href="/logout">Log out</a>`
      : `<a href="/login">Log in</a>`;
    const admin = user?.role === "admin" ? ` <a href="/admin">Admin</a>` : "";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Fixture Shop</title>
<style>body{font-family:system-ui,sans-serif;margin:0}header{display:flex;gap:1rem;align-items:center;padding:.75rem 1rem;background:#eef}main{padding:1rem}li{margin:.5rem 0}.error{color:#a00}</style>
</head><body>
<header>
  <a href="/">Fixture Shop</a>
  <nav aria-label="Main"><a href="/products">Products</a> <a href="/cart">Cart <span data-testid="cart-count">${cartCount(s)}</span></a>${admin} ${account}</nav>
  <form role="search" action="/search" method="get"><label for="q">Search products</label> <input id="q" name="q"> <button type="submit">Search</button></form>
</header>
<main>${body}</main>
<script>
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-cart-action]");
  if (!button) return;
  event.preventDefault();
  const action = button.dataset.cartAction;
  const res = await fetch("/api/cart/" + action, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: Number(button.dataset.productId) }),
  });
  const data = await res.json();
  document.querySelector('[data-testid="cart-count"]').textContent = String(data.count);
  if (location.pathname === "/cart") { location.reload(); return; }
  if (action === "add") { button.dataset.cartAction = "remove"; button.textContent = "Remove"; }
  else { button.dataset.cartAction = "add"; button.textContent = button.dataset.addLabel; }
});
</script>
</body></html>`;
  }

  const cartButton = (s, p) =>
    s.cart.has(p.id)
      ? `<button type="button" data-cart-action="remove" data-product-id="${p.id}" data-add-label="${addLabel()}">Remove</button>`
      : `<button type="button" data-cart-action="add" data-product-id="${p.id}" data-add-label="${addLabel()}">${addLabel()}</button>`;

  const html = (reply, content, status = 200) => reply.code(status).type("text/html; charset=utf-8").send(content);

  function requireUser(request, reply, s) {
    if (userOf(s)) return true;
    reply.redirect(`/login?next=${encodeURIComponent(request.url)}`);
    return false;
  }

  // --- pages ---------------------------------------------------------------------------------
  app.get("/", (request, reply) => {
    const s = session(request);
    const featured = FIXTURE_PRODUCTS.slice(0, 3)
      .map((p) => `<li><a href="/products/${p.id}">${esc(p.name)}</a></li>`)
      .join("");
    html(reply, layout(s, "Home", `<h1>Welcome to Fixture Shop</h1><h2>Featured</h2><ul>${featured}</ul>
      <p><a href="/products?category=gear">Shop gear</a> <a href="/products?category=clothing">Shop clothing</a></p>`));
  });

  app.get("/login", (request, reply) => {
    const s = session(request);
    const next = safeNext(request.query.next, "/account");
    const error = request.query.error ? `<p role="alert" class="error">Invalid email or password</p>` : "";
    html(reply, layout(s, "Sign in", `<h1>Sign in</h1>${error}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${esc(next)}">
        <p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="username"></p>
        <p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="current-password"></p>
        <button type="submit">Sign in</button>
      </form>`));
  });

  app.post("/login", (request, reply) => {
    const s = session(request);
    const body = request.body ?? {};
    const next = safeNext(body.next, "/account");
    const key = Object.keys(FIXTURE_USERS).find(
      (k) => FIXTURE_USERS[k].email === body.email && FIXTURE_USERS[k].password === body.password,
    );
    if (!key) return reply.redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
    if (FIXTURE_USERS[key].totpSecret) {
      s.pendingMfa = key;
      s.user = undefined;
      return reply.redirect(`/login/mfa?next=${encodeURIComponent(next)}`);
    }
    s.user = key;
    return reply.redirect(next);
  });

  app.get("/login/mfa", (request, reply) => {
    const s = session(request);
    if (!s.pendingMfa) return reply.redirect("/login");
    const next = safeNext(request.query.next, "/account");
    const error = request.query.error ? `<p role="alert" class="error">That code is not valid</p>` : "";
    html(reply, layout(s, "Two-factor authentication", `<h1>Two-factor authentication</h1>${error}
      <form method="post" action="/login/mfa">
        <input type="hidden" name="next" value="${esc(next)}">
        <p><label for="code">Authentication code</label> <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"></p>
        <button type="submit">Verify</button>
      </form>`));
  });

  app.post("/login/mfa", (request, reply) => {
    const s = session(request);
    const body = request.body ?? {};
    const next = safeNext(body.next, "/account");
    const key = s.pendingMfa;
    if (!key) return reply.redirect("/login");
    let valid = false;
    try {
      valid = verifySync({
        secret: FIXTURE_USERS[key].totpSecret,
        token: String(body.code ?? "").trim(),
        guardrails,
        epochTolerance: 30,
      }).valid;
    } catch {
      valid = false;
    }
    if (!valid) return reply.redirect(`/login/mfa?error=1&next=${encodeURIComponent(next)}`);
    s.pendingMfa = undefined;
    s.user = key;
    return reply.redirect(next);
  });

  // JSON login for the `api` strategy: returns a bearer token, never sets a cookie.
  app.post("/api/login", (request, reply) => {
    const body = request.body ?? {};
    const key = Object.keys(FIXTURE_USERS).find(
      (k) => FIXTURE_USERS[k].email === body.email && FIXTURE_USERS[k].password === body.password,
    );
    if (!key) return reply.code(401).send({ error: "invalid email or password" });
    if (FIXTURE_USERS[key].totpSecret) {
      let valid = false;
      try {
        valid = verifySync({ secret: FIXTURE_USERS[key].totpSecret, token: String(body.code ?? "").trim(), guardrails, epochTolerance: 30 }).valid;
      } catch {
        valid = false;
      }
      if (!valid) return reply.code(401).send({ error: "a valid one-time code is required" });
    }
    const token = randomBytes(24).toString("hex");
    apiTokens.set(token, key);
    return reply.send({ token, name: FIXTURE_USERS[key].name });
  });

  app.get("/logout", (request, reply) => {
    const s = session(request);
    s.user = undefined;
    s.pendingMfa = undefined;
    reply.redirect("/login");
  });

  app.get("/account", (request, reply) => {
    const s = session(request);
    if (!requireUser(request, reply, s)) return;
    html(reply, layout(s, "Account", `<h1>Your account</h1><p>Signed in as ${esc(userOf(s).name)}</p>
      <p><a href="/account/orders">Order history</a></p>`));
  });

  app.get("/account/orders", (request, reply) => {
    const s = session(request);
    if (!requireUser(request, reply, s)) return;
    html(reply, layout(s, "Orders", `<h1>Order history</h1><p>You have no past orders.</p>`));
  });

  app.get("/admin", (request, reply) => {
    const s = session(request);
    if (!requireUser(request, reply, s)) return;
    if (userOf(s).role !== "admin") return html(reply, layout(s, "Forbidden", `<h1>Access denied</h1><p>You do not have access to this page.</p>`), 403);
    html(reply, layout(s, "Admin", `<h1>Admin dashboard</h1><p>${FIXTURE_PRODUCTS.length} products in the catalog.</p>`));
  });

  app.get("/products", (request, reply) => {
    const s = session(request);
    if (flags.captchaOnProducts) {
      return html(reply, `<!doctype html><html><head><title>Just a moment...</title></head><body>
        <h1>Verify you are human</h1><div class="g-recaptcha" data-sitekey="fixture"></div>
        <p>Please complete the security check to continue.</p></body></html>`, 403);
    }
    const category = typeof request.query.category === "string" ? request.query.category : undefined;
    const list = FIXTURE_PRODUCTS.filter((p) => !category || p.category === category);
    const items = list
      .map(
        (p) => `<li>
          <h2><a href="/products/${p.id}">${esc(p.name)}</a></h2>
          <p data-testid="product-price">${money(p.price)}</p>
          ${cartButton(s, p)}
        </li>`,
      )
      .join("");
    const listHtml = `<ul aria-label="Products">${items}</ul>`;
    const body = flags.slowProductsMs
      ? `<div id="slot"><p>Loading products...</p></div><template id="tpl">${listHtml}</template>
         <script>setTimeout(() => { document.getElementById("slot").replaceWith(document.getElementById("tpl").content.cloneNode(true)); }, ${Number(flags.slowProductsMs)});</script>`
      : listHtml;
    html(reply, layout(s, "Products", `<h1>Products</h1>
      <p><a href="/products">All</a> <a href="/products?category=gear">Gear</a> <a href="/products?category=clothing">Clothing</a></p>${body}`));
  });

  app.get("/products/:id", (request, reply) => {
    const s = session(request);
    const p = FIXTURE_PRODUCTS.find((x) => String(x.id) === request.params.id);
    if (!p) return html(reply, layout(s, "Not found", `<h1>Product not found</h1><p><a href="/products">Back to products</a></p>`), 404);
    html(reply, layout(s, p.name, `<h1>${esc(p.name)}</h1><p data-testid="product-price">${money(p.price)}</p>
      <p>${esc(p.description)}</p>${cartButton(s, p)}<p><a href="/products">Back to products</a></p>`));
  });

  app.get("/search", (request, reply) => {
    const s = session(request);
    const q = typeof request.query.q === "string" ? request.query.q.trim() : "";
    const hits = q ? FIXTURE_PRODUCTS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : [];
    const results = hits.length
      ? `<ul aria-label="Search results">${hits.map((p) => `<li><a href="/products/${p.id}">${esc(p.name)}</a> ${money(p.price)}</li>`).join("")}</ul>`
      : `<p>No products match "${esc(q)}".</p>`;
    html(reply, layout(s, "Search", `<h1>Search results</h1><p>${hits.length} result${hits.length === 1 ? "" : "s"} for "${esc(q)}"</p>${results}`));
  });

  app.get("/cart", (request, reply) => {
    const s = session(request);
    if (s.cart.size === 0) return html(reply, layout(s, "Cart", `<h1>Your cart</h1><p>Your cart is empty.</p><p><a href="/products">Continue shopping</a></p>`));
    const lines = [...s.cart.entries()]
      .map(([id, qty]) => {
        const p = FIXTURE_PRODUCTS.find((x) => x.id === id);
        return `<li><span>${esc(p.name)}</span> <span>Qty ${qty}</span> <span data-testid="line-price">${money(p.price * qty)}</span>
          <button type="button" data-cart-action="remove" data-product-id="${p.id}" data-add-label="${addLabel()}">Remove</button></li>`;
      })
      .join("");
    html(reply, layout(s, "Cart", `<h1>Your cart</h1><ul aria-label="Cart items">${lines}</ul>
      <p>Total: <span data-testid="cart-total">${money(cartTotal(s))}</span></p>
      <p><a href="/checkout">Checkout</a> <a href="/products">Continue shopping</a></p>`));
  });

  const SHIPPING_FIELDS = [
    ["fullName", "Full name"],
    ["address", "Address"],
    ["city", "City"],
    ["postalCode", "Postal code"],
  ];

  function checkoutForm(s, values = {}, errors = []) {
    const alert = errors.length ? `<div role="alert" class="error">${errors.map((e) => `<p>${esc(e)}</p>`).join("")}</div>` : "";
    const fields = SHIPPING_FIELDS.map(
      ([name, label]) => `<p><label for="${name}">${label}</label> <input id="${name}" name="${name}" value="${esc(values[name] ?? "")}"></p>`,
    ).join("");
    return layout(s, "Checkout", `<h1>Checkout</h1>${alert}<form method="post" action="/checkout">${fields}<button type="submit">Continue to review</button></form>`);
  }

  app.get("/checkout", (request, reply) => {
    const s = session(request);
    if (s.cart.size === 0) return reply.redirect("/cart");
    html(reply, checkoutForm(s, s.shipping));
  });

  app.post("/checkout", (request, reply) => {
    const s = session(request);
    if (s.cart.size === 0) return reply.redirect("/cart");
    const body = request.body ?? {};
    const errors = SHIPPING_FIELDS.filter(([name]) => !String(body[name] ?? "").trim()).map(([, label]) => `${label} is required`);
    if (errors.length) return html(reply, checkoutForm(s, body, errors), 422);
    s.shipping = Object.fromEntries(SHIPPING_FIELDS.map(([name]) => [name, String(body[name]).trim()]));
    saveShipping(s);
    reply.redirect("/checkout/review");
  });

  app.get("/checkout/review", (request, reply) => {
    const s = session(request);
    if (s.cart.size === 0) return reply.redirect("/cart");
    if (!s.shipping?.fullName) return reply.redirect("/checkout");
    const lines = [...s.cart.entries()]
      .map(([id, qty]) => `<li>${esc(FIXTURE_PRODUCTS.find((x) => x.id === id).name)} x ${qty}</li>`)
      .join("");
    html(reply, layout(s, "Review", `<h1>Review your order</h1><ul aria-label="Order items">${lines}</ul>
      <p>Total: <span data-testid="order-total">${money(cartTotal(s))}</span></p>
      <p>Ship to ${esc(s.shipping.fullName)}, ${esc(s.shipping.city)}</p>
      <form method="post" action="/checkout/place"><button type="submit">Place order</button></form>`));
  });

  // The fake final action: it never does anything real, but it is what agents must stop before.
  app.post("/checkout/place", (request, reply) => {
    const s = session(request);
    if (s.cart.size === 0) return reply.redirect("/cart");
    s.cart.clear();
    s.shipping = undefined;
    saveCart(s);
    saveShipping(s);
    orderCounter += 1;
    html(reply, layout(s, "Order placed", `<h1>Thank you for your order</h1><p>Order number FX-${orderCounter} (fake, nothing was charged).</p>`));
  });

  // --- JSON API used by the add-to-cart buttons ------------------------------------------------
  app.post("/api/cart/add", (request, reply) => {
    const s = session(request);
    const id = Number(request.body?.productId);
    if (!FIXTURE_PRODUCTS.some((p) => p.id === id)) return reply.code(400).send({ error: "unknown product" });
    if (!flags.brokenCartBadge) s.cart.set(id, (s.cart.get(id) ?? 0) + 1);
    saveCart(s);
    reply.send({ count: cartCount(s), total: cartTotal(s) });
  });

  app.post("/api/cart/remove", (request, reply) => {
    const s = session(request);
    s.cart.delete(Number(request.body?.productId));
    saveCart(s);
    reply.send({ count: cartCount(s), total: cartTotal(s) });
  });

  app.get("/api/cart", (request, reply) => {
    const s = session(request);
    reply.send({ count: cartCount(s), total: cartTotal(s), items: Object.fromEntries(s.cart) });
  });

  // --- test controls ---------------------------------------------------------------------------
  app.get("/__fixture/flags", (_request, reply) => reply.send(flags));
  app.post("/__fixture/flags", (request, reply) => {
    Object.assign(flags, request.body ?? {});
    reply.send(flags);
  });
  app.post("/__fixture/expire-sessions", (_request, reply) => {
    for (const s of sessions.values()) {
      s.user = undefined;
      s.pendingMfa = undefined;
    }
    apiTokens.clear();
    reply.send({ expired: sessions.size });
  });

  const address = await app.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? 0 });
  const port = new URL(address).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port: Number(port),
    app,
    flags,
    requestLog,
    setFlags(partial) {
      Object.assign(flags, partial);
    },
    resetFlags() {
      Object.assign(flags, DEFAULT_FLAGS);
    },
    expireSessions() {
      for (const s of sessions.values()) {
        s.user = undefined;
        s.pendingMfa = undefined;
      }
    apiTokens.clear();
    },
    close: () => app.close(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixtureApp({ port: Number(process.env.PORT ?? 4600) });
  console.log(`Fixture Shop listening on ${fixture.url}`);
  console.log(`  plain user: ${FIXTURE_USERS.plain.email} (password in test/fixture-app/server.mjs)`);
}
