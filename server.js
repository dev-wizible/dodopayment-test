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

// Helper: Fetch subscription from DodoPayments and update DB
async function syncSubscriptionFromDodo(subscriptionId, email) {
  try {
    console.log(`🔄 Syncing subscription ${subscriptionId} for ${email}`);

    const response = await fetch(
      `${DODO_BASE_URL}/subscriptions/${subscriptionId}`,
      {
        headers: {
          Authorization: `Bearer ${DODO_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error("Failed to fetch from DodoPayments");
      return null;
    }

    const subscription = await response.json();
    const dodoStatus = subscription.status;
    const cancelAtNext = subscription.cancel_at_next_billing_date;
    const nextBilling = new Date(subscription.next_billing_date);
    const now = new Date();

    // Determine user status based on DodoPayments response
    let isPremium = false;
    let dbStatus = "free";

    // Scenario 1: Active subscription
    if (dodoStatus === "active" && !cancelAtNext) {
      isPremium = true;
      dbStatus = "active";
      console.log("✅ Status: ACTIVE - Full premium access");
    }
    // Scenario 2: Cancelling (grace period)
    else if (dodoStatus === "active" && cancelAtNext) {
      // Check if still in grace period
      isPremium = nextBilling > now;
      dbStatus = isPremium ? "cancelling" : "expired";
      console.log(
        `⚠️ Status: CANCELLING - Premium until ${nextBilling.toLocaleDateString()}`
      );
    }
    // Scenario 3: Cancelled immediately
    else if (dodoStatus === "cancelled") {
      isPremium = false;
      dbStatus = "expired";
      console.log("❌ Status: CANCELLED - No premium access");
    }
    // Other statuses (pending, paused, etc.)
    else {
      isPremium = false;
      dbStatus = dodoStatus || "free";
      console.log(`📊 Status: ${dodoStatus.toUpperCase()}`);
    }

    console.log(`Final: ${email} → ${dbStatus} (premium: ${isPremium})`);

    // Update database
    const { data, error } = await supabase
      .from("users")
      .update({
        subscription_id: subscriptionId,
        is_premium: isPremium,
        status: dbStatus,
        next_billing_date: subscription.next_billing_date,
        cancel_at_billing_date: cancelAtNext,
        updated_at: new Date(),
      })
      .eq("email", email)
      .select();

    if (error) {
      console.error("Database update error:", error);
      return null;
    }

    // Return both DB data and full DodoPayments response
    return {
      user: data[0],
      dodoPaymentsResponse: subscription,
    };
  } catch (error) {
    console.error("Sync error:", error);
    return null;
  }
}

// Auto-check subscriptions that passed billing date
async function checkBillingDatePassed() {
  try {
    console.log("⏰ Checking for subscriptions past billing date...");

    const now = new Date();

    // Find users with billing date in the past
    const { data: users, error } = await supabase
      .from("users")
      .select("*")
      .not("subscription_id", "is", null)
      .lte("next_billing_date", now.toISOString());

    if (error) {
      console.error("Error fetching users:", error);
      return;
    }

    if (users && users.length > 0) {
      console.log(`Found ${users.length} subscriptions to check`);

      for (const user of users) {
        await syncSubscriptionFromDodo(user.subscription_id, user.email);
        // Wait 500ms between requests to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } else {
      console.log("No subscriptions need checking");
    }
  } catch (error) {
    console.error("Error in checkBillingDatePassed:", error);
  }
}

// Run billing date checker every 15 minutes
setInterval(checkBillingDatePassed, 15 * 60 * 1000);
// Run on startup after 5 seconds
setTimeout(checkBillingDatePassed, 5000);

// Create subscription
app.post("/api/create-subscription", async (req, res) => {
  try {
    const { userId, email, name, productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        error: "Product ID is required",
      });
    }

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
            product_id: productId,
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
        product_id: productId,
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

// Get user status (with auto-sync if needed)
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
        subscription: null,
        message: "No active subscription",
      });
    }

    // Check if billing date passed - if yes, sync from DodoPayments
    const now = new Date();
    const billingDate = new Date(user.next_billing_date);

    if (billingDate <= now) {
      console.log(`🔄 Billing date passed for ${user.email}, syncing...`);
      const synced = await syncSubscriptionFromDodo(
        user.subscription_id,
        user.email
      );

      if (synced) {
        // Return ORIGINAL DodoPayments response
        return res.json({
          subscription: synced.dodoPaymentsResponse,
          synced: true,
          message: "Subscription synced from DodoPayments",
        });
      }
    }

    // Fetch current status from DodoPayments (always return fresh data)
    const response = await fetch(
      `${DODO_BASE_URL}/subscriptions/${user.subscription_id}`,
      {
        headers: {
          Authorization: `Bearer ${DODO_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      return res.status(400).json({
        subscription: null,
        error: "Failed to fetch subscription",
      });
    }

    const subscription = await response.json();

    // Return ORIGINAL DodoPayments response
    res.json({
      subscription: subscription,
      synced: false,
      message: "Current subscription status",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual sync endpoint (for admin use)
app.post("/api/sync-subscription/:subscriptionId", async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email required for sync",
      });
    }

    console.log(`🔄 Manual sync requested for: ${subscriptionId}`);

    const synced = await syncSubscriptionFromDodo(subscriptionId, email);

    if (!synced) {
      return res.status(400).json({
        success: false,
        error: "Failed to sync subscription",
      });
    }

    res.json({
      success: true,
      message: `Subscription synced: ${synced.user.status}`,
      subscription: synced.dodoPaymentsResponse,
    });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook - auto-sync when you cancel from dashboard
app.post("/api/webhooks/dodopayments", async (req, res) => {
  try {
    const event = req.body;

    console.log("=== WEBHOOK RECEIVED ===");
    console.log("Event Type:", event.type);
    console.log("Subscription ID:", event.data?.subscription_id);
    console.log("Customer Email:", event.data?.customer?.email);
    console.log("Status:", event.data?.status);
    console.log("======================");

    const subscriptionId = event.data?.subscription_id;
    const customerEmail = event.data?.customer?.email;

    if (!subscriptionId || !customerEmail) {
      return res.status(200).json({ received: true });
    }

    // Sync from DodoPayments
    await syncSubscriptionFromDodo(subscriptionId, customerEmail);

    res.status(200).json({ received: true, synced: true });
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
          await syncSubscriptionFromDodo(subscription_id, customerEmail);
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