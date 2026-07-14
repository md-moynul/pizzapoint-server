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

const verifyToken = async (req : Request, res : Response, next : Function) => {
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
    req.user = payload;
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
    app.get('/api/pizza',  async (req: Request, res: Response) => {
      const pizzas = await pizzaCollection.find({}).toArray();
      res.json(pizzas);
    });
// Get a single pizza
    app.get('/api/pizza/:id',  async (req: Request, res: Response) => {
      const pizzaId = req.params.id as string;
      const query:object = { _id: new ObjectId(pizzaId) };
      const pizza = await pizzaCollection.findOne(query);
      res.json(pizza);
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