import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./config/db";
import productsRouter from "./routes/products";
import authRouter from "./routes/auth";

const app = express();

app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://qualifresh2026.netlify.app"
  ],
  credentials: true
}));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("QualiFresh API is running");
});

app.use("/api/products", productsRouter);
app.use("/api/auth", authRouter);

const PORT = process.env.PORT || 4000;

const start = async () => {
  await connectDB(process.env.MONGO_URI as string);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start();