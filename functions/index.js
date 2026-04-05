const functions = require("firebase-functions");
const admin = require("firebase-admin");
const https = require("https");

admin.initializeApp();
const db = admin.firestore();

// MSG91 config
const MSG91_AUTH_KEY = "493471A8DVB9KDG698b5d93P1";
const MSG91_TEMPLATE_ID = "nosh_order_confirmation";
// Using existing Nosh WhatsApp number

/**
 * Send WhatsApp message via MSG91
 */
function sendWhatsApp(phone, templateId, variables) {
  return new Promise((resolve, reject) => {
    // Ensure phone has 91 prefix, no +
    let cleanPhone = phone.replace(/[^0-9]/g, "");
    if (cleanPhone.length === 10) cleanPhone = "91" + cleanPhone;
    if (cleanPhone.startsWith("+")) cleanPhone = cleanPhone.substring(1);

    const payload = JSON.stringify({
      integrated_number: "15558535556", // Nosh WhatsApp number
      content_type: "template",
      payload: {
        to: cleanPhone,
        type: "template",
        template: {
          name: templateId,
          namespace: "", // MSG91 fills this
          language: {
            code: "en",
            policy: "deterministic",
          },
          components: [
            {
              type: "body",
              parameters: variables.map((v) => ({
                type: "text",
                text: String(v),
              })),
            },
          ],
        },
      },
    });

    const options = {
      hostname: "api.msg91.com",
      port: 443,
      path: "/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: MSG91_AUTH_KEY,
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        console.log(`MSG91 response: ${res.statusCode} - ${data}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`MSG91 error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Format items list with modifiers in brackets
 * e.g. "1× Paneer Tikka\n1× Old Monk (60ml)\n1× Pizza (Extra Cheese, Jalapenos)"
 */
function formatItemsList(items) {
  return items
    .map((item) => {
      let line = `${item.qty}× ${item.name}`;
      const mods = (item.modifiers || []).map((m) => m.option).filter(Boolean);
      if (mods.length > 0) {
        line += ` (${mods.join(", ")})`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Cloud Function: Send WhatsApp order confirmation
 * Triggers when a new order is created in qr_orders
 */
exports.sendOrderConfirmation = functions
  .region("asia-south1")
  .firestore.document("qr_orders/{orderId}")
  .onCreate(async (snap, context) => {
    const order = snap.data();

    // Skip if no customer phone
    if (!order.customerPhone) {
      console.log("No customer phone, skipping WhatsApp");
      return null;
    }

    try {
      // Check if WhatsApp confirmation is enabled
      const settingsDoc = await db
        .collection("qr_settings")
        .doc("config")
        .get();
      if (!settingsDoc.exists || !settingsDoc.data().waOrderConfirmation) {
        console.log("WhatsApp order confirmation is disabled, skipping");
        return null;
      }

      // Format items list
      const itemsList = formatItemsList(order.items || []);

      // Template variables:
      // {{1}} = Order number
      // {{2}} = Outlet name
      // {{3}} = Table name/number
      // {{4}} = Items list
      const variables = [
        String(order.orderNumber || ""),
        order.outletName || "Restaurant",
        order.tableName || `Table ${order.tableNumber || ""}`,
        itemsList,
      ];

      console.log(
        `Sending order confirmation to ${order.customerPhone}: Order #${order.orderNumber}`
      );
      await sendWhatsApp(
        order.customerPhone,
        MSG91_TEMPLATE_ID,
        variables
      );
      console.log("WhatsApp order confirmation sent successfully");

      // Mark order as WhatsApp sent
      await snap.ref.update({ waConfirmationSent: true });

      return null;
    } catch (error) {
      console.error("Error sending WhatsApp confirmation:", error);
      // Don't throw — we don't want to retry on WhatsApp failures
      return null;
    }
  });
