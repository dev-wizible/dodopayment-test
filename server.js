import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// CORS configuration
const corsOptions = {
  origin: [
    "http://localhost:3001",
    "https://dodopayment-test.onrender.com",
    process.env.FRONTEND_URL,
  ].filter(Boolean), // Remove any undefined values
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
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

    // Debug: Log the full webhook data
    console.log("🔍 Webhook data:", JSON.stringify(event.data, null, 2));

    const subscriptionId = event.data?.subscription_id;

    if (!subscriptionId) {
      console.log("⚠️ Webhook missing subscription_id, acknowledging anyway");
      return res.status(200).json({ received: true });
    }

    switch (event.type) {
      case "subscription.created":
      case "subscription.active":
      case "subscription.renewed":
        console.log("✅ Activating/Renewing subscription:", subscriptionId);

        // Try to find user by session_id first, then by subscription_id
        let updateQuery = supabase.from("users").update({
          subscription_id: subscriptionId,
          is_premium: true,
          status: "active",
          next_billing_date: event.data.next_billing_date,
          cancel_at_billing_date: false,
          updated_at: new Date(),
        });

        // Try multiple ways to find the user
        const sessionId =
          event.data.checkout_session_id || event.data.session_id;
        const customerEmail = event.data.customer?.email;

        console.log("🔍 Trying to find user by session_id:", sessionId);
        console.log("🔍 Trying to find user by email:", customerEmail);

        // Try email first (most reliable)
        if (customerEmail) {
          console.log("🎯 Matching by email:", customerEmail);
          updateQuery = updateQuery.eq("email", customerEmail);
        } else if (sessionId) {
          console.log("🎯 Matching by session_id:", sessionId);
          updateQuery = updateQuery.eq("session_id", sessionId);
        } else {
          // Last resort: try subscription_id (for renewals)
          console.log("🎯 Matching by subscription_id:", subscriptionId);
          updateQuery = updateQuery.eq("subscription_id", subscriptionId);
        }

        const { error: activateError, data: updatedUsers } =
          await updateQuery.select();

        if (activateError) {
          console.error("❌ Failed to activate subscription:", activateError);
        } else if (updatedUsers && updatedUsers.length > 0) {
          console.log("✅ Successfully updated user:", updatedUsers[0].user_id);
        } else {
          console.log(
            "⚠️ No user found to update for subscription:",
            subscriptionId
          );

          // Debug: Let's see what users exist
          const { data: allUsers } = await supabase
            .from("users")
            .select("user_id, email, session_id, subscription_id")
            .limit(5);
          console.log(
            "🔍 Available users in database:",
            JSON.stringify(allUsers, null, 2)
          );
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

        // Try to find user by subscription_id first, then by session_id
        let paymentUpdateQuery = supabase.from("users").update({
          subscription_id: subscriptionId, // Ensure subscription_id is set
          is_premium: true,
          status: "active",
          next_billing_date: event.data.next_billing_date,
          updated_at: new Date(),
        });

        // Try to match by subscription_id first
        const { data: existingUser } = await supabase
          .from("users")
          .select("*")
          .eq("subscription_id", subscriptionId)
          .single();

        if (existingUser) {
          // Update existing user with subscription_id
          paymentUpdateQuery = paymentUpdateQuery.eq(
            "subscription_id",
            subscriptionId
          );
        } else {
          // Try multiple fallback methods to find the user
          const sessionId =
            event.data.checkout_session_id || event.data.session_id;
          const customerEmail = event.data.customer?.email;

          console.log("🔍 Trying to find user by session_id:", sessionId);
          console.log("🔍 Trying to find user by email:", customerEmail);

          if (sessionId) {
            paymentUpdateQuery = paymentUpdateQuery.eq("session_id", sessionId);
          } else if (customerEmail) {
            paymentUpdateQuery = paymentUpdateQuery.eq("email", customerEmail);
          } else {
            console.log("❌ No way to identify user - skipping payment update");
            break;
          }
        }

        const { error: paymentError, data: updatedPaymentUsers } =
          await paymentUpdateQuery.select();

        if (paymentError) {
          console.error("❌ Failed to update payment success:", paymentError);
        } else if (updatedPaymentUsers && updatedPaymentUsers.length > 0) {
          console.log(
            "✅ Successfully updated payment for user:",
            updatedPaymentUsers[0].user_id
          );
        } else {
          console.log(
            "⚠️ No user found to update payment for subscription:",
            subscriptionId
          );
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
