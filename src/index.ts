import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";
import { sendLowStockAlert, LowStockItem } from "./utils/mailer";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI as string;

// Lazy JWKS initialization — created on first use so module load
// doesn't crash when CLIENT_URL env var is missing.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));
  }
  return _jwks;
}

const verifyToken = async (req: Request, res: Response, next: Function) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send("Unauthorized")
  };
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send("Unauthorized")
  }
  try {
    const { payload } = await jwtVerify(token, getJWKS());
    (req as any).userid = payload;
    next();
  } catch (error) {
    return res.status(401).send("Unauthorized")
  }
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req: Request, res: Response) => {
  res.send("PizzaPoint Server is running! 🚀");
});

const db = client.db("pizzapoint-db");
const usersCollection = db.collection("user");
const pizzaCollection = db.collection("pizza");
const cartCollection = db.collection("cart");
const ordersCollection = db.collection("orders");
const inventoryCollection = db.collection("inventory");
const settingsCollection = db.collection("settings");

let settingsInitPromise: Promise<void> | null = null;
async function ensureDefaultSettings() {
  if (!settingsInitPromise) {
    settingsInitPromise = (async () => {
      try {
        const existingSettings = await settingsCollection.findOne({ key: "global" });
        if (!existingSettings) {
          await settingsCollection.insertOne({ key: "global", freeDeliveryThreshold: 1500, deliveryFee: 60, updatedAt: new Date() });
        }
      } catch (e) {
        console.error("Failed to initialize default settings:", e);
        settingsInitPromise = null;
      }
    })();
  }
  return settingsInitPromise;
}

async function checkAndNotifyLowStock(database: any) {
  try {
    const invColl = database.collection("inventory");
    const usrColl = database.collection("user");

    const allItems = await invColl.find({}).toArray();
    const lowStockItemsToNotify: LowStockItem[] = [];

    for (const item of allItems) {
      const qty = Number(item.quantity) || 0;
      const minThreshold = Number(item.minThreshold) || 10;

      if (qty <= minThreshold) {
        if (!item.lowStockAlertSent) {
          lowStockItemsToNotify.push({
            _id: item._id,
            name: item.name,
            quantity: qty,
            minThreshold: minThreshold,
            unit: item.unit,
            category: item.category,
          });
        }
      } else {
        // Reset flag if restocked above minThreshold
        if (item.lowStockAlertSent) {
          await invColl.updateOne(
            { _id: item._id },
            { $set: { lowStockAlertSent: false } }
          );
        }
      }
    }

    if (lowStockItemsToNotify.length === 0) {
      return { notified: false, itemsCount: 0 };
    }

    // Query admin emails from DB
    const adminUsers = await usrColl.find({
      role: { $regex: /^admin$/i }
    }).toArray();

    const adminEmails = new Set<string>();
    for (const u of adminUsers) {
      if (u.email && typeof u.email === "string") {
        adminEmails.add(u.email);
      }
    }

    if (process.env.ADMIN_EMAIL) {
      adminEmails.add(process.env.ADMIN_EMAIL);
    }

    const emailList = Array.from(adminEmails);

    if (emailList.length === 0) {
      console.warn("[LowStockCheck] Low stock items detected but no admin emails found.");
      return { notified: false, itemsCount: lowStockItemsToNotify.length, reason: "No admin emails" };
    }

    await sendLowStockAlert(emailList, lowStockItemsToNotify);

    const notifiedIds = lowStockItemsToNotify.map((i) => i._id);
    await invColl.updateMany(
      { _id: { $in: notifiedIds } },
      { $set: { lowStockAlertSent: true, lowStockAlertSentAt: new Date() } }
    );

    return { notified: true, itemsCount: lowStockItemsToNotify.length, recipients: emailList };
  } catch (error) {
    console.error("Error in checkAndNotifyLowStock:", error);
    return { notified: false, error };
  }
}

// ==========================================
// Settings Endpoints (admin-configurable)
// ==========================================
app.get('/api/settings', async (req: Request, res: Response) => {
  try {
    await ensureDefaultSettings();
    const settings = await settingsCollection.findOne({ key: "global" });
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to fetch settings" });
  }
});

