import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// DodoPayments setup
const DODO_API_KEY = process.env.DODO_API_KEY;
const DODO_BASE_URL = process.env.DODO_BASE_URL;

// Automated subscription status checker
async function checkExpiredSubscriptions() {
  try {
    console.log("🔍 Checking for expired subscriptions...");

    const now = new Date();

    // Find subscriptions that should be expired
    const { data: expiredUsers, error } = await supabase
      .from("users")
      .select("*")
      .eq("cancel_at_billing_date", true)
      .eq("is_premium", true)
      .lte("next_billing_date", now.toISOString());

    if (error) {
      console.error("Error fetching expired subscriptions:", error);
      return;
    }

    if (expiredUsers && expiredUsers.length > 0) {
      console.log(`📅 Found ${expiredUsers.length} expired subscriptions`);

      for (const user of expiredUsers) {
        // Update user to free status
        const { error: updateError } = await supabase
          .from("users")
          .update({
            is_premium: false,
            status: "expired",
            updated_at: new Date(),
          })
          .eq("user_id", user.user_id);

        if (updateError) {
          console.error(
            `❌ Failed to expire user ${user.user_id}:`,
            updateError
          );
        } else {
          console.log(`✅ Expired subscription for user ${user.user_id}`);
        }
      }
    } else {
      console.log("✅ No expired subscriptions found");
    }
  } catch (error) {
    console.error("Error in checkExpiredSubscriptions:", error);
  }
}

// Run subscription checker every hour
setInterval(checkExpiredSubscriptions, 60 * 60 * 1000); // 1 hour
// Also run on startup
setTimeout(checkExpiredSubscriptions, 5000); // 5 seconds after startup

