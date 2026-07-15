import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI as string;
const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

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

    const { payload } = await jwtVerify(token, JWKS);
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

async function run() {
  try {
    const db = client.db("pizzapoint-db");
    const usersCollection = db.collection("user");
    const pizzaCollection = db.collection("pizza");
    const cartCollection = db.collection("cart");

    // Get all users
    app.get("/api/users", verifyToken, async (req: Request, res: Response) => {
      const users = await usersCollection.find({}).toArray();
      res.json(users);
    });

    // Add a new pizza
    app.post('/api/pizza/admin/add', verifyToken, async (req: Request, res: Response) => {
      const pizza = req.body;
      const newPizza = await pizzaCollection.insertOne(pizza);
      res.send(newPizza);
    });
    // Get all pizzas
    app.get('/api/pizza', async (req: Request, res: Response) => {
      const { q, category, minPrice, maxPrice } = req.query;

      const query: Record<string, any> = {};
      if (q) {
        query.name = { $regex: q, $options: 'i' };
      }
      if (category) {
        query.category = category;
      }
      if (minPrice) {
        query.price = { $gte: minPrice };
      }
      if (maxPrice) {
        query.price = { $lte: maxPrice };
      }
      const pizzas = await pizzaCollection.find(query).toArray();
      res.json(pizzas);
    });
    // Get a single pizza
    app.get('/api/pizza/:id', async (req: Request, res: Response) => {
      const pizzaId = req.params.id as string;
      const query: object = { _id: new ObjectId(pizzaId) };
      const pizza = await pizzaCollection.findOne(query);
      res.json(pizza);
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

    app.listen(port, () => {
      console.log(`Example app listening on port ${port}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed ❌", error);
    process.exit(1);
  }
}

run().catch(console.dir);