import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

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
  res.send("Hello World!");
});

async function run() {
  try {
    const db = client.db("pizzapoint-db");
    const usersCollection = db.collection("user");
    const pizzaCollection = db.collection("pizza");
    const cartCollection = db.collection("cart");

    // Get all users
    app.get("/api/users", async (req: Request, res: Response) => {
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
      const pizzas = await pizzaCollection.find({}).toArray();
      res.json(pizzas);
    });
    // Get a single pizza
    app.get('/api/pizza/:id', async (req: Request, res: Response) => {
      const pizzaId = req.params.id as string;
      const query: object = { _id: new ObjectId(pizzaId) };
      const pizza = await pizzaCollection.findOne(query);
      res.json(pizza);
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

    app.listen(port, () => {
      console.log(`Example app listening on port ${port}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed ❌", error);
    process.exit(1);
  }
}

run().catch(console.dir);