import "dotenv/config";
import { connectDB } from "../config/db";
import { AdminUser } from "../models/AdminUser";
import { Product } from "../models/Product";
import { seedProducts } from "./products";

const run = async () => {
  await connectDB(process.env.MONGO_URI as string);

  // Seed admin
  const existingAdmin = await AdminUser.findOne({
    email: process.env.ADMIN_EMAIL
  });
  if (!existingAdmin) {
    await AdminUser.create({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD
    });
    console.log("Admin user created");
  } else {
    console.log("Admin user already exists");
  }

  // Seed products (optional: clear first)
  const count = await Product.countDocuments();
  if (count === 0) {
    await Product.insertMany(seedProducts);
    console.log("Products seeded");
  } else {
    console.log("Products already exist, skipping seeding");
  }

  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});