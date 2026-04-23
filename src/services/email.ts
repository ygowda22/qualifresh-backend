import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST   || "smtp.gmail.com",
  port:   Number(process.env.EMAIL_PORT) || 465,
  secure: true,// REQUIRED for port 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export async function sendOrderConfirmation(
  to: string,
  name: string,
  order: {
    orderNumber: string;
    items: { name: string; quantity: number; price: number }[];
    subtotal: number;
    deliveryCharge: number;
    total: number;
    deliverySlot: string;
    deliveryAddress: string;
  }
) {
  const itemsHtml = order.items
    .map(
      (i) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${i.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right">₹${i.price * i.quantity}</td>
        </tr>`
    )
    .join("");

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
      <div style="background:#1a3c2e;padding:24px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="color:#a3e635;margin:0;font-size:26px">QualiFresh</h1>
        <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:13px">Quality First</p>
      </div>
      <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <h2 style="color:#1a3c2e;margin:0 0 8px">Order Confirmed! 🎉</h2>
        <p style="color:#6b7280;margin:0 0 20px">Hi ${name}, your order has been received and will be prepared fresh for you.</p>

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin-bottom:20px">
          <strong style="color:#166534">Order #${order.orderNumber}</strong>
          &nbsp;·&nbsp;
          <span style="color:#4b7c5e">Delivery: ${order.deliverySlot}</span>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <thead>
            <tr style="background:#f0fdf4">
              <th style="padding:10px 12px;text-align:left;color:#374151;font-size:13px">Item</th>
              <th style="padding:10px 12px;text-align:center;color:#374151;font-size:13px">Qty</th>
              <th style="padding:10px 12px;text-align:right;color:#374151;font-size:13px">Amount</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>

        <div style="border-top:2px solid #f0fdf4;padding-top:12px">
          <div style="display:flex;justify-content:space-between;color:#6b7280;font-size:13px;margin-bottom:6px">
            <span>Subtotal</span><span>₹${order.subtotal}</span>
          </div>
          <div style="display:flex;justify-content:space-between;color:#6b7280;font-size:13px;margin-bottom:10px">
            <span>Delivery</span><span>${order.deliveryCharge === 0 ? "FREE 🎉" : "₹" + order.deliveryCharge}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;color:#1a3c2e">
            <span>Total</span><span>₹${order.total}</span>
          </div>
        </div>

        <div style="margin-top:20px;padding:14px;background:#f9fafb;border-radius:8px;font-size:13px;color:#4b5563">
          <strong>Delivery Address:</strong> ${order.deliveryAddress}
        </div>

        <p style="margin-top:24px;color:#6b7280;font-size:12px;text-align:center">
          Questions? WhatsApp us or email <a href="mailto:rohit@qualifresh.in" style="color:#2d8a4e">rohit@qualifresh.in</a>
        </p>
      </div>
    </div>`;

  await transporter.sendMail({
    from: `"QualiFresh" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Order Confirmed: #${order.orderNumber} — QualiFresh`,
    html,
  });
}

export async function sendAdminOrderNotification(order: {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  items: { name: string; quantity: number; price: number }[];
  total: number;
  deliveryAddress: string;
  deliverySlot: string;
  notes?: string;
}) {
  const itemsList = order.items
    .map((i) => `• ${i.name} × ${i.quantity} = ₹${i.price * i.quantity}`)
    .join("\n");

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1a3c2e">New Order: #${order.orderNumber}</h2>
      <p><strong>Customer:</strong> ${order.customerName}</p>
      <p><strong>Email:</strong> ${order.customerEmail}</p>
      <p><strong>Phone:</strong> ${order.customerPhone}</p>
      <p><strong>Delivery Slot:</strong> ${order.deliverySlot}</p>
      <p><strong>Address:</strong> ${order.deliveryAddress}</p>
      ${order.notes ? `<p><strong>Notes:</strong> ${order.notes}</p>` : ""}
      <h3>Items:</h3>
      <pre style="background:#f0fdf4;padding:12px;border-radius:6px">${itemsList}</pre>
      <h3>Total: ₹${order.total}</h3>
    </div>`;

  await transporter.sendMail({
    from: `"QualiFresh Orders" <${process.env.EMAIL_USER}>`,
    to: process.env.ADMIN_EMAIL || "rohit@qualifresh.in",
    subject: `🛒 New Order #${order.orderNumber} — ₹${order.total}`,
    html,
  });
}

export async function sendOrderStatusUpdate(
  to: string,
  name: string,
  order: {
    orderNumber: string;
    status: string;
    deliverySlot: string;
    total: number;
  }
) {
  const STATUS_LABELS: Record<string, string> = {
    pending:          "Pending",
    confirmed:        "Confirmed ✅",
    out_for_delivery: "Out for Delivery 🚚",
    delivered:        "Delivered 🎉",
    cancelled:        "Cancelled ❌",
  };
  const statusLabel = STATUS_LABELS[order.status] || order.status;

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
      <div style="background:#1a3c2e;padding:24px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="color:#a3e635;margin:0;font-size:26px">QualiFresh</h1>
        <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:13px">Order Update</p>
      </div>
      <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <h2 style="color:#1a3c2e;margin:0 0 8px">Order Status Updated</h2>
        <p style="color:#6b7280;margin:0 0 20px">Hi ${name}, your order status has been updated.</p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 18px;margin-bottom:20px">
          <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong style="color:#166534">Order #${order.orderNumber}</strong></div>
          <div style="font-size:22px;font-weight:700;color:#1a3c2e;margin-bottom:6px">${statusLabel}</div>
          <div style="font-size:13px;color:#4b7c5e">Delivery slot: ${order.deliverySlot}</div>
          <div style="font-size:13px;color:#4b7c5e;margin-top:4px">Order total: <strong>₹${order.total}</strong></div>
        </div>
        <p style="color:#6b7280;font-size:13px">
          Questions? WhatsApp us or email <a href="mailto:rohit@qualifresh.in" style="color:#2d8a4e">rohit@qualifresh.in</a>
        </p>
      </div>
    </div>`;

  await transporter.sendMail({
    from: `"QualiFresh" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Order #${order.orderNumber} — ${statusLabel} | QualiFresh`,
    html,
  });
}

export async function sendContactEmail(data: {
  name: string;
  email: string;
  phone: string;
  message: string;
}) {
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1a3c2e">New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${data.name}</p>
      <p><strong>Email:</strong> ${data.email}</p>
      <p><strong>Phone:</strong> ${data.phone}</p>
      <h3>Message:</h3>
      <p style="background:#f9fafb;padding:14px;border-radius:6px;white-space:pre-wrap">${data.message}</p>
    </div>`;

  await transporter.sendMail({
    from: `"QualiFresh Contact" <${process.env.EMAIL_USER}>`,
    to: process.env.ADMIN_EMAIL || "rohit@qualifresh.in",
    replyTo: data.email,
    subject: `Contact Form: ${data.name} — QualiFresh`,
    html,
  });
}