app.patch('/api/settings', verifyToken, async (req: Request, res: Response) => {
  try {
    await ensureDefaultSettings();
    const updates = req.body;
    delete updates._id;
    delete updates.key;
    const result = await settingsCollection.updateOne(
      { key: "global" },
      { $set: { ...updates, updatedAt: new Date() } },
      { upsert: true }
    );
    return res.json({ success: true, message: "Settings updated successfully", result });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to update settings" });
  }
});

    // Inventory / Pizza Making Items Endpoints
    app.get('/api/inventory', async (req: Request, res: Response) => {
      try {
        const { q, category, status } = req.query;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 8;
        const skip = (page - 1) * limit;

        const query: Record<string, any> = {};
        if (q) {
          query.name = { $regex: q as string, $options: 'i' };
        }
        if (category && category !== 'all') {
          query.category = { $regex: new RegExp(`^${category}$`, 'i') };
        }
        if (status === 'low') {
          query.$expr = { $lte: ["$quantity", "$minThreshold"] };
        } else if (status === 'instock') {
          query.$expr = { $gt: ["$quantity", "$minThreshold"] };
        }

        const items = await inventoryCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .toArray();

        const totalItems = await inventoryCollection.countDocuments(query);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        return res.json({
          success: true,
          data: items,
          pagination: {
            totalItems,
            totalPages,
            currentPage: page,
            limit,
          },
        });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to fetch inventory" });
      }
    });

    app.get('/api/inventory/all', async (req: Request, res: Response) => {
      try {
        const items = await inventoryCollection.find({}).toArray();
        return res.json({ success: true, data: items });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to fetch inventory" });
      }
    });

    app.post('/api/inventory/add', verifyToken, async (req: Request, res: Response) => {
      try {
        const item = req.body;
        const newItem = {
          ...item,
          quantity: Number(item.quantity) || 0,
          minThreshold: Number(item.minThreshold) || 10,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        const result = await inventoryCollection.insertOne(newItem);
        checkAndNotifyLowStock(db).catch(err => console.error("Low stock check error (add):", err));
        return res.status(201).json({ success: true, message: "Ingredient added successfully", result });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to add ingredient" });
      }
    });

    app.delete('/api/inventory/:id', verifyToken, async (req: Request, res: Response) => {
      try {
        const id = req.params.id as string;
        const result = await inventoryCollection.deleteOne({ _id: new ObjectId(id) });
        return res.json({ success: true, message: "Ingredient deleted successfully", result });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to delete ingredient" });
      }
    });

    app.patch('/api/inventory/:id', verifyToken, async (req: Request, res: Response) => {
      try {
        const id = req.params.id as string;
        const updateData = req.body;
        const result = await inventoryCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { ...updateData, updatedAt: new Date() } }
        );
        checkAndNotifyLowStock(db).catch(err => console.error("Low stock check error (patch):", err));
        return res.json({ success: true, message: "Ingredient updated successfully", result });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to update ingredient" });
      }
    });

    // Endpoint to manually trigger a low stock check and notify admins
    app.post('/api/inventory/check-low-stock', async (req: Request, res: Response) => {
      try {
        const status = await checkAndNotifyLowStock(db);
        return res.json({ success: true, status });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to run low stock check" });
      }
    });

    // Builder items — return inventory grouped by category for the pizza builder
    app.get('/api/inventory/builder-items', async (req: Request, res: Response) => {
      try {
        const items = await inventoryCollection.find({}).toArray();
        // Group by category
        const grouped: Record<string, any[]> = {};
        for (const item of items) {
          const cat = (item.category || 'other').toLowerCase();
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push({
            id: String(item._id),
            label: item.name,
            quantity: item.quantity || 0,
            unit: item.unit || '',
            price: item.price || 0,
            inStock: (item.quantity || 0) > 0,
          });
        }
        return res.json({ success: true, data: grouped });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to fetch builder items" });
      }
    });

    // Order endpoints
    app.post('/api/orders', verifyToken, async (req: Request, res: Response) => {
      try {
        const orderData = req.body;
        const decodedToken = (req as any).userid;
        const userId = decodedToken?.sub || orderData.userId;

        if (!userId) {
          return res.status(400).json({ error: "User ID is required" });
        }

        // Fetch user's cart to get full item details (including customIngredients and pizzaId)
        const cart = await cartCollection.findOne({ userId });
        if (!cart || !cart.items || cart.items.length === 0) {
          return res.status(400).json({ error: "Cart is empty or not found. Cannot create order." });
        }

        const newOrder = {
          ...orderData,
          userId,
          items: cart.items, // Use the full items from cart, overriding the simplified Stripe items
          status: orderData.status || "Paid",
          deliveryStatus: orderData.deliveryStatus || "Cooking",
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // Inventory Deduction
        const sizeMultipliers: Record<string, number> = {
          'Small': 1,
          'Medium': 1.25,
          'Large': 1.5
        };

        for (const item of cart.items) {
          const multiplier = sizeMultipliers[item.size] || 1;
          const totalQtyMultiplier = item.quantity * multiplier;

          let ingredientsToDeduct: any[] = [];

          if (item.pizzaId && String(item.pizzaId).startsWith('custom-')) {
            // Custom pizza: ingredients are stored directly in the cart item
            if (item.customIngredients && Array.isArray(item.customIngredients)) {
              ingredientsToDeduct = item.customIngredients;
            }
          } else if (item.pizzaId) {
            // Standard pizza: fetch the recipe from pizzaCollection
            let pid = item.pizzaId;
            if (ObjectId.isValid(pid)) {
              const pizza = await pizzaCollection.findOne({ _id: new ObjectId(pid) });
              if (pizza && pizza.ingredients && Array.isArray(pizza.ingredients)) {
                ingredientsToDeduct = pizza.ingredients;
              }
            }
          }

          // Deduct each ingredient
          for (const ing of ingredientsToDeduct) {
            if (ing.inventoryId && ObjectId.isValid(ing.inventoryId)) {
              const deductAmount = (Number(ing.quantityUsed) || 1) * totalQtyMultiplier;
              await inventoryCollection.updateOne(
                { _id: new ObjectId(ing.inventoryId) },
                { $inc: { quantity: -deductAmount } }
              );
            }
          }
        }

        const result = await ordersCollection.insertOne(newOrder);

        // Clear the cart after successful order creation
        await cartCollection.deleteOne({ userId });

        // Trigger low stock alert check after inventory deduction
        checkAndNotifyLowStock(db).catch(err => console.error("Low stock check error (order):", err));

        return res.status(201).json({ success: true, message: "Order created successfully", orderId: result.insertedId, result });
      } catch (error) {
        console.error("Create Order Error:", error);
        return res.status(500).json({ success: false, error: "Failed to create order" });
      }
    });

    // Update order delivery status
    app.patch('/api/orders/status/:id', verifyToken, async (req: Request, res: Response) => {
      try {
        const id = req.params.id as string;
        const { deliveryStatus } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, error: "Invalid order ID" });
        }

        const existingOrder = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!existingOrder) {
          return res.status(404).json({ success: false, error: "Order not found" });
        }

        const getStatusRank = (st?: string) => {
          const norm = (st || '').toLowerCase().trim();
          if (norm === 'delivered') return 3;
          if (norm === 'on delivery' || norm === 'delivering' || norm === 'delivery') return 2;
          return 1; // Default to Cooking
        };

        const currentRank = getStatusRank(existingOrder.deliveryStatus);
        const newRank = getStatusRank(deliveryStatus);

        if (newRank < currentRank) {
          return res.status(400).json({
            success: false,
            error: `Cannot revert delivery status backwards from "${existingOrder.deliveryStatus || 'Cooking'}" to "${deliveryStatus}"`
          });
        }

        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { deliveryStatus, updatedAt: new Date() } }
        );
        return res.json({ success: true, message: "Delivery status updated successfully", result });
      } catch (error) {
        console.error("Update Order Status Error:", error);
        return res.status(500).json({ success: false, error: "Failed to update status" });
      }
    });

    app.get('/api/orders/user/:userId', verifyToken, async (req: Request, res: Response) => {
      try {
        const userId = req.params.userId;
        const orders = await ordersCollection.find({ userId }).sort({ createdAt: -1 }).toArray();
        return res.json({ success: true, data: orders });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to fetch orders" });
      }
    });

    app.get('/api/orders/all', async (req: Request, res: Response) => {
      try {
        const { q, deliveryStatus, status, page, limit } = req.query;
        const query: Record<string, any> = {};

        if (q && typeof q === 'string' && q.trim()) {
          const searchRegex = { $regex: q.trim(), $options: 'i' };
          const orConditions: any[] = [
            { customerName: searchRegex },
            { customerEmail: searchRegex },
            { customerPhone: searchRegex },
            { customerAddress: searchRegex },
          ];
          if (ObjectId.isValid(q.trim())) {
            orConditions.push({ _id: new ObjectId(q.trim()) });
          }
          query.$or = orConditions;
        }

        if (deliveryStatus && deliveryStatus !== 'all') {
          if (deliveryStatus === 'active') {
            query.deliveryStatus = { $nin: [/^delivered$/i] };
          } else {
            query.deliveryStatus = { $regex: new RegExp(`^${deliveryStatus}$`, 'i') };
          }
        }

        if (status && status !== 'all') {
          query.status = { $regex: new RegExp(`^${status}$`, 'i') };
        }

        const rawOrders = await ordersCollection.find(query).sort({ createdAt: -1 }).toArray();
        const orders = rawOrders.sort((a: any, b: any) => {
          const aDelivered = (a.deliveryStatus || '').toLowerCase().trim() === 'delivered';
          const bDelivered = (b.deliveryStatus || '').toLowerCase().trim() === 'delivered';
          if (!aDelivered && bDelivered) return -1;
          if (aDelivered && !bDelivered) return 1;
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bTime - aTime;
        });

        const totalOrders = orders.length;
        const totalRevenue = orders.reduce((sum: number, order: any) => sum + (Number(order.totalPrice) || 0), 0);
        const activeOrdersCount = orders.filter((o: any) => (o.deliveryStatus || '').toLowerCase().trim() !== 'delivered').length;
        const deliveredOrdersCount = orders.filter((o: any) => (o.deliveryStatus || '').toLowerCase().trim() === 'delivered').length;

        let finalOrders = orders;
        let pagination = {
          totalItems: totalOrders,
          totalPages: 1,
          currentPage: 1,
          limit: totalOrders,
        };

        if (page || limit) {
          const pageNum = parseInt(page as string) || 1;
          const limitNum = parseInt(limit as string) || 8;
          const skip = (pageNum - 1) * limitNum;
          finalOrders = orders.slice(skip, skip + limitNum);
          pagination = {
            totalItems: totalOrders,
            totalPages: Math.ceil(totalOrders / limitNum) || 1,
            currentPage: pageNum,
            limit: limitNum,
          };
        }

        return res.json({
          success: true,
          data: finalOrders,
          totalOrders,
          totalRevenue,
          activeOrdersCount,
          deliveredOrdersCount,
          pagination,
        });
      } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to fetch all orders" });
      }
    });

    // Get all users (with server-side pagination)
    app.get("/api/users", verifyToken, async (req: Request, res: Response) => {
      try {
        const { q, role, page, limit } = req.query;
        const pageNum = parseInt(page as string) || 1;
        const limitNum = parseInt(limit as string) || 10;
        const skip = (pageNum - 1) * limitNum;

        const query: Record<string, any> = {};
        if (q && typeof q === 'string' && q.trim()) {
          const searchRegex = { $regex: q.trim(), $options: 'i' };
          query.$or = [
            { name: searchRegex },
            { email: searchRegex },
          ];
        }
        if (role && role !== 'all') {
          query.role = { $regex: new RegExp(`^${role}$`, 'i') };
        }

        const users = await usersCollection
          .find(query)
          .skip(skip)
          .limit(limitNum)
          .toArray();

        const totalUsers = await usersCollection.countDocuments(query);
        const totalPages = Math.ceil(totalUsers / limitNum) || 1;

        res.json({
          success: true,
          data: users,
          pagination: {
            totalItems: totalUsers,
            totalPages: totalPages,
            currentPage: pageNum,
            limit: limitNum,
          },
        });
      } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch users" });
      }
    });

    // Add a new pizza
    app.post('/api/pizza/admin/add', verifyToken, async (req: Request, res: Response) => {
      const pizza = req.body;
      const newPizza = await pizzaCollection.insertOne(pizza);
      res.send(newPizza);
    });
    // Get all pizzas
    app.get('/api/pizza/all', async (req: Request, res: Response) => {
      const pizzas = await pizzaCollection.find({}).toArray();
      res.json(pizzas);
    })
    app.get('/api/pizza', async (req: Request, res: Response) => {
      try {
        const { q, category, minPrice, maxPrice } = req.query;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 8;
        const skip = (page - 1) * limit;

        const query: Record<string, any> = {};
        if (q) {
          query.name = { $regex: q as string, $options: 'i' };
        }
        if (category && category !== 'all') {
          query.category = category;
        }

        const priceConditions: Record<string, any> = {};
        if (minPrice && !isNaN(Number(minPrice))) {
          priceConditions.$gte = Number(minPrice);
        }
        if (maxPrice && !isNaN(Number(maxPrice))) {
          priceConditions.$lte = Number(maxPrice);
        }
        if (Object.keys(priceConditions).length > 0) {
          query.price = priceConditions;
        }
        const pizzas = await pizzaCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .toArray();

        const totalPizzas = await pizzaCollection.countDocuments(query);
        const totalPages = Math.ceil(totalPizzas / limit) || 1;

        res.json({
          success: true,
          data: pizzas,
          pagination: {
            totalItems: totalPizzas,
            totalPages: totalPages,
            currentPage: page,
            limit: limit
          }
        });
      } catch (error) {
        res.status(500).json({ success: false, message: "Server error", error });
      }
    });
    // get Most loved pizzas
    app.get('/api/pizza/loved', async (req: Request, res: Response) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 4;

        const skip = (page - 1) * limit;

        const query: Record<string, any> = {};

        const pizzas = await pizzaCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .toArray();

        const totalPizzas = await pizzaCollection.countDocuments(query);
        const totalPages = Math.ceil(totalPizzas / limit);
        res.json({
          success: true,
          data: pizzas,
          pagination: {
            totalItems: totalPizzas,
            totalPages: totalPages,
            currentPage: page,
            limit: limit
          }
        });
      } catch (error) {
        res.status(500).json({ success: false, message: "Server error", error });
      }
    });
    // Get a single pizza
    app.get('/api/pizza/:id', async (req: Request, res: Response) => {
      try {
        const pizzaId = req.params.id as string;
        if (!ObjectId.isValid(pizzaId)) {
          return res.json({
            _id: pizzaId,
            name: pizzaId.startsWith("custom-") ? "Custom Pizza" : "Pizza " + pizzaId.slice(-6),
            category: "Custom Build",
            price: 0,
            imageUrl: ""
          });
        }
        const query: object = { _id: new ObjectId(pizzaId) };
        const pizza = await pizzaCollection.findOne(query);
        if (!pizza) {
          return res.status(404).json({ error: "Pizza not found" });
        }
        return res.json(pizza);
      } catch (error) {
        return res.status(500).json({ error: "Failed to fetch pizza" });
      }
    });
    //  delete pizza
    app.delete('/api/pizza/:id', verifyToken, async (req: Request, res: Response) => {
      const pizzaId = req.params.id as string;
      const query: object = { _id: new ObjectId(pizzaId) };
      const pizza = await pizzaCollection.findOne(query);
      if (!pizza) {
        return res.status(404).json({ error: "Pizza not found" });
      }
      const result = await pizzaCollection.deleteOne(query);
      return res.json({
        success: true,
        message: "Pizza deleted successfully",
        result,
      });
    });
    //  update pizza
    app.patch('/api/pizza/:id', verifyToken, async (req: Request, res: Response) => {
      const pizzaId = req.params.id as string;
      const pizza = req.body;
      const query: object = { _id: new ObjectId(pizzaId) };
      const result = await pizzaCollection.updateOne(query, { $set: pizza });
      return res.json({
        success: true,
        message: "Pizza updated successfully",
        result,
      });
    });

    // add to cart
    app.post('/api/cart/add', verifyToken, async (req: Request, res: Response) => {
      try {
        const cartData = req.body;

        // 1. Safely extract userId from decoded token (fallback to request body if missing)
        const decodedToken = (req as any).userid;
        const userId = decodedToken?.sub || cartData.userId;

        if (!userId) {
          return res.status(400).json({ error: "User ID is required" });
        }

        const incomingItems = cartData.items || []; // [{ pizzaId, size, inches, unitPrice, quantity }]
        const incomingTotalPrice = Number(cartData.totalPrice) || 0;

        // 2. Check if a cart already exists for this user
        const userCartQuery = { userId: userId };
        const existingCart = await cartCollection.findOne(userCartQuery);

        if (existingCart) {
          // Create a map of existing items for efficient duplicate checking
          const currentItemsMap = new Map<string, any>();

          if (Array.isArray(existingCart.items)) {
            existingCart.items.forEach((item: any) => {
              // Use a combination of pizzaId and size as a unique key
              const key = `${item.pizzaId}_${item.size}`;
              currentItemsMap.set(key, item);
            });
          }

          // Merge incoming items with existing items
          incomingItems.forEach((incomingItem: any) => {
            const key = `${incomingItem.pizzaId}_${incomingItem.size}`;
            if (currentItemsMap.has(key)) {
              // If the exact same pizza and size already exists, just update the quantity
              const existingItem = currentItemsMap.get(key);
              existingItem.quantity += incomingItem.quantity;
              existingItem.unitPrice = incomingItem.unitPrice; // Update unit price if necessary
            } else {
              // Add the item to the map if it's completely new
              currentItemsMap.set(key, incomingItem);
            }
          });

          const updatedItems = Array.from(currentItemsMap.values());

          // Recalculate the overall total price
          const updatedTotalPrice = updatedItems.reduce(
            (sum: number, item: any) => sum + item.unitPrice * item.quantity,
            0
          );

          // Update the existing cart document in the database
          const result = await cartCollection.updateOne(
            userCartQuery,
            {
              $set: {
                items: updatedItems,
                totalPrice: updatedTotalPrice,
                updatedAt: new Date()
              }
            }
          );

          return res.json({ success: true, message: "Cart updated successfully", result });
        } else {
          // 3. If no cart exists for the user, insert a brand new cart document
          const newCartDocument = {
            userId: userId,
            items: incomingItems,
            totalPrice: incomingTotalPrice,
            createdAt: new Date(),
            updatedAt: new Date()
          };

          const result = await cartCollection.insertOne(newCartDocument);
          return res.status(201).json({ success: true, message: "Cart created successfully", result });
        }

      } catch (error) {
        console.error("Cart API Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
      }
    });
    // get cart by userId
    app.get('/api/cart/get/:userId', async (req: Request, res: Response) => {
      const userId = req.params.userId;
      const query = { userId: userId };
      const cart = await cartCollection.findOne(query);
      res.json(cart);
    });
    // delete cart by userId and pizzaId
    // delete item from cart by userId, pizzaId, and size
    app.delete('/api/cart/delete/:userId/:pizzaId/:size', verifyToken, async (req: Request, res: Response) => {
      try {
        const { userId, pizzaId, size } = req.params;

        const decodedToken = (req as any).userid;
        const authUserId = decodedToken?.sub || userId;

        if (authUserId !== userId) {
          return res.status(403).json({ error: "Forbidden: You cannot modify other user's cart" });
        }

        const query = { userId: userId };
        const cart = await cartCollection.findOne(query);

        if (!cart) {
          return res.status(404).json({ error: "Cart not found" });
        }
        const initialItemCount = cart.items?.length || 0;
        const updatedItems = (cart.items || []).filter(
          (item: any) => !(item.pizzaId === pizzaId && item.size === size)
        );
        if (updatedItems.length === initialItemCount) {
          return res.status(404).json({ error: "Item not found in cart" });
        }

        const updatedTotalPrice = updatedItems.reduce(
          (sum: number, item: any) => sum + item.unitPrice * item.quantity,
          0
        );


        const result = await cartCollection.updateOne(
          query,
          {
            $set: {
              items: updatedItems,
              totalPrice: updatedTotalPrice,
              updatedAt: new Date()
            }
          }
        );

        return res.json({
          success: true,
          message: "Specific item deleted successfully",
          result,
          totalPrice: updatedTotalPrice
        });

      } catch (error) {
        console.error("Cart Delete API Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
      }
    });
    // clear cart by userId
    app.delete('/api/cart/clear/:userId', verifyToken, async (req: Request, res: Response) => {
      try {
        const { userId } = req.params;
        const decodedToken = (req as any).userid;
        const authUserId = decodedToken?.sub || userId;
        if (authUserId !== userId) {
          return res.status(403).json({ error: "Forbidden: You cannot modify other user's cart" });
        }
        const query = { userId: userId };
        const cart = await cartCollection.findOne(query);
        if (!cart) {
          return res.status(404).json({ error: "Cart not found" });
        }
        const result = await cartCollection.deleteOne(query);
        return res.json({
          success: true,
          message: "Cart deleted successfully",
          result,
        });
      } catch (error) {
        console.error("Cart Delete API Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
      }
    })
    // ==========================================
    // Increase or Decrease Item Quantity in Cart via URL Params
    // ==========================================
    app.patch('/api/cart/update-quantity/:userId/:pizzaId/:size/:action', verifyToken, async (req: Request, res: Response) => {
      try {
        const { userId, pizzaId, size, action } = req.params; // 👈 Taking data from req.params instead of req.body

        // Verify if the authenticated token user matches the requested userId (Security Check)
        const decodedToken = (req as any).userid;
        const authUserId = decodedToken?.sub || userId;

        if (authUserId !== userId) {
          return res.status(403).json({ error: "Forbidden: You cannot modify another user's cart" });
        }

        const query = { userId: userId };
        const cart = await cartCollection.findOne(query);

        if (!cart) {
          return res.status(404).json({ error: "Cart not found" });
        }

        let itemFound = false;

        // Map through current items to update the quantity of the targeted pizza size
        const updatedItems = (cart.items || []).map((item: any) => {
          if (item.pizzaId === pizzaId && item.size === size) {
            itemFound = true;

            if (action === "increase") {
              item.quantity += 1;
            } else if (action === "decrease") {
              // Prevent reducing quantity below 1
              item.quantity = Math.max(1, item.quantity - 1);
            }
          }
          return item;
        });

        if (!itemFound) {
          return res.status(404).json({ error: "Item not found in cart" });
        }

        // Recalculate the overall total price
        const updatedTotalPrice = updatedItems.reduce(
          (sum: number, item: any) => sum + item.unitPrice * item.quantity,
          0
        );

        // Save updated values to the database
        const result = await cartCollection.updateOne(
          query,
          {
            $set: {
              items: updatedItems,
              totalPrice: updatedTotalPrice,
              updatedAt: new Date()
            }
          }
        );

        return res.json({
          success: true,
          message: `Quantity ${action}ed successfully`,
          updatedTotalPrice,
          items: updatedItems
        });

      } catch (error) {
        console.error("Update Quantity API Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
      }
    });

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`PizzaPoint Server listening on port ${port}`);
  });
}

// Export app for Vercel serverless handler
export default app;