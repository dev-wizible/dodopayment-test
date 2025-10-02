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
  ].filter(Boolean),
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
    console.log("Checking for expired subscriptions...");

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
      console.log(`Found ${expiredUsers.length} expired subscriptions`);

      for (const user of expiredUsers) {
        const { error: updateError } = await supabase
          .from("users")
          .update({
            is_premium: false,
            status: "expired",
            updated_at: new Date(),
          })
          .eq("user_id", user.user_id);

        if (updateError) {
          console.error(`Failed to expire user ${user.user_id}:`, updateError);
        } else {
          console.log(`Expired subscription for user ${user.user_id}`);
        }
      }
    } else {
      console.log("No expired subscriptions found");
    }
  } catch (error) {
    console.error("Error in checkExpiredSubscriptions:", error);
  }
}

// Run subscription checker every hour
setInterval(checkExpiredSubscriptions, 60 * 60 * 1000);
setTimeout(checkExpiredSubscriptions, 5000);

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
        return_url: `${
          process.env.FRONTEND_URL || "http://localhost:3001"
        }/success`,
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
        updated_at: new Date(),
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
        .update({
          is_premium: false,
          status: "expired",
          updated_at: new Date(),
        })
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

// Request cancellation (sends email to admin)
app.post("/api/request-cancellation", async (req, res) => {
  try {
    const { userId, subscriptionId, email, name } = req.body;

    if (!userId || !subscriptionId) {
      return res.status(400).json({
        success: false,
        error: "User ID and Subscription ID are required",
      });
    }

    // Get current user data
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // Mark as cancellation requested in database
    await supabase
      .from("users")
      .update({
        status: "cancellation_requested",
        updated_at: new Date(),
      })
      .eq("user_id", userId);

    // TODO: Send email to admin (you can integrate with SendGrid, Nodemailer, etc.)
    console.log(`📧 CANCELLATION REQUEST:
    User: ${name} (${email})
    User ID: ${userId}
    Subscription ID: ${subscriptionId}
    
    ACTION REQUIRED: Please cancel this subscription in DodoPayments dashboard.`);

    res.json({
      success: true,
      message:
        "Cancellation request submitted. You will receive an email confirmation and keep premium access until your next billing date.",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// Simple webhook - just sync DodoPayments status
app.post("/api/webhooks/dodopayments", async (req, res) => {
  try {
    const event = req.body;
    console.log("Webhook:", event.type, event.data?.subscription_id);

    const subscriptionId = event.data?.subscription_id;
    const customerEmail = event.data?.customer?.email;
    const dodoStatus = event.data?.status; // DodoPayments official status

    if (!subscriptionId || !customerEmail) {
      return res.status(200).json({ received: true });
    }

    // Simple logic: Use DodoPayments status directly
    let isPremium = false;
    let dbStatus = "free";

    switch (dodoStatus) {
      case "active":
        isPremium = true;
        dbStatus = "active";
        break;
      case "cancelled":
        // Check if still in grace period
        const nextBilling = new Date(event.data.next_billing_date);
        const now = new Date();
        isPremium = nextBilling > now;
        dbStatus = isPremium ? "cancelling" : "expired";
        break;
      case "expired":
      case "paused":
        isPremium = false;
        dbStatus = "expired";
        break;
    }

    console.log(
      `Updating user: ${customerEmail} -> ${dbStatus} (premium: ${isPremium})`
    );

    // Update database with DodoPayments status
    await supabase
      .from("users")
      .update({
        subscription_id: subscriptionId,
        is_premium: isPremium,
        status: dbStatus,
        next_billing_date: event.data.next_billing_date,
        cancel_at_billing_date: dodoStatus === "cancelled",
        updated_at: new Date(),
      })
      .eq("email", customerEmail);

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Handle success redirect
app.get("/success", async (req, res) => {
  const { subscription_id, status } = req.query;

  console.log("Success redirect:", { subscription_id, status });

  if (subscription_id && status === "active") {
    try {
      const response = await fetch(
        `${DODO_BASE_URL}/subscriptions/${subscription_id}`,
        {
          headers: { Authorization: `Bearer ${DODO_API_KEY}` },
        }
      );

      if (response.ok) {
        const subscription = await response.json();
        const customerEmail = subscription.customer?.email;

        if (customerEmail) {
          await supabase
            .from("users")
            .update({
              subscription_id: subscription_id,
              is_premium: true,
              status: "active",
              next_billing_date: subscription.next_billing_date,
              cancel_at_billing_date: false,
              updated_at: new Date(),
            })
            .eq("email", customerEmail);

          console.log("Subscription activated via redirect:", subscription_id);
        }
      }
    } catch (error) {
      console.error("Error in success redirect:", error);
    }
  }

  // Redirect to frontend
  const baseUrl = process.env.FRONTEND_URL || "http://localhost:3001";
  res.redirect(
    `${baseUrl}/success.html?subscription_id=${subscription_id}&status=${status}`
  );
});

// Serve static files
app.use(express.static("public"));

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `Frontend URL: ${process.env.FRONTEND_URL || `http://localhost:${PORT}`}`
  );
});
