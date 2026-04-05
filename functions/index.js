const functions = require("firebase-functions");
const admin = require("firebase-admin");
const https = require("https");

admin.initializeApp();
const db = admin.firestore();

// MSG91 config
const MSG91_AUTH_KEY = "493471A8DVB9KDG698b5d93P1";
const MSG91_TEMPLATE_ID = "nosh_order_confirmation";
const INTEGRATED_NUMBER = "15558535556";

/**
 * Send WhatsApp message via MSG91
 */
function sendWhatsApp(phone, templateId, variables) {
  return new Promise((resolve, reject) => {
    let cleanPhone = phone.replace(/[^0-9]/g, "");
    if (cleanPhone.length === 10) cleanPhone = "91" + cleanPhone;

    // Build components: body_1, body_2, body_3, body_4
    const components = {};
    variables.forEach((val, idx) => {
      components["body_" + (idx + 1)] = {
        type: "text",
        value: String(val),
      };
    });

    const payload = JSON.stringify({
      integrated_number: INTEGRATED_NUMBER,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: templateId,
          language: {
            code: "en",
            policy: "deterministic",
          },
          to_and_components: [
            {
              to: [cleanPhone],
              components: components,
            },
          ],
        },
      },
    });

    console.log("MSG91 payload:", payload);

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
        console.log("MSG91 response:", res.statusCode, data);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error("MSG91 error: " + res.statusCode + " - " + data));
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
 */
function formatItemsList(items) {
  return items
    .map((item) => {
      let line = item.qty + "× " + item.name;
      const mods = (item.modifiers || []).map((m) => m.option).filter(Boolean);
      if (mods.length > 0) {
        line += " (" + mods.join(", ") + ")";
      }
      return line;
    })
    .join(", ");
}

/**
 * Cloud Function: Send WhatsApp order confirmation
 */
exports.sendOrderConfirmation = functions
  .region("asia-south1")
  .firestore.document("qr_orders/{orderId}")
  .onCreate(async (snap, context) => {
    const order = snap.data();

    if (!order.customerPhone) {
      console.log("No customer phone, skipping WhatsApp");
      return null;
    }

    try {
      const settingsDoc = await db.collection("qr_settings").doc("config").get();
      if (!settingsDoc.exists || !settingsDoc.data().waOrderConfirmation) {
        console.log("WhatsApp order confirmation is disabled, skipping");
        return null;
      }

      const itemsList = formatItemsList(order.items || []);

      const variables = [
        String(order.orderNumber || ""),
        order.outletName || "Restaurant",
        order.tableName || "Table " + (order.tableNumber || ""),
        itemsList,
      ];

      console.log("Sending order confirmation to " + order.customerPhone + ": Order #" + order.orderNumber);
      await sendWhatsApp(order.customerPhone, MSG91_TEMPLATE_ID, variables);
      console.log("WhatsApp order confirmation sent successfully");

      await snap.ref.update({ waConfirmationSent: true });
      return null;
    } catch (error) {
      console.error("Error sending WhatsApp confirmation:", error);
      return null;
    }
  });