// Create subscription
app.post("/api/create-subscription", async (req, res) => {
  try {
    const { userId, email, name } = req.body;

    // Create checkout session
    const response = await fetch(`${DODO_BASE_URL}/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DODO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_cart: [
          {
            product_id: process.env.DODO_SUBSCRIPTION_PRODUCT_ID,
            quantity: 1,
          },
        ],
        customer: { name, email },
        return_url: process.env.FRONTEND_URL,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      // Save to Supabase
      await supabase.from("users").upsert({
        user_id: userId,
        email,
        name,
        session_id: data.session_id,
        created_at: new Date(),
      });

      res.json({
        success: true,
        checkout_url: data.checkout_url,
      });
    } else {
      res.status(400).json({ success: false, error: data });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user status
app.get("/api/user/:userId/status", async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user from Supabase
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (error || !user || !user.subscription_id) {
      return res.json({
        isPremium: false,
        status: "free",
        message: "No active subscription",
      });
    }

    // Check if subscription is still valid
    const now = new Date();
    const billingDate = new Date(user.next_billing_date);

    if (user.cancel_at_billing_date && billingDate <= now) {
      // Subscription expired, update to free
      await supabase
        .from("users")
        .update({ is_premium: false, status: "expired" })
        .eq("user_id", userId);

      return res.json({
        isPremium: false,
        status: "expired",
        message: "Subscription expired",
      });
    }

    res.json({
      isPremium: user.is_premium,
      status: user.status,
      message: user.cancel_at_billing_date
        ? `Premium until ${billingDate.toLocaleDateString()}`
        : `Next billing: ${billingDate.toLocaleDateString()}`,
      nextBillingDate: user.next_billing_date,
      cancelAtBillingDate: user.cancel_at_billing_date,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel subscription
app.post("/api/cancel-subscription", async (req, res) => {
  try {
    const { userId, subscriptionId } = req.body;

    if (!userId || !subscriptionId) {
      return res.status(400).json({
        success: false,
        error: "User ID and Subscription ID are required",
      });
    }

    // Get current user data to verify subscription ownership
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .eq("subscription_id", subscriptionId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        error: "Subscription not found or does not belong to user",
      });
    }

    // Cancel in DodoPayments - use correct parameter name
    const response = await fetch(
      `${DODO_BASE_URL}/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${DODO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cancel_at_next_billing_date: true,
        }),
      }
    );

    const data = await response.json();
    console.log("DodoPayments cancellation response:", data);

    if (response.ok) {
      // Update Supabase - keep premium but mark as cancelling
      const { error: updateError } = await supabase
        .from("users")
        .update({
          cancel_at_billing_date: true,
          status: "cancelling",
          updated_at: new Date(),
        })
        .eq("user_id", userId);

      if (updateError) {
        console.error("Database update error:", updateError);
        return res.status(500).json({
          success: false,
          error: "Failed to update subscription status in database",
        });
      }

      res.json({
        success: true,
        message: `Subscription will cancel at billing period end (${new Date(
          user.next_billing_date
        ).toLocaleDateString()})`,
        next_billing_date: user.next_billing_date,
      });
    } else {
      console.error("DodoPayments error:", data);
      res.status(400).json({
        success: false,
        error:
          data.message || "Failed to cancel subscription with DodoPayments",
      });
    }
  } catch (error) {
    console.error("Cancel subscription error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook
app.post("/api/webhooks/dodopayments", async (req, res) => {
  try {
    const event = req.body;
    console.log(
      "📨 Webhook received:",
      event.type,
      event.data?.subscription_id
    );

    const subscriptionId = event.data?.subscription_id;

    if (!subscriptionId) {
      console.log("⚠️ Webhook missing subscription_id, acknowledging anyway");
      return res.status(200).json({ received: true });
    }

    switch (event.type) {
      case "subscription.created":
      case "subscription.active":
        console.log("✅ Activating subscription:", subscriptionId);
        const { error: activateError } = await supabase
          .from("users")
          .update({
            subscription_id: subscriptionId,
            is_premium: true,
            status: "active",
            next_billing_date: event.data.next_billing_date,
            cancel_at_billing_date: false,
            updated_at: new Date(),
          })
          .eq("session_id", event.data.session_id);

        if (activateError) {
          console.error("❌ Failed to activate subscription:", activateError);
        }
        break;

      case "subscription.cancelled":
        console.log("🚫 Processing subscription cancellation:", subscriptionId);
        const now = new Date();
        const nextBilling = new Date(event.data.next_billing_date);

        const { error: cancelError } = await supabase
          .from("users")
          .update({
            is_premium: nextBilling > now, // Keep premium until billing date
            status: nextBilling > now ? "cancelled" : "expired",
            cancel_at_billing_date: nextBilling > now,
            updated_at: new Date(),
          })
          .eq("subscription_id", subscriptionId);

        if (cancelError) {
          console.error("❌ Failed to cancel subscription:", cancelError);
        }
        break;

      case "payment.succeeded":
        console.log("💳 Payment succeeded for subscription:", subscriptionId);
        const { error: paymentError } = await supabase
          .from("users")
          .update({
            is_premium: true,
            status: "active",
            next_billing_date: event.data.next_billing_date,
            updated_at: new Date(),
          })
          .eq("subscription_id", subscriptionId);

        if (paymentError) {
          console.error("❌ Failed to update payment success:", paymentError);
        }
        break;

      case "payment.failed":
        console.log("❌ Payment failed for subscription:", subscriptionId);
        const { error: failedError } = await supabase
          .from("users")
          .update({
            status: "payment_failed",
            updated_at: new Date(),
          })
          .eq("subscription_id", subscriptionId);

        if (failedError) {
          console.error("❌ Failed to update payment failure:", failedError);
        }
        break;

      default:
        console.log("ℹ️ Unhandled webhook event:", event.type);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Handle success redirect from DodoPayments
app.get("/success", async (req, res) => {
  const { subscription_id, status } = req.query;

  if (subscription_id && status === "active") {
    // Fetch subscription details from DodoPayments
    try {
      const response = await fetch(
        `${DODO_BASE_URL}/subscriptions/${subscription_id}`,
        {
          headers: { Authorization: `Bearer ${DODO_API_KEY}` },
        }
      );

      if (response.ok) {
        const subscription = await response.json();

        // Update Supabase with subscription details
        await supabase
          .from("users")
          .update({
            subscription_id: subscription_id,
            is_premium: true,
            status: "active",
            next_billing_date: subscription.next_billing_date,
            cancel_at_billing_date: false,
          })
          .eq("user_id", subscription.customer.customer_id) // Match by customer ID
          .or(`email.eq.${subscription.customer.email}`); // Or by email

        console.log("✅ Subscription activated:", subscription_id);
      }
    } catch (error) {
      console.error("Error updating subscription:", error);
    }
  }

  // Redirect to success page
  const baseUrl =
    process.env.FRONTEND_URL || "https://dodopayment-test.onrender.com";
  res.redirect(
    `${baseUrl}/success.html?subscription_id=${subscription_id}&status=${status}`
  );
});

// Serve static files (if you put index.html in a 'public' folder)
app.use(express.static("public"));

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `✅ Success redirect: ${
      process.env.FRONTEND_URL || `http://localhost:${PORT}`
    }/success`
  );
});
