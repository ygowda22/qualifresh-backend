import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { connectDB } from "./config/db";
import productsRouter  from "./routes/products";
import authRouter      from "./routes/auth";
import userAuthRouter  from "./routes/userAuth";
import ordersRouter    from "./routes/orders";
import contactRouter   from "./routes/contact";
import uploadRouter    from "./routes/upload";
import adminUsersRouter from "./routes/adminUsers";

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean)
  .concat(["http://localhost:3000", "https://qualifresh2026.netlify.app", "https://qualifresh-frontend.vercel.app"]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json());

// Serve uploaded images statically
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

app.get("/", (_req, res) => res.send("QualiFresh API is running"));

app.use("/api/products",    productsRouter);
app.use("/api/auth",        authRouter);       // admin auth
app.use("/api/users",       userAuthRouter);   // customer auth
app.use("/api/orders",      ordersRouter);
app.use("/api/contact",     contactRouter);
app.use("/api/upload",      uploadRouter);
app.use("/api/admin/users", adminUsersRouter);

const PORT = process.env.PORT || 4000;

const start = async () => {
  await connectDB(process.env.MONGO_URI as string);
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
};

start();
